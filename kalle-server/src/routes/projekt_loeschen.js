// src/routes/projekt_loeschen.js — Projekt/Anfrage vollständig löschen
// Löscht: (1) Monday-Item inkl. Subelemente, (2) Offerte-Datensatz + Positionen + JSON,
//         (3) gibt die Projektnummer wieder frei (wiederverwendbar),
//         (4) optional den Projektordner auf dem Laufwerk.
//
// Mounten in server.js:  app.use('/projekt-loeschen', require('./routes/projekt_loeschen'));
// Voraussetzung .env:    MONDAY_TOKEN=<Monday-API-Token>   (idealerweise Service-Konto)
//                        OFFERTEN_PFAD (optional, wie in offerten.js)
//                        PROJEKTE_BASE (optional, Wurzel der Projektordner — Sicherheitsanker)

const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const fs   = require('fs');
const path = require('path');

const MONDAY_API = 'https://api.monday.com/v2';
const BOARD      = 1012481465;              // GRAFE Produktionsübersicht
const COL_NR     = 'text_mkv7v7m6';         // Projektnummer

async function mondayQuery(query, variables) {
  const token = process.env.MONDAY_TOKEN;
  if (!token) throw new Error('MONDAY_TOKEN nicht gesetzt (.env)');
  const r = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': token, 'API-Version': '2024-01' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// Monday-Item zur Projektnummer finden und löschen (Subelemente gehen automatisch mit).
async function mondayItemLoeschen(nummer) {
  const data = await mondayQuery(
    `query($nr:[String!]!){
       items_page_by_column_values(board_id:${BOARD}, columns:[{column_id:"${COL_NR}", column_values:$nr}], limit:1){
         items{ id }
       }
     }`, { nr: [String(nummer)] });
  const item = data && data.items_page_by_column_values && data.items_page_by_column_values.items[0];
  if (!item) return { geloescht: false, grund: 'kein Monday-Item gefunden' };
  await mondayQuery(`mutation{ delete_item(item_id:${item.id}){ id } }`, {});
  return { geloescht: true, itemId: item.id };
}

// Sicherheits-Check für Ordner-Löschung: nur absolute Pfade, kein Laufwerks-/Systemroot,
// und der Ordnername MUSS die Projektnummer enthalten. Optional zusätzlich unter PROJEKTE_BASE.
function ordnerLoeschErlaubt(pfad, nummer) {
  if (!pfad) return { ok: false, grund: 'kein Pfad' };
  const p = String(pfad).trim();
  if (!path.isAbsolute(p)) return { ok: false, grund: 'kein absoluter Pfad' };
  const norm = path.normalize(p).replace(/[\\/]+$/, '');
  const tiefe = norm.split(/[\\/]+/).filter(Boolean).length;
  if (tiefe < 3) return { ok: false, grund: 'Pfad zu nah an der Wurzel' };
  if (!path.basename(norm).includes(String(nummer))) {
    return { ok: false, grund: 'Ordnername enthält die Projektnummer nicht' };
  }
  const base = process.env.PROJEKTE_BASE;
  if (base) {
    const b = path.normalize(base).replace(/[\\/]+$/, '').toLowerCase();
    if (!norm.toLowerCase().startsWith(b)) return { ok: false, grund: 'Pfad liegt nicht unter PROJEKTE_BASE' };
  }
  return { ok: true, pfad: norm };
}

// POST /  { nummer, pfad?, ordnerLoeschen?, bearbeiter? }
router.post('/', express.json(), async (req, res) => {
  const { nummer, pfad, ordnerLoeschen, bearbeiter } = req.body || {};
  if (!nummer) return res.status(400).json({ ok: false, error: 'nummer fehlt' });
  const result = { ok: true, nummer: String(nummer), monday: null, offerte: null, nummerFrei: false, ordner: null };

  // 1) Monday-Item löschen (best effort — blockiert die restliche Löschung nicht)
  try {
    result.monday = await mondayItemLoeschen(nummer);
  } catch (e) {
    console.error('[Projekt-Löschen] Monday:', e.message);
    result.monday = { geloescht: false, grund: e.message };
  }

  // 2) Offerte-Datensatz + Positionen (CASCADE) + JSON-Ablage entfernen
  try {
    const vorher = await query(
      'SELECT id, auftragsnr FROM offerten WHERE auftragsnr = $1', [String(nummer)]
    );
    for (const off of vorher.rows) {
      await query('DELETE FROM offerten WHERE id = $1', [off.id]);
      const offertPfad = process.env.OFFERTEN_PFAD;
      if (offertPfad && off.auftragsnr) {
        try {
          const safe = off.auftragsnr.replace(/[^a-zA-Z0-9_-]/g, '');
          const f = path.join(offertPfad, safe + '.json');
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch (e) { /* best effort */ }
      }
      try {
        await query(
          "INSERT INTO audit_log (tabelle, datensatz_id, aktion, bearbeiter, vorher) VALUES ('offerten',$1,'geloescht',$2,$3)",
          [off.id, bearbeiter || 'System', JSON.stringify({ auftragsnr: off.auftragsnr })]
        );
      } catch (e) { /* Audit optional */ }
    }
    result.offerte = { geloescht: vorher.rows.length };
  } catch (e) {
    console.error('[Projekt-Löschen] Offerte:', e.message);
    result.offerte = { geloescht: 0, grund: e.message };
  }

  // 3) Projektnummer wieder freigeben (auch wenn sie bereits „vergeben" war → wiederverwendbar)
  try {
    await query(
      `UPDATE nummern SET status='frei', session=NULL, reserved_at=NULL, committed_at=NULL WHERE nummer=$1`,
      [String(nummer)]
    );
    result.nummerFrei = true;
  } catch (e) {
    console.error('[Projekt-Löschen] Nummer freigeben:', e.message);
    result.nummerFrei = false;
    result.nummerFehler = e.message;
  }

  // 4) Optional: Projektordner löschen (mit Sicherheits-Check)
  if (ordnerLoeschen) {
    const chk = ordnerLoeschErlaubt(pfad, nummer);
    if (!chk.ok) {
      result.ordner = { geloescht: false, grund: chk.grund };
    } else {
      try {
        if (fs.existsSync(chk.pfad)) fs.rmSync(chk.pfad, { recursive: true, force: true });
        result.ordner = { geloescht: true, pfad: chk.pfad };
      } catch (e) {
        console.error('[Projekt-Löschen] Ordner:', e.message);
        result.ordner = { geloescht: false, grund: e.message };
      }
    }
  }

  console.log(`[Projekt-Löschen] ${nummer} · monday=${result.monday && result.monday.geloescht} · nummerFrei=${result.nummerFrei} · ordner=${result.ordner && result.ordner.geloescht}`);
  res.json(result);
});

module.exports = router;
