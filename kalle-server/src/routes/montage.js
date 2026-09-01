// src/routes/montage.js — Montage-Rückmeldung: KI-Zerlegung → Monday-Subelemente + SharePoint-Fotos
// ─────────────────────────────────────────────────────────────────────────
// Hintergrund: Das Microsoft-Forms-Formular "Montage-Rückmeldung" wurde auf ein
// einziges grosses Freitextfeld umgestellt (Diktierfunktion des Handys statt
// starrer Kategorie-Auswahl). Ein Monteur kann damit mehrere Punkte in einer
// Meldung mischen ("Steckdose fehlt an Position 27, ausserdem Putzschaden bei...").
// Diese Route zerlegt den Text per Claude in einzelne, benannte Punkte und legt
// je Punkt ein eigenes Subelement in Monday an (Board 1012481470, unter dem
// jeweiligen Projekt-Hauptitem) — damit ist jeder Punkt einzeln verfolgbar
// (Status, Zuweisung), statt in einem Kommentar unterzugehen.
//
// Route:
//   POST /montage/melden?nr=<Projektnummer>
//   Zwei Eingabewege:
//     A) application/json (empfohlen, z.B. Power Automate):
//        { monteur, beschreibung, fotos:[{name, contentBase64}] }
//     B) multipart/form-data (Fallback): Felder monteur, beschreibung, files
//   → { ok:true, punkte:[{typ,titel,subitemId}], fotosHochgeladen, sharePointOrdner, zusammenfassungGepostet }
//
// Ablauf:
//   1. Haupt-Item über Projektnummer finden (Board 1012481465, Spalte text_mkv7v7m6)
//   2. Freitext per Claude (Haiku) in Punkte zerlegen: [{typ,titel,beschreibung}]
//      typ ist einer von: Fertig, Nachtrag, Problem, Info
//   3. Je Punkt: create_subitem auf dem Haupt-Item, Status gesetzt je nach Typ
//      (Fertig→"Fertig", Nachtrag/Problem→"Nacharbeit nötig", Info→kein Status)
//   4. Fotos: nach SharePoint in den Unterordner "04 Fotos" hochladen (per
//      cloud.js-Bausteinen, kein Code-Doppel) — Monday bekommt nur den Link
//      (Text in der Zusammenfassung), nicht die Binärdatei selbst.
//   5. Kurze Sammel-Zusammenfassung als Kommentar am Haupt-Item posten.
//
// Fehlt ein Baustein (ANTHROPIC_API_KEY, MONDAY_TOKEN, Projekt nicht gefunden),
// bricht die Route mit klarer Fehlermeldung ab statt stillschweigend halbfertig
// zu posten.
// ─────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();

const MONDAY_API = 'https://api.monday.com/v2';
const BOARD_HAUPT = 1012481465;        // GRAFE Produktionsübersicht
const COL_PROJEKTNR = 'text_mkv7v7m6';
const STATUS_COLUMN_ID = 'status';     // Subitem-Board 1012481470

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

let multer = null;
try { multer = require('multer'); } catch (e) { /* unten behandelt */ }

let cloudInternal = null;
try { cloudInternal = require('./cloud')._internal; } catch (e) { /* unten behandelt */ }

