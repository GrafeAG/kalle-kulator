// src/routes/cloud.js
// ─────────────────────────────────────────────────────────────────────────
// SharePoint-Ordneranlage über Microsoft Graph (App-only, Client Credentials).
// Nutzt die produktiv eingerichtete Entra-App "REACTOR-Server":
//   Sites.Selected (Anwendung) + Site-Grant "write" auf Site "Grafe Projekte".
//
// Benötigte .env-Variablen (bereits vorhanden bzw. gemäss Infrastruktur-Übergabe
// vom 2026-08-28 zu ergänzen):
//   GRAPH_TENANT_ID=...
//   GRAPH_CLIENT_ID=...
//   GRAPH_CLIENT_SECRET=...      (niemals loggen, niemals an den Browser senden)
//   SP_HOSTNAME=artexgroupch.sharepoint.com
//   SP_SITE=/sites/GrafeProjekte
//   CLOUD_ROOT=01_Projekte
//   NETZLAUFWERK_UNC=\\stgag002.artexgroup.local\grafeag\01-Kundenprojekte   (bereits vorhanden — wird
//                                                                             für die Pfad-Sicherheitsprüfung
//                                                                             der optionalen .url-Verknüpfung genutzt)
//
// Route:
//   POST /cloud/ordner
//   Body: { segmente: ["Firmenkunden","<Firma>","<Nr - Betreff>"], projektnr?: "266351", unicPfad?: "\\\\...\\..." }
//   → legt CLOUD_ROOT/<segmente...> idempotent an (bereits vorhandene Ordner
//     werden übersprungen, keine Duplikate) und gibt bei Erfolg
//     { ok:true, id, name, webUrl, linkGeschrieben?, linkFehler? } zurück.
//   → Wird "unicPfad" mitgeschickt (lokaler UNC-Projektordner), legt der Server dort
//     zusätzlich eine Verknüpfung "SharePoint-Ordner.url" ab, die direkt in den
//     SharePoint-Ordner springt. Nur innerhalb des konfigurierten Netzlaufwerks erlaubt.
//
//   GET /cloud/ordner/fuer-projekt?nr=<Projektnummer>
//   → findet/legt den SharePoint-Ordner zu einer Projektnummer an (Name aus der
//     offerten-Tabelle: "<auftragsnr> - <bemerkung>", gleiches Schema wie lokal).
//     Für externe Systeme (z.B. Power Automate), die nur die Projektnummer kennen.
//     Antwort: { ok:true, driveId, itemId, name, webUrl }
//
//   POST /cloud/foto?nr=<Projektnummer>   (multipart/form-data, Feld "files")
//   → lädt Foto(s) direkt in den SharePoint-Projektordner hoch (Graph Simple
//     Upload, max. 4 MB/Datei). Für die Monteur-Rückmeldung (Power Automate):
//     dort die Foto-Bytes einfach an diese Route weiterreichen, statt selbst
//     Graph-Zugangsdaten zu verwalten. Antwort: { ok, ordnerUrl, ergebnisse:[...] }
//
// Wichtig (siehe Infrastruktur-Übergabe Punkt 14):
//   - Site/Drive/Root werden dynamisch über Graph aufgelöst, NICHT hardcodiert.
//   - Keine Secrets in Logs oder API-Antworten.
//   - Kein Files.ReadWrite.All nötig — nur Sites.Selected + Site-Grant.
//   - Idempotent: mehrfacher Aufruf mit denselben Segmenten erzeugt keine Duplikate.
// ─────────────────────────────────────────────────────────────────────────

const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const router = express.Router();
const { query } = require('../db');

let multer = null;
try { multer = require('multer'); } catch (e) { /* unten behandelt — Route /cloud/foto dann inaktiv */ }

const GRAPH = 'https://graph.microsoft.com/v1.0';

// ── In-Memory-Caches (pro laufendem Prozess) ───────────────────────────────
let _tokenCache = { token: null, exp: 0 };
let _siteCache = { id: null, ts: 0 };
let _driveCache = { id: null, ts: 0 };
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 Stunde — Site/Drive ändern sich praktisch nie

