// src/routes/projekte.js — Projektordner Grafe AG
// Unterstützt UNC-Pfade (\\SERVER\Share\...) und lokale/gemappte Pfade (Z:\...)
//
// ─────────────────────────────────────────────────────────────────────────
// WICHTIG — UNC statt Laufwerksbuchstabe (damit Links ÜBERALL im Netz gehen)
// ─────────────────────────────────────────────────────────────────────────
// Problem: Ein Laufwerksbuchstabe wie Z:\ ist pro PC/Benutzer unterschiedlich
//   gemappt (oder in der Werkstatt gar nicht). Ein Pfad "Z:\..." den wir nach
//   Monday schreiben, lässt sich dort auf anderen PCs NICHT öffnen.
// Lösung: Nach aussen (Monday, DB, UI) geben wir IMMER den UNC-Pfad
//   "\\SERVER\Freigabe\..." aus — der funktioniert auf jedem Pom im Netz.
//
// Zwei .env-Varianten:
//   A) EINFACH (empfohlen): NETZLAUFWERK direkt als UNC setzen — dann ist alles
//      automatisch UNC, keine Umrechnung nötig:
//        NETZLAUFWERK=\\SVART239\Grafe\01-Kundenprojekte
//      (Der Node-Dienst muss als Domain-Account mit Zugriff auf den Share laufen.)
//   B) Wenn der Dienst lokal weiter über den Laufwerksbuchstaben schreiben soll,
//      zusätzlich die UNC-Entsprechung angeben — die wird für Monday/DU/UI benutzt:
//        NETZLAUFWERK=Z:\01-Kundenprojekte
//        NETZLAUFWERK_UNC=\\SVART239\Grafe\01-Kundenprojekte
//   Ist NETZLAUFWERK bereits UNC, kann NETZLAUFWERK_UNC weggelassen werden.

const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');
const { query }= require('../db');

