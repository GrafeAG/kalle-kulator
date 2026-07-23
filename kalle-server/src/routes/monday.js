// src/routes/monday.js — Dateien an ein (Sub-)Element in monday.com hängen
// Wird von KALLE aufgerufen (POST /monday/attach), damit Datei-Uploads nicht am
// Browser-CORS zu api.monday.com scheitern. Läuft serverseitig über die
// Monday File-API (add_file_to_column). Ein Subelement ist selbst ein Item,
// daher ist item_id = Subelement-ID.
// Voraussetzung: Node 18+ (globales fetch/FormData/Blob).
const express = require('express');
const router  = express.Router();

let multer; try { multer = require('multer'); } catch (e) { /* optional */ }
const upload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }) : null;

// POST /monday/attach   (multipart/form-data)
//   Felder: itemId, columnId, token (oder Header Authorization / .env MONDAY_TOKEN), files[]
router.post('/attach', (req, res) => {
  if (!upload) return res.status(503).json({ ok: false, error: 'multer nicht installiert (npm install multer)' });
  upload.array('files', 30)(req, res, async (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    try {
      const itemId   = (req.body.itemId || '').toString().trim();
      const columnId = (req.body.columnId || '').toString().trim();
      const token    = (req.body.token || req.headers['authorization'] || process.env.MONDAY_TOKEN || '').toString().trim();
      if (!itemId || !columnId) return res.status(400).json({ ok: false, error: 'itemId/columnId fehlt' });
      if (!token)               return res.status(400).json({ ok: false, error: 'Monday-Token fehlt' });
      if (typeof fetch !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
        return res.status(500).json({ ok: false, error: 'Node ohne fetch/FormData — bitte Node 18+ verwenden' });
      }

      const files = req.files || [];
      if (!files.length) return res.json({ ok: true, count: 0, total: 0, msg: 'keine Dateien' });

      let done = 0; const errors = [];
      for (const f of files) {
        try {
          const fd = new FormData();
          fd.append('query',
            `mutation ($file: File!) { add_file_to_column (item_id: ${itemId}, column_id: "${columnId}", file: $file) { id } }`);
          fd.append('variables[file]', new Blob([f.buffer]), f.originalname || 'datei');
          const r = await fetch('https://api.monday.com/v2/file', {
            method: 'POST',
            headers: { Authorization: token },
            body: fd,
          });
          const j = await r.json().catch(() => ({}));
          if (r.ok && !(j && j.errors)) done++;
          else errors.push((f.originalname || '?') + ': ' + ((j.errors && j.errors[0] && j.errors[0].message) || ('HTTP ' + r.status)));
        } catch (e) {
          errors.push((f.originalname || '?') + ': ' + e.message);
        }
      }
      console.log(`[Monday-Attach] ${done}/${files.length} Datei(en) -> Element ${itemId} / Spalte ${columnId}`);
      res.json({ ok: done > 0, count: done, total: files.length, errors, msg: `${done}/${files.length} Datei(en) angehängt` });
    } catch (e) {
      console.error('[Monday-Attach] Fehler:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
});

module.exports = router;