// ── SharePoint-taugliche Ordnernamen ────────────────────────────────────────
// Verbotene Zeichen laut SharePoint: " * : < > ? / \ | # % ~ (und führende/
// abschliessende Punkte/Leerzeichen sind ebenfalls problematisch).
function saneSP(s) {
  return String(s || '')
    .replace(/["*:<>?\/\\|#%~\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 100) || '_';
}

function encPath(p) {
  return p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

// ── Optionale Verknüpfung im lokalen UNC-Projektordner ─────────────────────
// Legt "SharePoint-Ordner.url" im übergebenen UNC-Pfad ab, damit man aus dem
// lokalen Projektordner direkt in den zugehörigen SharePoint-Ordner springen
// kann. Sicherheitsprüfung: der Zielpfad muss innerhalb des konfigurierten
// Netzlaufwerks liegen (NETZLAUFWERK_UNC/NETZLAUFWERK aus .env) — verhindert,
// dass über den Request-Body ein beliebiger Pfad auf dem Server beschrieben wird.
function unicPfadErlaubt(unicPfad) {
  const base = (process.env.NETZLAUFWERK_UNC || process.env.NETZLAUFWERK || '').trim();
  if (!base || !unicPfad) return false;
  const normBase = path.win32.normalize(base).toLowerCase().replace(/\\+$/, '');
  const normTarget = path.win32.normalize(String(unicPfad)).toLowerCase().replace(/\\+$/, '');
  return normTarget === normBase || normTarget.startsWith(normBase + '\\');
}

async function schreibeSharePointLink(unicPfad, webUrl) {
  if (!unicPfadErlaubt(unicPfad)) {
    return { ok: false, error: 'Zielpfad ausserhalb des konfigurierten Netzlaufwerks — Verknüpfung nicht geschrieben.' };
  }
  try {
    const zielDatei = path.win32.join(unicPfad, 'SharePoint-Ordner.url');
    // Internet-Shortcut-Format — funktioniert unter Windows per Doppelklick, öffnet im Standardbrowser.
    const inhalt = `[InternetShortcut]\r\nURL=${webUrl}\r\n`;
    await fs.writeFile(zielDatei, inhalt, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Schritt 1: App-only Access Token (Client Credentials) ──────────────────
async function getGraphToken() {
  const now = Date.now();
  if (_tokenCache.token && _tokenCache.exp > now + 60000) return _tokenCache.token;

  const tenant = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) {
    throw new Error('GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET fehlen in .env');
  }

  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Graph-Token fehlgeschlagen (HTTP ${r.status}): ${t.slice(0, 200)}`);
  }
  const d = await r.json();
  _tokenCache = { token: d.access_token, exp: now + (d.expires_in || 3600) * 1000 };
  return _tokenCache.token;
}

async function graphFetch(graphPath, token, opts) {
  opts = opts || {};
  const r = await fetch(GRAPH + graphPath, {
    method: opts.method || 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + token }, opts.body ? { 'Content-Type': 'application/json' } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  return r;
}

// ── Schritt 2+3: Site und Standard-Drive dynamisch auflösen (mit Cache) ────
async function resolveSiteId(token) {
  const now = Date.now();
  if (_siteCache.id && now - _siteCache.ts < CACHE_TTL_MS) return _siteCache.id;

  const hostname = process.env.SP_HOSTNAME;
  const sitePath = process.env.SP_SITE;
  if (!hostname || !sitePath) throw new Error('SP_HOSTNAME/SP_SITE fehlen in .env');

  const r = await graphFetch(`/sites/${hostname}:${sitePath}`, token);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Site-Auflösung fehlgeschlagen (HTTP ${r.status}): ${t.slice(0, 200)}`);
  }
  const d = await r.json();
  _siteCache = { id: d.id, ts: now };
  return d.id;
}

async function resolveDriveId(siteId, token) {
  const now = Date.now();
  if (_driveCache.id && now - _driveCache.ts < CACHE_TTL_MS) return _driveCache.id;

  const r = await graphFetch(`/sites/${siteId}/drive`, token);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Standard-Bibliothek nicht auflösbar (HTTP ${r.status}): ${t.slice(0, 200)}`);
  }
  const d = await r.json();
  _driveCache = { id: d.id, ts: now };
  return d.id;
}

// ── Schritt 4: Ordnerpfad idempotent anlegen (Segment für Segment) ─────────
// Legt jedes fehlende Segment einzeln an; bereits vorhandene werden übersprungen.
// Gibt am Ende das letzte (tiefste) Ordner-Item zurück.
async function ensureFolderPath(driveId, segments, token) {
  let cumulative = '';
  let lastItem = null;

  for (const rawSeg of segments) {
    const seg = saneSP(rawSeg);
    const parentPath = cumulative;
    cumulative = cumulative ? cumulative + '/' + seg : seg;

    // Existenz prüfen
    const getUrl = `/drives/${driveId}/root:/${encPath(cumulative)}:`;
    let r = await graphFetch(getUrl, token);
    if (r.status === 200) {
      lastItem = await r.json();
      continue; // existiert schon — weiter zum nächsten Segment
    }
    if (r.status !== 404) {
      const t = await r.text().catch(() => '');
      throw new Error(`Prüfung von "${cumulative}" fehlgeschlagen (HTTP ${r.status}): ${t.slice(0, 200)}`);
    }

    // Nicht vorhanden → anlegen (unter dem Elternordner bzw. root)
    const createUrl = parentPath
      ? `/drives/${driveId}/root:/${encPath(parentPath)}:/children`
      : `/drives/${driveId}/root/children`;
    r = await graphFetch(createUrl, token, {
      method: 'POST',
      body: { name: seg, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }
    });
    if (r.status === 409) {
      // Race Condition — zwischen Prüfung und Anlage von anderswo erstellt. Erneut lesen.
      r = await graphFetch(getUrl, token);
      if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Ordner "${cumulative}" nach Konflikt nicht lesbar (HTTP ${r.status}): ${t.slice(0, 200)}`); }
      lastItem = await r.json();
      continue;
    }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`Anlage von "${cumulative}" fehlgeschlagen (HTTP ${r.status}): ${t.slice(0, 200)}`);
    }
    lastItem = await r.json();
  }
  return lastItem;
}