// ── Basispfade aus .env ───────────────────────────────────────────────────
function normBase(raw) {
  if (!raw) return null;
  let p = raw.trim();
  if (p.startsWith('//')) p = p.replace(/\//g, '\\');   // //server/share → \\server\share
  return path.normalize(p);
}
function istUNC(p){ return !!p && /^\\\\/.test(p); }

// BASIS = für die tatsächlichen Datei-Operationen (kann Z:\ ODER UNC sein)
const BASIS = normBase(process.env.NETZLAUFWERK) || 'C:\\kalle-server\\projekte-fallback';
// BASIS_UNC = was nach aussen (Monday/DB/UI) gezeigt wird. Immer UNC anstreben.
//   1) explizit gesetzt → nehmen
//   2) sonst: wenn BASIS schon UNC ist → BASIS
//   3) sonst (BASIS ist Z:\ ohne UNC-Angabe) → BASIS (kein Mapping bekannt; wir
//      warnen laut, damit es auffällt)
const BASIS_UNC = normBase(process.env.NETZLAUFWERK_UNC) || (istUNC(BASIS) ? BASIS : BASIS);

const FIRMA_DIR = path.join(BASIS, 'Firmenkunden');
const OBJ_DIR   = path.join(BASIS, 'Objekte');

console.log('[Projekte] Basispfad (lokal):', BASIS);
console.log('[Projekte] Basispfad (UNC/Anzeige):', BASIS_UNC);
if (!istUNC(BASIS_UNC)) {
  console.warn('[Projekte] ⚠ ACHTUNG: Der nach aussen gegebene Pfad ist KEIN UNC-Pfad ('+BASIS_UNC+').');
  console.warn('[Projekte] ⚠ Links in Monday funktionieren dann NUR auf PCs mit gleichem Laufwerks-Mapping.');
  console.warn('[Projekte] ⚠ Bitte NETZLAUFWERK als \\\\Server\\Freigabe\\... setzen ODER NETZLAUFWERK_UNC ergänzen.');
}

// Für Anzeige/Monday/DB: lokalen Pfad → UNC-Pfad umschreiben.
function zurFreigabe(absLokal) {
  if (!absLokal) return absLokal;
  const p = path.normalize(absLokal);
  // Schon UNC? unverändert.
  if (istUNC(p)) return p;
  // Beginnt mit dem lokalen BASIS? Basis gegen UNC tauschen.
  if (p.toLowerCase().startsWith(BASIS.toLowerCase()) && BASIS_UNC && BASIS_UNC.toLowerCase() !== BASIS.toLowerCase()) {
    return path.normalize(BASIS_UNC + p.slice(BASIS.length));
  }
  return p;
}
// Für Datei-Operationen: eingehenden (evtl. UNC-)Pfad → lokalen Pfad zurück.
function zuLokal(absPfad) {
  if (!absPfad) return absPfad;
  const p = path.normalize(absPfad);
  if (BASIS_UNC && p.toLowerCase().startsWith(BASIS_UNC.toLowerCase()) && BASIS_UNC.toLowerCase() !== BASIS.toLowerCase()) {
    return path.normalize(BASIS + p.slice(BASIS_UNC.length));
  }
  return p;
}

// Unterordner pro Projekt
const UNTERORDNER = [
  '01 Korrespondenz',
  '02 Offertphase',
  '03 Ausführung',
  '04 Werkstattdaten',
  '05 Nachträge',
  '06 Fotos',
  '07 Projektabschluss',
];

// Ungültige Windows-Zeichen bereinigen
function sane(s, maxLen = 80) {
  return (s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLen);
}

// Pfad-Sicherheitscheck — akzeptiert lokalen UND UNC-Basispfad
function pfadErlaubt(absZiel) {
  const z = path.normalize(absZiel).toLowerCase();
  const b1 = path.normalize(BASIS).toLowerCase();
  const b2 = path.normalize(BASIS_UNC).toLowerCase();
  return z.startsWith(b1) || z.startsWith(b2);
}

// Ordner case-insensitiv suchen
function findExisting(parentDir, name) {
  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    const lower   = name.toLowerCase();
    const found   = entries.find(e => e.isDirectory() && e.name.toLowerCase() === lower);
    return found ? path.join(parentDir, found.name) : null;
  } catch { return null; }
}

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
  console.log('[Projekte] ✓', p);
  return p;
}

// ── GET /projekte ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const r = await query('SELECT * FROM projekte ORDER BY erstellt_am DESC LIMIT 200');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /projekte/info ────────────────────────────────────────────────────
router.get('/info', (req, res) => {
  res.json({
    basis:      BASIS,
    basis_unc:  BASIS_UNC,
    unc_aktiv:  istUNC(BASIS_UNC),
    firma:      zurFreigabe(FIRMA_DIR),
    objekte:    zurFreigabe(OBJ_DIR),
    zugriffsbar: fs.existsSync(BASIS),
  });
});