// ── Monday GraphQL Helper ───────────────────────────────────────────────
async function gql(query, variables) {
  const token = process.env.MONDAY_TOKEN;
  if (!token) throw new Error('MONDAY_TOKEN fehlt (.env)');
  const r = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-01' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

async function findeHauptItem(nr) {
  const d = await gql(
    `query($nr:[String!]!){ items_page_by_column_values(board_id:${BOARD_HAUPT}, columns:[{column_id:"${COL_PROJEKTNR}", column_values:$nr}], limit:1){ items{ id name } } }`,
    { nr: [String(nr)] }
  );
  const items = (d && d.items_page_by_column_values && d.items_page_by_column_values.items) || [];
  return items[0] || null;
}

// ── Claude: Freitext in einzelne Punkte zerlegen ───────────────────────────
function buildPrompt(text) {
  return `Ein Monteur eines Schweizer Werbetechnik-Unternehmens hat folgende Rückmeldung von einer Baustelle diktiert oder getippt (per Handy, oft in einem Rutsch, manchmal mehrere Themen gemischt).

Zerlege den Text in einzelne, in sich abgeschlossene Punkte. Jeder Punkt braucht:
- typ: genau einer von "Fertig", "Nachtrag", "Problem", "Info"
  - "Fertig" = etwas wurde wie geplant erledigt, keine weitere Aktion nötig
  - "Nachtrag" = zusätzliche Arbeit/Material wird gebraucht, die nicht im ursprünglichen Auftrag war
  - "Problem" = etwas verhindert die Ausführung oder ist defekt/beschädigt
  - "Info" = reine Information ohne Handlungsbedarf (z.B. Kundenkontakt, Zeitangabe)
- titel: kurzer, prägnanter Titel (max. 60 Zeichen), OHNE den Typ nochmal zu nennen
- beschreibung: der vollständige relevante Inhalt zu diesem Punkt, leicht geglättet (Tippfehler/Diktier-Artefakte bereinigt), aber inhaltlich unverändert — nichts dazuerfinden

Enthält der Text nur einen Gedanken, gib genau ein Element zurück. Trenne nur dort, wo tatsächlich unterschiedliche Themen vorliegen — nicht künstlich zerstückeln.

Antworte NUR mit einem JSON-Array, ohne Erklärung, ohne Markdown-Backticks:
[{"typ":"...","titel":"...","beschreibung":"..."}]

Rückmeldung:
${text}`;
}

async function zerlegeInPunkte(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY nicht gesetzt (.env)');

  const r = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, messages: [{ role: 'user', content: buildPrompt(text) }] }),
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || ('Anthropic HTTP ' + r.status);
    throw new Error(msg);
  }
  const raw = (data.content || []).map(b => b.text || '').join('');
  let punkte;
  try { punkte = JSON.parse(raw.replace(/```json?|```/g, '').trim()); }
  catch (e) { throw new Error('KI-Antwort nicht als JSON lesbar: ' + raw.slice(0, 200)); }

  if (!Array.isArray(punkte) || !punkte.length) throw new Error('KI hat keine Punkte erkannt');
  const gueltigeTypen = new Set(['Fertig', 'Nachtrag', 'Problem', 'Info']);
  return punkte
    .filter(p => p && p.titel)
    .map(p => ({
      typ: gueltigeTypen.has(p.typ) ? p.typ : 'Info',
      titel: String(p.titel).slice(0, 80),
      beschreibung: String(p.beschreibung || '').slice(0, 2000),
    }));
}

function statusFuerTyp(typ) {
  if (typ === 'Fertig') return 'Fertig';
  if (typ === 'Nachtrag' || typ === 'Problem') return 'Nacharbeit nötig';
  return null; // "Info" — kein Status-Wechsel
}

// ── Subelement anlegen (mit Status, falls zutreffend) ──────────────────────
async function legeSubelementAn(parentItemId, punkt) {
  const name = `[${punkt.typ}] ${punkt.titel}`;
  const status = statusFuerTyp(punkt.typ);
  const columnValues = status ? JSON.stringify({ [STATUS_COLUMN_ID]: { label: status } }) : '{}';

  const d = await gql(
    `mutation($name:String!,$cv:JSON!){ create_subitem(parent_item_id:${parentItemId}, item_name:$name, column_values:$cv){ id } }`,
    { name, cv: columnValues }
  );
  const subitemId = d && d.create_subitem && d.create_subitem.id;
  if (!subitemId) throw new Error('Subelement konnte nicht angelegt werden');

  // Beschreibung als Kommentar am Subelement, damit der volle Text sichtbar ist
  // (der Item-Name allein ist ja nur der kurze Titel).
  if (punkt.beschreibung) {
    await gql(
      `mutation($body:String!){ create_update(item_id:${subitemId}, body:$body){ id } }`,
      { body: punkt.beschreibung }
    );
  }
  return subitemId;
}

