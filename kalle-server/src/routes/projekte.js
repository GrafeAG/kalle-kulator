// src/routes/projekte.js — Projektordner Grafe AG
// Unterstützt UNC-Pfade (\\SERVER\Share\...) und lokale Pfade
//
// .env Beispiel:
//   NETZLAUFWERK=\\FILESERVER\Grafe\01-Kundenprojekte
//
// WICHTIG Dienst-Account: Der Node.js-Dienst muss als Domain-Account laufen
//   der Schreibrechte auf den UNC-Share hat.
//   In nssm: Application → Log on → Domain-Account eintragen
//   (LOCAL SYSTEM hat keinen Netzwerkzugriff auf UNC-Shares)

const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');
const { query }= require('../db');
const { htmlToPdf } = require('../pdf');

// ── Basispfad aus .env ────────────────────────────────────────────────────
// Normalisiert UNC-Pfade: \\Server\Share oder \\\\Server\\Share → beides OK
function normBase(raw) {
  if (!raw) return null;
  // In .env werden Backslashes oft als \\ geschrieben
  // Erlaubte Formate: \\server\share\... oder //server/share/...
  let p = raw.trim();
  // Wenn als //... angegeben → in \\ umwandeln
  if (p.startsWith('//')) p = p.replace(/\//g, '\\');
  // path.normalize stellt sicher dass UNC \\\\ korrekt bleibt
  return path.normalize(p);
}

const BASIS     = normBase(process.env.NETZLAUFWERK) || 'C:\\kalle-server\\projekte-fallback';
const FIRMA_DIR = path.join(BASIS, 'Firmenkunden');
const OBJ_DIR   = path.join(BASIS, 'Objekte');

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

console.log('[Projekte] Basispfad:', BASIS);

// Ungültige Windows-Zeichen bereinigen
function sane(s, maxLen = 80) {
  return (s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLen);
}

// Pfad-Sicherheitscheck — UNC-kompatibel
// normalisiert beide Pfade vor dem Vergleich
function pfadErlaubt(absZiel) {
  const z = path.normalize(absZiel).toLowerCase();
  const b = path.normalize(BASIS).toLowerCase();
  return z.startsWith(b);
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

// Ordner erstellen inkl. Log
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

// ── GET /projekte/info — Basispfad-Info für KALLE-UI ─────────────────────
router.get('/info', (req, res) => {
  res.json({
    basis:   BASIS,
    firma:   FIRMA_DIR,
    objekte: OBJ_DIR,
    zugriffsbar: fs.existsSync(BASIS),
  });
});

// ── POST /projekte ────────────────────────────────────────────────────────
router.post('/', express.json({ limit: '5mb' }), async (req, res) => {
  const {
    typ,          // 'firma' | 'objekt'
    firmaName,
    ort, strasse,
    projektnr, bezeichnung, auftragsnr,
    emailText, offerteJson, offerteHtml,
  } = req.body;

  if (!projektnr || !bezeichnung) {
    return res.status(400).json({ error: 'projektnr und bezeichnung sind Pflichtfelder' });
  }

  const projektOrdnerName = sane(`${projektnr} - ${bezeichnung}`);
  const erstellteOrdner   = [];
  const warnungen         = [];
  let   projektPfad       = '';

  // Prüfen ob Basis erreichbar ist
  if (!fs.existsSync(BASIS)) {
    return res.status(503).json({
      error: `Basispfad nicht erreichbar: ${BASIS}`,
      hinweis: 'Prüfen Sie ob der Dienst-Account Zugriff auf den UNC-Share hat.',
    });
  }

  try {
    // ── SCHEMA 1: Firmenkunde ─────────────────────────────────────────────
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

    // ── SCHEMA 2: Objekt ──────────────────────────────────────────────────
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

    // ── Unterordner ───────────────────────────────────────────────────────
    for (const sub of UNTERORDNER) {
      try { mkDir(path.join(projektPfad, sub)); erstellteOrdner.push(sub); }
      catch (e) { warnungen.push(`${sub}: ${e.message}`); }
    }

    // ── E-Mail in 01 Korrespondenz ────────────────────────────────────────
    if (emailText?.trim()) {
      const datei = path.join(projektPfad, '01 Korrespondenz', `Anfrage_${auftragsnr || projektnr}.txt`);
      try { fs.writeFileSync(datei, emailText, 'utf-8'); }
      catch (e) { warnungen.push(`E-Mail: ${e.message}`); }
    }

    // ── Offerte in 02 Offertphase ─────────────────────────────────────────
    if (offerteJson) {
      const datei = path.join(projektPfad, '02 Offertphase', `Offerte_${auftragsnr || projektnr}.json`);
      try { fs.writeFileSync(datei, offerteJson, 'utf-8'); }
      catch (e) { warnungen.push(`JSON: ${e.message}`); }
    }
    if (offerteHtml) {
      const datei = path.join(projektPfad, '02 Offertphase', `Offerte_${auftragsnr || projektnr}.html`);
      try { fs.writeFileSync(datei, offerteHtml, 'utf-8'); }
      catch (e) { warnungen.push(`HTML: ${e.message}`); }
    }

    // ── DB ────────────────────────────────────────────────────────────────
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
          projektPfad, auftragsnr || null]);
      dbId = r.rows[0]?.id;
    } catch (e) { warnungen.push(`DB: ${e.message}`); }

    if (auftragsnr) {
      try { await query('UPDATE offerten SET projekt_pfad=$1 WHERE auftragsnr=$2', [projektPfad, auftragsnr]); }
      catch { /* optional */ }
    }

    return res.json({ ok: true, id: dbId, projektnr, ordnerpfad: projektPfad, erstellteOrdner, warnungen });

  } catch (e) {
    console.error('[Projekte] Fehler:', e);
    return res.status(500).json({ error: e.message, ordnerpfad: projektPfad });
  }
});

