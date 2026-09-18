// src/routes/nachfassen.js
//
// GET /nachfassen/entwurf?id=<Monday-Item-ID>
//
// Baut aus Monday-Daten (+ optional DB-Anreicherung aus der offerten-Tabelle)
// einen spezifischen, kurzen Nachfass-Mailtext per Claude, sucht die passende
// Offerte-PDF im Projektordner als Anhang und legt den Entwurf im
// replyStore ab. Antwort ans Cockpit: { id, grafemailUrl, empfaenger, betreff, text }
// — das Cockpit zeigt die Vorschau und verlinkt "grafemail:<id>".
//
// Voraussetzung: ANTHROPIC_API_KEY + MONDAY_TOKEN in der .env (beide bereits
// vorhanden). DB-Zugriff optional — schlägt die DB-Anreicherung fehl, wird
// nur mit den Monday-Daten weitergemacht statt abzubrechen.

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const replyStore = require('../lib/replyStore');

let query = null;
try { ({ query } = require('../db')); } catch (e) { /* DB optional für diese Route */ }

const MONDAY_API = 'https://api.monday.com/v2';
const MONDAY_VER = '2024-01';
const PROD_BOARD = '1012481465';
const COL = {
  projektnr: 'text_mkv7v7m6',
  kunde: 'text_mm5hbe90',
  email: 'email_mktzse3f',
  datenpfad: 'text_mksqs2p4',
  offert: 'numeric_mm5jnxjf',
};
const SUBCOL_STATUS = 'status';
const SUBCOL_DATUM = 'date0';

async function mondayFetch(gql, variables) {
  const token = process.env.MONDAY_TOKEN;
  if (!token) throw new Error('MONDAY_TOKEN fehlt in .env');
  const r = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': MONDAY_VER },
    body: JSON.stringify({ query: gql, variables: variables || {} }),
  });
  if (!r.ok) throw new Error('Monday HTTP ' + r.status);
  const d = await r.json();
  if (d.errors) throw new Error((d.errors[0] && d.errors[0].message) || 'Monday API Fehler');
  return d.data;
}

function cvGet(cv, id) {
  const c = (cv || []).find((x) => x.id === id);
  return (c && c.text) || '';
}