// ── POST /projekte ────────────────────────────────────────────────────────
router.post('/', express.json({ limit: '5mb' }), async (req, res) => {
  const {
    typ, firmaName, ort, strasse,
    projektnr, bezeichnung, auftragsnr,
    emailText, offerteJson, offerteHtml,
  } = req.body;

  if (!projektnr || !bezeichnung) {
    return res.status(400).json({ error: 'projektnr und bezeichnung sind Pflichtfelder' });
  }

  const projektOrdnerName = sane(`${projektnr} - ${bezeichnung}`);
  const erstellteOrdner   = [];
  const warnungen         = [];
  let   projektPfad       = '';   // LOKAL (für fs)

  if (!fs.existsSync(BASIS)) {
    return res.status(503).json({
      error: `Basispfad nicht erreichbar: ${BASIS}`,
      hinweis: 'Prüfen Sie ob der Dienst-Account Zugriff auf den Share hat.',
    });
  }

  try {
    if (typ === 'firma') {
      if (!firmaName) return res.status(400).json({ error: 'firmaName fehlt' });
      const firmaClean = sane(firmaName);
      mkDir(FIRMA_DIR);
      const firmaExisting = findExisting(FIRMA_DIR, firmaClean);
      const firmaPfad     = firmaExisting || mkDir(path.join(FIRMA_DIR, firmaClean));
      if (!firmaExisting) erstellteOrdner.push(`Firmenkunden/${firmaClean}`);
      projektPfad = path.join(firmaPfad, projektOrdnerName);
      mkDir(projektPfad);
      erstellteOrdner.push(projektOrdnerName);
    }
    else if (typ === 'objekt') {
      if (!ort || !strasse) return res.status(400).json({ error: 'ort und strasse fehlen' });
      const ortClean     = sane(ort);
      const strasseClean = sane(strasse);
      mkDir(OBJ_DIR);
      const ortExisting     = findExisting(OBJ_DIR, ortClean);
      const ortPfad         = ortExisting || mkDir(path.join(OBJ_DIR, ortClean));
      if (!ortExisting) erstellteOrdner.push(`Objekte/${ortClean}`);
      const strasseExisting = findExisting(ortPfad, strasseClean);
      const strassePfad     = strasseExisting || mkDir(path.join(ortPfad, strasseClean));
      if (!strasseExisting) erstellteOrdner.push(strasseClean);
      projektPfad = path.join(strassePfad, projektOrdnerName);
      mkDir(projektPfad);
      erstellteOrdner.push(projektOrdnerName);
    }
    else {
      return res.status(400).json({ error: 'typ muss "firma" oder "objekt" sein' });
    }

    // Unterordner
    for (const sub of UNTERORDNER) {
      try { mkDir(path.join(projektPfad, sub)); erstellteOrdner.push(sub); }
      catch (e) { warnungen.push(`${sub}: ${e.message}`); }
    }

    // E-Mail / Offerte ablegen (lokal)
    if (emailText?.trim()) {
      const datei = path.join(projektPfad, '01 Korrespondenz', `Anfrage_${auftragsnr || projektnr}.txt`);
      try { fs.writeFileSync(datei, emailText, 'utf-8'); } catch (e) { warnungen.push(`E-Mail: ${e.message}`); }
    }
    if (offerteJson) {
      const datei = path.join(projektPfad, '02 Offertphase', `Offerte_${auftragsnr || projektnr}.json`);
      try { fs.writeFileSync(datei, offerteJson, 'utf-8'); } catch (e) { warnungen.push(`JSON: ${e.message}`); }
    }
    if (offerteHtml) {
      const datei = path.join(projektPfad, '02 Offertphase', `Offerte_${auftragsnr || projektnr}.html`);
      try { fs.writeFileSync(datei, offerteHtml, 'utf-8'); } catch (e) { warnungen.push(`HTML: ${e.message}`); }
    }

    // WICHTIG: nach aussen den UNC-Pfad geben (Monday/DB/UI)
    const pfadFreigabe = zurFreigabe(projektPfad);

    // DB
    let dbId = null;
    try {
      const r = await query(`
        INSERT INTO projekte (projektnr, objektname, ort, strasse, ordnerpfad, auftragsnr, erstellt_am)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (projektnr) DO UPDATE
          SET ordnerpfad=EXCLUDED.ordnerpfad, aktualisiert_am=NOW()
        RETURNING id
      `, [projektnr, bezeichnung,
          typ === 'objekt' ? ort : firmaName,
          typ === 'objekt' ? strasse : null,
          pfadFreigabe, auftragsnr || null]);
      dbId = r.rows[0]?.id;
    } catch (e) { warnungen.push(`DB: ${e.message}`); }

    if (auftragsnr) {
      try { await query('UPDATE offerten SET projekt_pfad=$1 WHERE auftragsnr=$2', [pfadFreigabe, auftragsnr]); }
      catch { /* optional */ }
    }

    // ordnerpfad = UNC (das schreibt die App in Monday)
    return res.json({ ok: true, id: dbId, projektnr, ordnerpfad: pfadFreigabe, ordnerpfad_lokal: projektPfad, erstellteOrdner, warnungen });

  } catch (e) {
    console.error('[Projekte] Fehler:', e);
    return res.status(500).json({ error: e.message, ordnerpfad: zurFreigabe(projektPfad) });
  }
});