// ── Gemeinsame Logik: Ordner unter CLOUD_ROOT idempotent sicherstellen ─────
// segmenteOhneRoot = z.B. ["266351 - Rebranding DKZ Zürich AG"] — CLOUD_ROOT wird
// hier automatisch vorangestellt, NICHT nochmal selbst mitgeben.
async function ordnerSicherstellen(segmenteOhneRoot) {
  const token = await getGraphToken();
  const siteId = await resolveSiteId(token);
  const driveId = await resolveDriveId(siteId, token);
  const cloudRoot = process.env.CLOUD_ROOT || '01_Projekte';
  const segments = [cloudRoot, ...segmenteOhneRoot];
  const item = await ensureFolderPath(driveId, segments, token);
  if (!item) throw new Error('Ordner konnte nicht ermittelt werden (unerwarteter Zustand).');
  return { driveId, item };
}

// Projektnummer → Projektordner-Name, EXAKT nach demselben Schema wie die lokale
// UNC-Ablage in projekte.js ("<Projektnummer> - <Bezeichnung>"), damit derselbe
// Ordner gefunden wird, egal ob er beim Erfassen (Checkbox) oder erst hier bei
// Bedarf (z.B. erster Foto-Upload eines "kleinen Auftrags" ohne Checkbox) entsteht.
async function projektZuLeaf(nr) {
  const r = await query('SELECT auftragsnr, bemerkung FROM offerten WHERE auftragsnr=$1', [String(nr).trim()]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return `${row.auftragsnr}${row.bemerkung ? ' - ' + row.bemerkung : ''}`.trim();
}

// ── Route: SharePoint-Ordner anlegen (aus dem Reaktor, mit expliziten Segmenten) ──
router.post('/cloud/ordner', async (req, res) => {
  try {
    const segmenteIn = Array.isArray(req.body && req.body.segmente) ? req.body.segmente : null;
    if (!segmenteIn || !segmenteIn.length) {
      return res.status(400).json({ ok: false, error: 'Feld "segmente" (Array, mind. 1 Eintrag) fehlt oder ist leer.' });
    }
    if (segmenteIn.length > 8) {
      return res.status(400).json({ ok: false, error: 'Zu viele Segmente (max. 8).' });
    }

    const cloudRoot = process.env.CLOUD_ROOT || '01_Projekte';
    const segmenteOhneRoot = segmenteIn.map(s => String(s || '').trim()).filter(Boolean);
    if (!segmenteOhneRoot.length) {
      return res.status(400).json({ ok: false, error: 'Segmente enthalten nach Bereinigung keinen gültigen Namen.' });
    }

    const { item } = await ordnerSicherstellen(segmenteOhneRoot);

    const antwort = { ok: true, id: item.id, name: item.name, webUrl: item.webUrl };

    // Optional: Verknüpfung im lokalen UNC-Projektordner ablegen (best-effort —
    // ein Fehlschlag hier ändert nichts daran, dass der SharePoint-Ordner erfolgreich angelegt wurde).
    const unicPfad = req.body && req.body.unicPfad;
    if (unicPfad) {
      const linkResult = await schreibeSharePointLink(unicPfad, item.webUrl);
      antwort.linkGeschrieben = linkResult.ok;
      if (!linkResult.ok) antwort.linkFehler = linkResult.error;
    }

    return res.json(antwort);
  } catch (e) {
    // Fehler technisch protokollieren, aber niemals Secrets ausgeben.
    console.error('[cloud/ordner] Fehler:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Route: SharePoint-Ordner zu einer Projektnummer finden/anlegen ─────────
// GET /cloud/ordner/fuer-projekt?nr=266351
// Für Power Automate & Co: kennt nur die Projektnummer, braucht aber driveId+itemId
// für den direkten Graph-Datei-Upload. Legt den Ordner bei Bedarf auch neu an
// (z.B. wenn beim Erfassen die SharePoint-Checkbox aus war, aber jetzt doch ein
// Foto hochgeladen werden soll — ein Foto braucht so oder so ein Ziel).
router.get('/cloud/ordner/fuer-projekt', async (req, res) => {
  try {
    const nr = String(req.query.nr || '').trim();
    if (!nr) return res.status(400).json({ ok: false, error: 'nr (Projektnummer) fehlt' });

    const leaf = await projektZuLeaf(nr);
    if (!leaf) return res.status(404).json({ ok: false, error: 'Projekt mit dieser Nummer nicht gefunden' });

    const { driveId, item } = await ordnerSicherstellen([leaf]);
    return res.json({ ok: true, driveId, itemId: item.id, name: item.name, webUrl: item.webUrl });
  } catch (e) {
    console.error('[cloud/ordner/fuer-projekt] Fehler:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Route: Foto(s) direkt in den SharePoint-Projektordner hochladen ────────
// POST /cloud/foto?nr=266351   (multipart/form-data, Feld "files", 1..n Dateien)
// Für die Monteur-Rückmeldung (Power Automate): lädt die Foto-Bytes serverseitig
// per Graph "Simple Upload" hoch (bis 4 MB je Datei — Grenze der Simple-Upload-API;
// grössere Dateien bräuchten eine Upload-Session, aktuell nicht implementiert,
// da Formular-Fotos i.d.R. deutlich kleiner sind). Der Graph-Client-Secret bleibt
// dabei komplett auf dem Server — Power Automate schickt nur die rohen Foto-Bytes.
router.post('/cloud/foto', (req, res) => {
  if (!multer) return res.status(503).json({ ok: false, error: 'multer nicht installiert (npm i multer)' });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4 * 1024 * 1024, files: 10 }, // 4 MB = Grenze der Graph-Simple-Upload-API
  }).array('files', 10);

  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message + (err.code === 'LIMIT_FILE_SIZE' ? ' (max. 4 MB je Foto)' : '') });
    try {
      const nr = String((req.query && req.query.nr) || (req.body && req.body.nr) || '').trim();
      if (!nr) return res.status(400).json({ ok: false, error: 'nr (Projektnummer) fehlt' });
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ ok: false, error: 'keine Dateien (Feld "files")' });

      const leaf = await projektZuLeaf(nr);
      if (!leaf) return res.status(404).json({ ok: false, error: 'Projekt mit dieser Nummer nicht gefunden' });

      const { driveId, item } = await ordnerSicherstellen([leaf]);
      const token = await getGraphToken();

      const ergebnisse = [];
      // Sequentiell hochladen, um Graph-Rate-Limits nicht zu reizen (analog monday.js).
      for (const f of files) {
        try {
          const dateiname = saneSP(f.originalname || 'foto.jpg');
          const uploadUrl = `/drives/${driveId}/items/${item.id}:/${encodeURIComponent(dateiname)}:/content`;
          const r = await fetch(GRAPH + uploadUrl, {
            method: 'PUT',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': f.mimetype || 'application/octet-stream' },
            body: f.buffer,
          });
          if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`HTTP ${r.status}: ${t.slice(0, 150)}`); }
          const d = await r.json();
          ergebnisse.push({ ok: true, name: d.name, webUrl: d.webUrl });
        } catch (e) {
          ergebnisse.push({ ok: false, name: f.originalname, error: e.message });
        }
      }

      const ok = ergebnisse.some(x => x.ok);
      console.log(`[cloud/foto] Projekt ${nr} · ${ergebnisse.filter(x => x.ok).length}/${files.length} Foto(s) hochgeladen`);
      return res.json({ ok, ordnerUrl: item.webUrl, ergebnisse });
    } catch (e) {
      console.error('[cloud/foto] Fehler:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
});

module.exports = router;
// (server.js liegt bereits fertig angepasst bei den Chat-Outputs — die Route ist
//  dort schon eingebunden, keine manuelle Anpassung mehr nötig.)