router.get('/entwurf', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id fehlt' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY fehlt in .env' });

  try {
    const q = `query{ items(ids:[${id}]){
      name
      column_values{ id text column{ title } }
      subitems{ name column_values{ id text column{ title } } }
    } }`;
    const d = await mondayFetch(q);
    const item = (d.items || [])[0];
    if (!item) return res.status(404).json({ error: 'Item nicht gefunden' });

    const cv = item.column_values || [];
    const nr = cvGet(cv, COL.projektnr) || (item.name.match(/^\d+/) || [''])[0];
    const kunde = cvGet(cv, COL.kunde);
    let email = cvGet(cv, COL.email);
    const datenpfad = cvGet(cv, COL.datenpfad);
    const offertsumme = cvGet(cv, COL.offert);

    // Datum "Offerte verschickt" aus dem passenden Subitem (falls vorhanden)
    let offerteDatum = '';
    const offSub = (item.subitems || []).find((s) => /offerte verschickt/i.test(s.name));
    if (offSub) {
      const c = offSub.column_values.find((x) => x.id === SUBCOL_DATUM);
      offerteDatum = (c && c.text) || '';
    }

    // Optionale DB-Anreicherung (Kontaktperson, evtl. genauere E-Mail)
    let kontakt = '';
    if (query && nr) {
      try {
        const r = await query('SELECT kontaktperson, email FROM offerten WHERE auftragsnr=$1 LIMIT 1', [nr]);
        if (r.rows.length) {
          kontakt = r.rows[0].kontaktperson || '';
          if (!email) email = r.rows[0].email || '';
        }
      } catch (e) { /* still fine ohne DB-Daten */ }
    }

    if (!email) return res.status(422).json({ error: 'Keine E-Mail-Adresse für dieses Projekt hinterlegt' });

    const heute = new Date().toLocaleDateString('de-CH');
    const prompt = `Du schreibst für die Grafe AG (Signaletik/Beschriftung, Schweiz) eine kurze, freundliche Nachfass-E-Mail zu einer bereits verschickten Offerte. Schweizer Hochdeutsch (kein „ß"), direkt und knapp (max. 5 Sätze), keine Grussformel am Anfang mit Namen wiederholen wenn unbekannt, KEINE Signatur/Verabschiedung mit Namen am Ende (die persönliche Signatur wird von Outlook automatisch ergänzt) — die Mail endet nach dem letzten inhaltlichen Satz, höchstens noch einer kurzen Grussfloskel wie "Freundliche Grüsse" OHNE Namen danach.

Kunde: ${kunde || 'unbekannt'}
Ansprechperson: ${kontakt || 'unbekannt'}
Projekt/Betreff: ${item.name}
Offerte verschickt am: ${offerteDatum || 'Datum nicht bekannt'}
Offertsumme: ${offertsumme ? 'CHF ' + offertsumme : 'nicht bekannt'}
Heutiges Datum: ${heute}

Antworte NUR mit einem JSON-Objekt, ohne Erklärung, ohne Markdown-Backticks:
{"betreff":"...","text":"..."}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error((errBody.error && errBody.error.message) || resp.statusText);
    }
    const data = await resp.json();
    const raw = (data.content || []).map((b) => b.text || '').join('');
    const json = JSON.parse(raw.replace(/```json?|```/g, '').trim());

    // Offerte-PDF im Projektordner suchen (Namensschema aus PDF-Ablage: Offerte_<Nr>.pdf)
    let anhangPfad = '';
    if (datenpfad) {
      const kandidat = path.join(datenpfad, '02 Offertphase', `Offerte_${nr}.pdf`);
      try { if (fs.existsSync(kandidat)) anhangPfad = kandidat; } catch (e) { /* Netzlaufwerk evtl. nicht erreichbar vom Server aus */ }
    }

    const draftId = replyStore.erstellen({
      empfaenger: email,
      betreff: json.betreff || `Nachfrage zu unserer Offerte — ${item.name}`,
      text: json.text || '',
      anhangPfad,                              // Abwärtskompatibilität: erster/einziger Anhang für einen Helfer, der (noch) nur ein Feld kennt
      anhaenge: anhangPfad ? [anhangPfad] : [], // neu: Liste, für nachträgliches Hinzufügen weiterer Anhänge
      projektId: id,
      projektPfad: datenpfad,
      ablageOrdner: '02 Offertphase',
      subitemName: 'Offerte nachgefasst',
    });

    res.json({
      id: draftId,
      grafemailUrl: 'grafemail:' + draftId,
      empfaenger: email,
      betreff: json.betreff,
      text: json.text,
      anhangGefunden: !!anhangPfad,
    });
  } catch (err) {
    console.error('[Nachfassen]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /nachfassen/:id/anhang  { relPfad, aktion:'hinzufuegen'|'entfernen' }
//
// Neu (Sven, September 2026): ergänzt/entfernt einen Anhang an einem bereits
// erstellten, noch nicht bestätigten Entwurf — z.B. wenn im Cockpit in der
// Liste "Dokumente der Offerte" (siehe GET /projekte/dateien) ein weiteres
// Dokument angehakt wird. relPfad kommt von genau dieser Route und ist
// relativ zum Projektordner (mit "/" getrennt) — wird hier gegen den
// projektPfad DIESES Entwurfs aufgelöst, nicht gegen eine allgemeine
// Projektbasis: ein Entwurf darf nur Dateien aus seinem EIGENEN Projektordner
// anhängen, nie aus einem fremden.
router.post('/:id/anhang', express.json(), (req, res) => {
  const draft = replyStore.holen(req.params.id);
  if (!draft) return res.status(404).json({ ok: false, error: 'Entwurf nicht gefunden oder abgelaufen' });
  if (draft.gesendet) return res.status(409).json({ ok: false, error: 'Entwurf wurde bereits bestätigt — keine Änderung mehr möglich' });
  if (!draft.projektPfad) return res.status(400).json({ ok: false, error: 'Entwurf hat keinen Projektpfad — Anhänge nicht möglich' });

  const relPfad = String((req.body && req.body.relPfad) || '').replace(/\\/g, '/');
  const aktion = (req.body && req.body.aktion) === 'entfernen' ? 'entfernen' : 'hinzufuegen';
  if (!relPfad) return res.status(400).json({ ok: false, error: 'relPfad fehlt' });
  // ".."-Segmente verbieten, bevor überhaupt aufgelöst wird — verhindert,
  // dass relPfad aus dem eigenen Projektordner heraus zeigt.
  if (relPfad.split('/').some((seg) => seg === '..' || seg === '.')) {
    return res.status(400).json({ ok: false, error: 'Ungültiger Pfad' });
  }
  const absPfad = path.join(draft.projektPfad, relPfad.split('/').join(path.sep));
  const normProjekt = path.normalize(draft.projektPfad).toLowerCase();
  const normAbs = path.normalize(absPfad).toLowerCase();
  if (!normAbs.startsWith(normProjekt)) {
    return res.status(403).json({ ok: false, error: 'Pfad liegt ausserhalb des Projektordners dieses Entwurfs' });
  }

  const bisher = Array.isArray(draft.anhaenge) ? draft.anhaenge.slice() : (draft.anhangPfad ? [draft.anhangPfad] : []);
  let neu;
  if (aktion === 'entfernen') {
    neu = bisher.filter((p) => path.normalize(p).toLowerCase() !== normAbs);
  } else {
    if (!fs.existsSync(absPfad)) return res.status(404).json({ ok: false, error: 'Datei existiert nicht (mehr)' });
    neu = bisher.some((p) => path.normalize(p).toLowerCase() === normAbs) ? bisher : bisher.concat([absPfad]);
  }

  const aktualisiert = replyStore.aktualisieren(req.params.id, { anhaenge: neu, anhangPfad: neu[0] || '' });
  if (!aktualisiert) return res.status(409).json({ ok: false, error: 'Entwurf konnte nicht aktualisiert werden (evtl. inzwischen bestätigt)' });
  res.json({ ok: true, anhaenge: neu });
});

module.exports = router;
