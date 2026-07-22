// src/monday-attach.js — Offerte-PDF automatisch an das Monday-Item hängen (File-Spalte)
// Wird von /projekte/ablegen aufgerufen, nachdem die Offerte-PDF geschrieben wurde.
// Voraussetzung: Node 18+ (globales fetch/FormData/Blob). .env: MONDAY_TOKEN gesetzt.
const fs = require('fs');

const MONDAY_FILE_API = 'https://api.monday.com/v2/file';
const FILE_COLUMN     = process.env.MONDAY_FILE_COLUMN || 'file_mm5gtbhz'; // Spalte „Offerte PDF"
const API_VERSION     = process.env.MONDAY_API_VERSION || '2024-01';

/**
 * Hängt eine PDF an die Datei-Spalte eines Monday-Items.
 * @param {string|number} itemId   Monday-Item-ID (aus KALLE mitgeschickt)
 * @param {string} pdfPath         absoluter Pfad zur erzeugten PDF
 * @param {string} [filename]      Anzeigename in Monday
 * @returns {Promise<{ok:boolean, fileId?:string, msg?:string}>}
 */
async function attachPdfToMonday(itemId, pdfPath, filename) {
  const token = process.env.MONDAY_TOKEN;
  if (!token)                  return { ok:false, msg:'MONDAY_TOKEN nicht gesetzt (.env)' };
  if (!itemId)                 return { ok:false, msg:'keine mondayItemId übergeben' };
  if (!pdfPath || !fs.existsSync(pdfPath)) return { ok:false, msg:'PDF nicht gefunden: '+pdfPath };
  if (typeof fetch !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
    return { ok:false, msg:'Node 18+ nötig (fetch/FormData/Blob) — sonst Paket "form-data" + "node-fetch" verwenden' };
  }

  const query = `mutation add_file($file: File!) { add_file_to_column(item_id: ${itemId}, column_id: "${FILE_COLUMN}", file: $file) { id } }`;
  const form = new FormData();
  form.append('query', query);
  form.append('map', JSON.stringify({ image: ['variables.file'] }));
  const buf = fs.readFileSync(pdfPath);
  form.append('image', new Blob([buf], { type: 'application/pdf' }), filename || 'Offerte.pdf');

  try {
    const r = await fetch(MONDAY_FILE_API, {
      method: 'POST',
      headers: { 'Authorization': token, 'API-Version': API_VERSION },
      body: form,
    });
    const d = await r.json();
    if (d && d.data && d.data.add_file_to_column) return { ok:true, fileId: d.data.add_file_to_column.id };
    return { ok:false, msg: (d && d.errors && d.errors[0] && d.errors[0].message) || 'unbekannter Fehler' };
  } catch (e) {
    return { ok:false, msg: e.message };
  }
}

module.exports = { attachPdfToMonday };