// ── GET /projekte/open?pfad=... — Explorer öffnen (auf dem SERVER) ─────────
router.get('/open', (req, res) => {
  const pfad = req.query.pfad;
  if (!pfad) return res.status(400).json({ error: 'pfad fehlt' });
  if (!pfadErlaubt(pfad)) return res.status(403).json({ error: 'Pfad nicht erlaubt' });
  const explorerPfad = zuLokal(path.normalize(pfad));   // fs/Explorer braucht ggf. lokalen Pfad
  exec(`explorer.exe "${explorerPfad}"`, err => { if (err) console.warn('[Projekte] Explorer:', err.message); });
  res.json({ ok: true, pfad: explorerPfad });
});

// ── POST /projekte/ablegen — Offerte in 02 Offertphase ────────────────────
router.post('/ablegen', express.json({ limit: '10mb' }), async (req, res) => {
  const { projektPfad, auftragsnr, html } = req.body;
  if (!projektPfad) return res.status(400).json({ error: 'projektPfad fehlt' });
  if (!html)        return res.status(400).json({ error: 'html fehlt' });
  if (!pfadErlaubt(projektPfad)) return res.status(403).json({ error: 'Pfad nicht erlaubt' });

  const lokal    = zuLokal(projektPfad);                 // fs-Operationen lokal
  const ordner   = path.join(lokal, '02 Offertphase');
  const anrClean = sane(auftragsnr || 'Offerte', 60);
  const dateiname = `Offerte_${anrClean}.html`;
  const zielDatei = path.join(ordner, dateiname);

  try {
    fs.mkdirSync(ordner, { recursive: true });
    fs.writeFileSync(zielDatei, html, 'utf-8');
    console.log(`[Ablegen] ✓ ${dateiname} → ${ordner}`);
    if (auftragsnr) {
      try { await query('UPDATE offerten SET projekt_pfad=$1 WHERE auftragsnr=$2', [zurFreigabe(lokal), auftragsnr]); }
      catch { /* optional */ }
    }
    return res.json({ ok: true, datei: zurFreigabe(zielDatei), dateiname });
  } catch (e) {
    console.error('[Ablegen] Fehler:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /projekte/:projektnr ───────────────────────────────────────────────
router.get('/:projektnr', async (req, res) => {
  try {
    const r = await query('SELECT * FROM projekte WHERE projektnr=$1', [req.params.projektnr]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /projekte/upload — Datei in Projektordner ────────────────────────
router.post('/upload', (req, res, next) => {
  let multer;
  try { multer = require('multer'); }
  catch(e) { return res.status(503).json({ error: 'multer nicht installiert', hinweis: 'npm install multer' }); }

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const projektPfad = zuLokal(req.query?.projektPfad || req.body?.projektPfad || '');
      const zielOrdner  = req.query?.zielOrdner  || req.body?.zielOrdner  || '02 Offertphase';
      if (!projektPfad) return cb(new Error('projektPfad fehlt'));
      const absZiel = path.join(projektPfad, zielOrdner);
      if (!pfadErlaubt(absZiel)) return cb(new Error('Pfad nicht erlaubt'));
      try { fs.mkdirSync(absZiel, { recursive: true }); } catch(e) { return cb(e); }
      cb(null, absZiel);
    },
    filename: (req, file, cb) => {
      const safe = sane(Buffer.from(file.originalname, 'latin1').toString('utf8'), 120);
      cb(null, safe);
    }
  });

  const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }).single('file');
  upload(req, res, (err) => {
    if (err) { console.error('[Upload]', err.message); return res.status(500).json({ ok: false, error: err.message }); }
    if (!req.file) return res.status(400).json({ ok: false, error: 'Keine Datei empfangen' });
    console.log(`[Upload] ✓ ${req.file.filename} → ${req.file.destination}`);
    res.json({ ok: true, filename: req.file.filename, pfad: zurFreigabe(req.file.path), groesse: req.file.size });
  });
});

module.exports = router;
