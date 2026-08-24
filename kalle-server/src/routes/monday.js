// src/routes/monday.js — Monday-Hilfsrouten
// -----------------------------------------------------------------------------
// POST /monday/attach  — Dateien an ein Monday-Item/Subelement (File-Spalte) hängen
//
// Die KALLE-App schickt hierher ein multipart/form-data mit:
//   itemId    = Ziel-Item/Subelement-ID (z. B. Subelement "Anfrage eingegangen")
//   columnId  = ID der File-Spalte am Subelement
//   token     = Monday-API-Token (optional; sonst wird MONDAY_TOKEN aus .env genommen)
//   files     = eine oder mehrere Dateien (Feldname "files")
//
// Diese Route lädt jede Datei über die Monday-File-Schnittstelle
// (https://api.monday.com/v2/file, Mutation add_file_to_column) hoch.
//
// WARUM diese Route nötig ist: Der direkte Datei-Upload aus dem Browser scheitert
// an CORS. Deshalb leitet die App die Dateien über den Server, der sie an Monday
// weiterreicht. Fehlte die Route bisher, kam im Browser
// "JSON.parse: unexpected character at line 1 column 1" (der Server lieferte die
// index.html statt JSON).
//
// Voraussetzungen: Node 18+ (globales fetch/FormData/Blob) und multer (bereits
// als Dependency vorhanden). In server.js einbinden:  app.use('/monday', require('./routes/monday'));

const express = require('express');
const router  = express.Router();

const MONDAY_FILE_API = 'https://api.monday.com/v2/file';

let multer = null;
try { multer = require('multer'); } catch (e) { /* unten behandelt */ }

// Eine einzelne Datei an eine File-Spalte hängen.
async function uploadOne(token, itemId, columnId, file) {
  // item_id inline (Zahl), column_id als String — Datei kommt über die Variable $file.
  const q = `mutation add_file($file: File!) { add_file_to_column (item_id: ${Number(itemId)}, column_id: ${JSON.stringify(String(columnId))}, file: $file) { id } }`;

  const form = new FormData();
  form.append('query', q);
  const blob = new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' });
  // Monday erwartet die Datei unter dem Feld variables[file]
  form.append('variables[file]', blob, file.originalname || 'datei');

  const r = await fetch(MONDAY_FILE_API, {
    method: 'POST',
    headers: { 'Authorization': token },   // KEIN Content-Type setzen — fetch setzt multipart-boundary selbst
    body: form,
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* kein JSON */ }
  if (!r.ok || !j) throw new Error('Monday HTTP ' + r.status + ': ' + text.slice(0, 200));
  if (j.errors)   throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data && j.data.add_file_to_column && j.data.add_file_to_column.id;
}

router.post('/attach', (req, res) => {
  if (!multer) return res.status(503).json({ ok: false, error: 'multer nicht installiert (npm i multer)' });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024, files: 25 },
  }).array('files', 25);

  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    try {
      const itemId   = req.body.itemId;
      const columnId = req.body.columnId;
      const token    = (req.body.token && String(req.body.token).trim()) || process.env.MONDAY_TOKEN;
      const files    = req.files || [];

      if (!itemId)        return res.status(400).json({ ok: false, error: 'itemId fehlt' });
      if (!columnId)      return res.status(400).json({ ok: false, error: 'columnId fehlt' });
      if (!token)         return res.status(400).json({ ok: false, error: 'Monday-Token fehlt (Feld token oder .env MONDAY_TOKEN)' });
      if (!files.length)  return res.status(400).json({ ok: false, error: 'keine Dateien' });

      const ids = [];
      const fehler = [];
      // Sequentiell, um Monday-Rate-Limits nicht zu reizen.
      for (const f of files) {
        try { ids.push(await uploadOne(token, itemId, columnId, f)); }
        catch (e) { fehler.push((f.originalname || '?') + ': ' + e.message); }
      }

      const ok = ids.length > 0 && fehler.length === 0;
      const msg = ids.length + ' Datei(en) angehängt' + (fehler.length ? (' · ' + fehler.length + ' Fehler') : '');
      console.log('[Monday/attach] Item ' + itemId + ' · ' + msg);
      // Immer HTTP 200 mit JSON — die App wertet d.ok/d.msg aus.
      return res.json({ ok, count: ids.length, ids, msg, fehler });
    } catch (e) {
      console.error('[Monday/attach] Fehler:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
});

module.exports = router;
