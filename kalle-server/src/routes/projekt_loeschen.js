// src/routes/projekt_loeschen.js — Projekt vollständig löschen
// -----------------------------------------------------------------------------
// POST /projekt-loeschen  { nummer, pfad?, ordnerLoeschen?, bearbeiter? }
//
// Führt aus:
//   1. Monday: Item(s) mit dieser Projektnummer (Spalte text_mkv7v7m6, Board 1012481465)
//      finden und löschen (Subelemente gehen automatisch mit).
//   2. DB: Offerte (+ Positionen via CASCADE) und Projektzeile löschen, Audit-Eintrag.
//   3. Nummer freigeben: nummern.status = 'frei' (auch eine bereits "vergebene" wird wieder frei).
//   4. Ordner (nur bei ordnerLoeschen=true): Projektordner löschen — mehrfach abgesichert.
//
// Antwort (die App wertet genau diese Felder aus):
//   { ok, monday:{geloescht,grund?}, offerte:{geloescht,grund?}, nummerFrei, ordner:{geloescht,grund?} }
//
// Mount in server.js:  app.use('/projekt-loeschen', require('./routes/projekt_loeschen'));
// Voraussetzung: MONDAY_TOKEN in der .env (für die Monday-Löschung).

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { query } = require('../db');

const MONDAY_API = 'https://api.monday.com/v2';
const BOARD      = 1012481465;          // GRAFE Produktionsübersicht
const COL_NR     = 'text_mkv7v7m6';     // Projektnummer-Spalte

// ── Basispfade (für die optionale Ordner-Löschung) — analog projekte.js ────
function normBase(raw){ if(!raw) return null; let p=String(raw).trim(); if(p.startsWith('//')) p=p.replace(/\//g,'\\'); return path.normalize(p); }
function istUNC(p){ return !!p && /^\\\\/.test(p); }
const BASIS     = normBase(process.env.NETZLAUFWERK) || 'C:\\kalle-server\\projekte-fallback';
const BASIS_UNC = normBase(process.env.NETZLAUFWERK_UNC) || BASIS;
// Eingehenden (evtl. UNC-)Pfad → lokalen Pfad für fs-Operationen.
function zuLokal(p){
  if(!p) return p;
  const n = path.normalize(p);
  if(BASIS_UNC && n.toLowerCase().startsWith(BASIS_UNC.toLowerCase()) && BASIS_UNC.toLowerCase() !== BASIS.toLowerCase())
    return path.normalize(BASIS + n.slice(BASIS_UNC.length));
  return n;
}
function unterBasis(p){
  const n = path.normalize(p).toLowerCase();
  return n.startsWith(path.normalize(BASIS).toLowerCase()) || n.startsWith(path.normalize(BASIS_UNC).toLowerCase());
}

// ── Monday ─────────────────────────────────────────────────────────────────
async function gql(q){
  const token = process.env.MONDAY_TOKEN;
  if(!token) throw new Error('MONDAY_TOKEN fehlt (.env)');
  const r = await fetch(MONDAY_API, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':token, 'API-Version':'2024-01' },
    body: JSON.stringify({ query:q }),
  });
  const j = await r.json();
  if(j.errors) throw new Error(JSON.stringify(j.errors).slice(0,300));
  return j.data;
}

async function mondayLoeschen(nummer){
  try{
    const nrLit = JSON.stringify(String(nummer));   // sauber escapte Zeichenkette
    const d = await gql(`query{ items_page_by_column_values(board_id:${BOARD}, columns:[{column_id:"${COL_NR}", column_values:[${nrLit}]}], limit:50){ items{ id name } } }`);
    const items = (d && d.items_page_by_column_values && d.items_page_by_column_values.items) || [];
    if(!items.length) return { geloescht:false, grund:'kein Monday-Item mit Nummer '+nummer };
    for(const it of items){ await gql(`mutation{ delete_item(item_id:${it.id}){ id } }`); }
    return { geloescht:true, anzahl:items.length };
  }catch(e){ return { geloescht:false, grund:e.message }; }
}

// ── Route ────────────────────────────────────────────────────────────────
router.post('/', express.json({ limit:'1mb' }), async (req, res) => {
  const { nummer, pfad, ordnerLoeschen, bearbeiter } = req.body || {};
  const nr = String(nummer||'').trim();
  if(!nr) return res.status(400).json({ ok:false, error:'nummer fehlt' });

  const out = { ok:true, monday:{geloescht:false}, offerte:{geloescht:false}, nummerFrei:false, ordner:{geloescht:false} };

  // 1) Monday-Item(s) löschen
  out.monday = await mondayLoeschen(nr);

  // 2) DB: Offerte (+ Positionen CASCADE) + Projektzeile + Audit
  try{
    const r = await query('DELETE FROM offerten WHERE auftragsnr=$1', [nr]);
    out.offerte.geloescht = r.rowCount > 0;
  }catch(e){ out.offerte.grund = e.message; }
  try{ await query('DELETE FROM projekte WHERE projektnr=$1', [nr]); }catch(e){ /* optional */ }
  try{
    await query("INSERT INTO audit_log (tabelle, aktion, bearbeiter, nachher) VALUES ('offerten','geloescht',$1,$2)",
      [ (bearbeiter||'System'), JSON.stringify({ nummer:nr }) ]);
  }catch(e){ /* Audit optional */ }

  // 3) Nummer freigeben (auch eine bereits vergebene Nummer → wieder im Pool)
  try{
    const r = await query(
      `UPDATE nummern SET status='frei', session=NULL, reserved_at=NULL, committed_at=NULL WHERE nummer=$1`,
      [nr]
    );
    out.nummerFrei = r.rowCount > 0;
  }catch(e){ /* nummern-Tabelle evtl. nicht vorhanden */ }

  // 4) Ordner (optional, mehrfach abgesichert)
  if(ordnerLoeschen && pfad){
    try{
      const ziel = zuLokal(String(pfad).trim().replace(/[\\/]+$/,''));   // trailing Slash entfernen
      const norm = path.normalize(ziel);
      const enthaeltNr = norm.toLowerCase().includes(nr.toLowerCase());
      const tiefGenug  = ((norm.match(/[\\/]/g)||[]).length >= 4) && (norm.length > path.normalize(BASIS).length + 4);
      const richtigerBaum = unterBasis(norm) && (/[\\/]Firmenkunden[\\/]/i.test(norm) || /[\\/]Objekte[\\/]/i.test(norm));
      if(!richtigerBaum)      out.ordner = { geloescht:false, grund:'Pfad nicht unter der Projektbasis (Firmenkunden|Objekte) — Sicherheitsabbruch' };
      else if(!enthaeltNr)    out.ordner = { geloescht:false, grund:'Ordnername enthält die Projektnummer nicht — Sicherheitsabbruch' };
      else if(!tiefGenug)     out.ordner = { geloescht:false, grund:'Pfad zu nah an der Wurzel — Sicherheitsabbruch' };
      else if(!fs.existsSync(norm)) out.ordner = { geloescht:false, grund:'Ordner existiert nicht (evtl. schon gelöscht)' };
      else { fs.rmSync(norm, { recursive:true, force:true }); out.ordner = { geloescht:true }; console.log('[Projekt-Löschen] Ordner gelöscht:', norm); }
    }catch(e){ out.ordner = { geloescht:false, grund:e.message }; }
  }

  console.log(`[Projekt-Löschen] ${nr} · Monday:${out.monday.geloescht} · Offerte:${out.offerte.geloescht} · NummerFrei:${out.nummerFrei} · Ordner:${out.ordner.geloescht}`);
  res.json(out);
});

module.exports = router;