// ── Kernlogik, unabhängig davon ob Fotos per multipart oder Base64/JSON kamen ──
// fotos = [{ buffer:Buffer, name:string }]
async function verarbeiteRueckmeldung({ nr, monteur, beschreibung, fotos }) {
  if (!nr) throw Object.assign(new Error('nr (Projektnummer) fehlt'), { status: 400 });
  if (!beschreibung) throw Object.assign(new Error('beschreibung fehlt'), { status: 400 });

  // 1) Haupt-Item finden
  const hauptItem = await findeHauptItem(nr);
  if (!hauptItem) throw Object.assign(new Error('Projekt mit dieser Nummer nicht gefunden'), { status: 404 });

  // 2) KI-Zerlegung
  const punkteRoh = await zerlegeInPunkte(beschreibung);

  // 3) Je Punkt ein Subelement
  const punkte = [];
  for (const p of punkteRoh) {
    try {
      const subitemId = await legeSubelementAn(hauptItem.id, p);
      punkte.push({ typ: p.typ, titel: p.titel, subitemId });
    } catch (e) {
      console.error('[montage/melden] Subelement fehlgeschlagen:', e.message);
      punkte.push({ typ: p.typ, titel: p.titel, fehler: e.message });
    }
  }

  // 4) Fotos nach SharePoint (04 Fotos) — best-effort, blockiert den Rest nicht
  let sharePointOrdner = null, fotosHochgeladen = 0, fotoFehler = null;
  if (fotos.length && cloudInternal) {
    try {
      const leaf = await cloudInternal.projektZuLeaf(nr);
      if (leaf) {
        const { driveId, item, subfolders } = await cloudInternal.ordnerSicherstellen([leaf]);
        const zielOrdner = (subfolders && subfolders['04 Fotos']) || item;
        sharePointOrdner = item.webUrl;
        const token = await cloudInternal.getGraphToken();
        for (const f of fotos) {
          try {
            const dateiname = cloudInternal.saneSP(f.name || 'foto.jpg');
            const uploadUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${zielOrdner.id}:/${encodeURIComponent(dateiname)}:/content`;
            const r = await fetch(uploadUrl, {
              method: 'PUT',
              headers: { Authorization: 'Bearer ' + token, 'Content-Type': f.mimetype || 'application/octet-stream' },
              body: f.buffer,
            });
            if (r.ok) fotosHochgeladen++;
          } catch (e) { /* einzelnes Foto überspringen, Rest weiterlaufen lassen */ }
        }
      }
    } catch (e) { fotoFehler = e.message; console.error('[montage/melden] SharePoint-Foto-Sync:', e.message); }
  } else if (fotos.length && !cloudInternal) {
    fotoFehler = 'cloud.js-Bausteine nicht verfügbar — Fotos nicht hochgeladen';
  }

  // 5) Zusammenfassung am Haupt-Item posten
  const zeilen = punkte.map(p => `• [${p.typ}] ${p.titel}` + (p.fehler ? ` (⚠ nicht angelegt: ${p.fehler})` : ''));
  let zusammenfassung = `📋 Montage-Rückmeldung${monteur ? ' von ' + monteur : ''} — ${punkte.length} Punkt(e) erfasst:\n${zeilen.join('\n')}`;
  if (fotos.length) zusammenfassung += `\n\n📷 ${fotosHochgeladen}/${fotos.length} Foto(s) nach SharePoint hochgeladen` + (sharePointOrdner ? `: ${sharePointOrdner}` : '') + (fotoFehler ? ` (⚠ ${fotoFehler})` : '');

  let zusammenfassungGepostet = false;
  try {
    await gql(`mutation($body:String!){ create_update(item_id:${hauptItem.id}, body:$body){ id } }`, { body: zusammenfassung });
    zusammenfassungGepostet = true;
  } catch (e) { console.error('[montage/melden] Zusammenfassung-Post fehlgeschlagen:', e.message); }

  console.log(`[montage/melden] Projekt ${nr} · ${punkte.length} Punkt(e) · ${fotosHochgeladen} Foto(s)`);
  return { ok: true, punkte, fotosHochgeladen, sharePointOrdner, zusammenfassungGepostet };
}

// ── Route ────────────────────────────────────────────────────────────────
// Zwei Eingabewege, je nach Content-Type:
//
//  A) application/json  (EMPFOHLEN — z.B. Power Automate):
//     { monteur, beschreibung, fotos: [{ name, contentBase64 }] }
//     Base64 direkt aus einer OneDrive-"Get file content"-Aktion — kein
//     multipart-Body nötig, in Power Automate deutlich einfacher zu bauen.
//
//  B) multipart/form-data  (Fallback, z.B. direkter Formular-Post):
//     Felder monteur, beschreibung (Text) + files (0..n Dateien)
router.post('/montage/melden', (req, res, next) => {
  const ct = (req.headers['content-type'] || '');
  if (ct.includes('application/json')) return next(); // → JSON-Handler unten
  return multipartHandler(req, res);
});

function multipartHandler(req, res) {
  if (!multer) return res.status(503).json({ ok: false, error: 'multer nicht installiert (npm i multer)' });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 10 } }).array('files', 10);

  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    try {
      const nr = String((req.query && req.query.nr) || (req.body && req.body.nr) || '').trim();
      const monteur = String((req.body && req.body.monteur) || '').trim();
      const beschreibung = String((req.body && req.body.beschreibung) || '').trim();
      const fotos = (req.files || []).map(f => ({ buffer: f.buffer, name: f.originalname, mimetype: f.mimetype }));
      const result = await verarbeiteRueckmeldung({ nr, monteur, beschreibung, fotos });
      return res.json(result);
    } catch (e) {
      console.error('[montage/melden] Fehler:', e.message);
      return res.status(e.status || 500).json({ ok: false, error: e.message });
    }
  });
}

router.post('/montage/melden', express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const nr = String((req.query && req.query.nr) || (req.body && req.body.nr) || '').trim();
    const monteur = String((req.body && req.body.monteur) || '').trim();
    const beschreibung = String((req.body && req.body.beschreibung) || '').trim();
    const fotosIn = Array.isArray(req.body && req.body.fotos) ? req.body.fotos : [];
    const fotos = fotosIn
      .filter(f => f && f.contentBase64)
      .map(f => ({ buffer: Buffer.from(f.contentBase64, 'base64'), name: f.name || 'foto.jpg', mimetype: f.mimetype }));
    const result = await verarbeiteRueckmeldung({ nr, monteur, beschreibung, fotos });
    return res.json(result);
  } catch (e) {
    console.error('[montage/melden] Fehler:', e.message);
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
