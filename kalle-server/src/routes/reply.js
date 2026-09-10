// src/routes/reply.js
//
// Zwei Endpunkte:
//   GET  /reply/:id            — vom lokalen grafemail:-Helfer aufgerufen, liefert
//                                 den Mail-Entwurf (Empfänger/Betreff/Text/Anhang) als JSON.
//   POST /reply/:id/gesendet   — vom Cockpit aufgerufen, NACHDEM der Nutzer die Mail in
//                                 Outlook manuell abgeschickt hat (wir können das Senden
//                                 selbst nicht erkennen — der Helfer sendet bewusst nie
//                                 automatisch). Legt bei Bedarf ein Monday-Subelement an
//                                 und archiviert eine Textkopie im Projektordner.
//
// Der Entwurf selbst wird an anderer Stelle erzeugt (aktuell: nachfassen.js) und über
// replyStore.erstellen() abgelegt — diese Route kennt nur "abholen" und "bestätigen".

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const replyStore = require('../lib/replyStore');

const MONDAY_API = 'https://api.monday.com/v2';
const MONDAY_VER = '2024-01';
const PROD_SUBBOARD = '1012481470';
const SUB_COL_DATUM = 'date0';

async function mondayFetch(query, variables) {
  const token = process.env.MONDAY_TOKEN;
  if (!token) throw new Error('MONDAY_TOKEN fehlt in .env');
  const r = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': MONDAY_VER },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  if (!r.ok) throw new Error('Monday HTTP ' + r.status);
  const d = await r.json();
  if (d.errors) throw new Error((d.errors[0] && d.errors[0].message) || 'Monday API Fehler');
  return d.data;
}

// Sehr einfache Pfad-Absicherung: nur innerhalb des bekannten Netzlaufwerks schreiben.
// Falls kalle-server bereits eine ausführlichere pfadErlaubt()/zurFreigabe()-Logik hat
// (siehe projekte.js), diese hier stattdessen importieren statt zu duplizieren.
function pfadErlaubtEinfach(p) {
  const basis = process.env.NETZLAUFWERK || '';
  if (!basis) return true; // kein Basis-Pfad konfiguriert → keine Einschränkung möglich
  const norm = String(p || '').replace(/\//g, '\\').toLowerCase();
  return norm.startsWith(String(basis).replace(/\//g, '\\').toLowerCase());
}

router.get('/:id', (req, res) => {
  replyStore.aufraeumen();
  const draft = replyStore.holen(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Entwurf nicht gefunden oder abgelaufen' });
  res.json({
    empfaenger: draft.empfaenger,
    betreff: draft.betreff,
    text: draft.text,
    anhangPfad: draft.anhangPfad || '',
  });
});

router.post('/:id/gesendet', async (req, res) => {
  const draft = replyStore.holen(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Entwurf nicht gefunden oder abgelaufen' });

  const ergebnis = { subitem: false, archiv: false };

  // 1) Monday-Subelement anlegen (z. B. "Offerte nachgefasst")
  if (draft.projektId && draft.subitemName) {
    try {
      const scv = {};
      scv[SUB_COL_DATUM] = { date: new Date().toISOString().slice(0, 10) };
      await mondayFetch(
        `mutation($nm:String!,$cv:JSON!){ create_subitem(parent_item_id:${draft.projektId}, item_name:$nm, column_values:$cv){ id } }`,
        { nm: draft.subitemName, cv: JSON.stringify(scv) }
      );
      ergebnis.subitem = true;
    } catch (e) {
      console.error('[Reply/gesendet] Subelement-Fehler:', e.message);
      ergebnis.subitemError = e.message;
    }
  }

  // 2) Kopie im Projektordner ablegen — Hinweis: das ist die ABGESCHICKTE
  // TEXTVORLAGE, kein Live-Abzug der tatsächlich in Outlook gesendeten Mail
  // (Nutzer kann den Text vor dem Senden noch verändert haben). Für eine
  // 1:1-Kopie der wirklich gesendeten Mail müsste der lokale Helfer das
  // MailItem-Ereignis abfangen — bewusst nicht in dieser ersten Version.
  if (draft.projektPfad) {
    try {
      const zielOrdner = path.join(draft.projektPfad, draft.ablageOrdner || '02 Offertphase');
      if (!pfadErlaubtEinfach(zielOrdner)) throw new Error('Pfad nicht erlaubt');
      fs.mkdirSync(zielOrdner, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
      const datei = path.join(zielOrdner, `Nachfassen_${stamp}.txt`);
      const inhalt = `An: ${draft.empfaenger}\nBetreff: ${draft.betreff}\nDatum: ${new Date().toLocaleString('de-CH')}\n\n${draft.text}\n`;
      fs.writeFileSync(datei, inhalt, 'utf-8');
      ergebnis.archiv = true;
      ergebnis.archivDatei = datei;
    } catch (e) {
      console.error('[Reply/gesendet] Archiv-Fehler:', e.message);
      ergebnis.archivError = e.message;
    }
  }

  replyStore.alsGesendetMarkieren(req.params.id);
  res.json({ ok: true, ...ergebnis });
});

module.exports = router;