// ── GET /projekte/open?pfad=... — Explorer öffnen ─────────────────────────
// Funktioniert mit UNC-Pfaden: explorer.exe "\\server\share\pfad"
router.get('/open', (req, res) => {
  const pfad = req.query.pfad;
  if (!pfad) return res.status(400).json({ error: 'pfad fehlt' });

  // Sicherheit: nur erlaubte Basispfade
  if (!pfadErlaubt(pfad)) {
    return res.status(403).json({ error: 'Pfad nicht erlaubt' });
  }

  // UNC-Pfad für explorer.exe: Backslashes sicherstellen
  const explorerPfad = path.normalize(pfad);
  exec(`explorer.exe "${explorerPfad}"`, err => {
    if (err) console.warn('[Projekte] Explorer:', err.message);
  });
  res.json({ ok: true, pfad: explorerPfad });
});

// ── POST /projekte/ablegen — fertige Offerte in 02 Offertphase speichern ──
// Body: { projektPfad, auftragsnr, html }
// Rendert die (druckfertige) Offerten-HTML serverseitig zu PDF und legt
// Offerte_KAxxxxxx.pdf in 02 Offertphase ab (keine HTML mehr).
// Kann mehrfach aufgerufen werden — überschreibt bestehende Datei.
router.post('/ablegen', express.json({ limit: '10mb' }), async (req, res) => {
  const { projektPfad, auftragsnr, html } = req.body;

  if (!projektPfad) return res.status(400).json({ error: 'projektPfad fehlt' });
  if (!html)        return res.status(400).json({ error: 'html fehlt' });

  // Sicherheitscheck
  if (!pfadErlaubt(projektPfad)) {
    return res.status(403).json({ error: 'Pfad nicht erlaubt' });
  }

  const ordner = path.join(projektPfad, '02 Offertphase');
  const anrClean = sane(auftragsnr || 'Offerte', 60);
  const dateiname = `Offerte_${anrClean}.pdf`;
  const zielDatei = path.join(ordner, dateiname);

  try {
    // HTML → PDF rendern (A4, Print-CSS der Offerte wird respektiert)
    let pdfBuffer;
    try {
      pdfBuffer = await htmlToPdf(html);
    } catch (e) {
      if (/Cannot find module 'puppeteer'/.test(e.message)) {
        console.error('[Ablegen] Puppeteer fehlt:', e.message);
        return res.status(503).json({ ok: false,
          error: 'PDF-Engine nicht installiert',
          hinweis: 'Im Ordner kalle-server ausführen: npm install puppeteer' });
      }
      throw e; // anderer Renderfehler → unten behandelt
    }

    fs.mkdirSync(ordner, { recursive: true });
    fs.writeFileSync(zielDatei, pdfBuffer);
    console.log(`[Ablegen] ✓ ${dateiname} (${(pdfBuffer.length/1024).toFixed(0)} KB) → ${ordner}`);

    // Offerte in DB verknüpfen
    if (auftragsnr) {
      try {
        await query('UPDATE offerten SET projekt_pfad=$1 WHERE auftragsnr=$2',
          [projektPfad, auftragsnr]);
      } catch { /* optional */ }
    }

    return res.json({ ok: true, datei: zielDatei, dateiname });
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

// ── POST /projekte/upload — Datei in Projektordner ablegen ────────────────
router.post('/upload', (req, res, next) => {
  let multer;
  try { multer = require('multer'); }
  catch(e) { return res.status(503).json({ error: 'multer nicht installiert', hinweis: 'npm install multer' }); }

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      // WICHTIG: projektPfad + zielOrdner aus URL-Query lesen (multer liest body erst nach File-Stream)
      const projektPfad = req.query?.projektPfad || req.body?.projektPfad || '';
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
    res.json({ ok: true, filename: req.file.filename, pfad: req.file.path, groesse: req.file.size });
  });
});

module.exports = router;
