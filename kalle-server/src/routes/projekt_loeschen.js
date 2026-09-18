// src/routes/projekt_loeschen.js — Projekt vollständig löschen
// -----------------------------------------------------------------------------
// POST /projekt-loeschen  { nummer, pfad?, ordnerLoeschen?, bearbeiter? }
//
// Führt aus:
//   1. Monday: Item(s) mit dieser Projektnummer (Spalte text_mkv7v7m6, Board 1012481465)
//      finden und löschen (Subelemente gehen automatisch mit).
//   2. DB: Offerte (+ Positionen via CASCADE) und Projektzeile löschen, Audit-Eintrag,
//      alles in EINER Transaktion über denselben Client.
//   3. Nummer freigeben: NUR aus status='reserviert'. Eine bereits "vergebene" Nummer
//      wird NICHT automatisch wieder frei — offene Fachentscheidung (Sven), bis dahin
//      sichtbar blockiert statt automatisch ausgeführt (Review r0006/r0008 — Korrektur
//      zur Vorversion, die JEDE Nummer inkl. "vergeben" zurücksetzte).
//   4. Ordner (nur bei ordnerLoeschen=true UND erfolgreicher DB-Transaktion):
//      Projektordner löschen — mehrfach abgesichert.
//
// Antwort (die App wertet genau diese Felder aus):
//   { ok, monday:{geloescht,grund?,fehler?}, offerte:{geloescht,grund?}, nummerFrei, nummerGrund?, ordner:{geloescht,grund?} }
//   ok ist NUR true, wenn die DB-Transaktion committed wurde UND die Monday-Löschung
//   nicht mit einem echten Fehler abgebrochen ist (kein Treffer ist kein Fehler).
//
// Mount in server.js:  app.use('/projekt-loeschen', require('./routes/projekt_loeschen'));
// Voraussetzung: MONDAY_TOKEN in der .env (für die Monday-Löschung).
//
// ANNAHME, nicht bestätigt: '../db' exportiert neben 'query' auch 'pool' mit
// einer pool.connect()-Methode im Stil von node-postgres (pg.Pool). Die
// tatsächliche src/db/index.js lag bei Erstellung dieser Version nicht vor.

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { pool } = require('../db');

const MONDAY_API = 'https://api.monday.com/v2';
const BOARD      = 1012481465;
const COL_NR     = 'text_mkv7v7m6';

function normBase(raw){ if(!raw) return null; let p=String(raw).trim(); if(p.startsWith('//')) p=p.replace(/\//g,'\\'); return path.normalize(p); }
function istUNC(p){ return !!p && /^\\\\/.test(p); }
const BASIS     = normBase(process.env.NETZLAUFWERK) || 'C:\\kalle-server\\projekte-fallback';
const BASIS_UNC = normBase(process.env.NETZLAUFWERK_UNC) || BASIS;
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
    const nrLit = JSON.stringify(String(nummer));
    let items = [];
    let cursor = null;
    let seiten = 0;
    // Pagination korrigiert (Review r0008, K2): Monday erlaubt bei
    // items_page_by_column_values NICHT gleichzeitig 'columns' und 'cursor'.
    // Folgeseiten laufen deshalb ueber die eigenstaendige next_items_page(...)-
    // Query mit dem cursor aus der vorherigen Seite, nicht ueber eine
    // Wiederholung von items_page_by_column_values.
    const erste = await gql(`query{ items_page_by_column_values(board_id:${BOARD}, columns:[{column_id:"${COL_NR}", column_values:[${nrLit}]}], limit:50){ cursor items{ id name } } }`);
    let page = (erste && erste.items_page_by_column_values) || {};
    items = items.concat(page.items || []);
    cursor = page.cursor || null;
    seiten = 1;
    while(cursor && seiten < 20){
      const weiter = await gql(`query{ next_items_page(limit:50, cursor:${JSON.stringify(cursor)}){ cursor items{ id name } } }`);
      page = (weiter && weiter.next_items_page) || {};
      items = items.concat(page.items || []);
      cursor = page.cursor || null;
      seiten++;
    }
    if(!items.length) return { geloescht:false, grund:'kein Monday-Item mit Nummer '+nummer, fehler:false };
    let fehlerhaft = [];
    for(const it of items){
      try{ await gql(`mutation{ delete_item(item_id:${it.id}){ id } }`); }
      catch(e){ fehlerhaft.push({ id:it.id, grund:e.message }); }
    }
    if(fehlerhaft.length) return { geloescht: fehlerhaft.length < items.length, anzahl: items.length - fehlerhaft.length, teilfehler: fehlerhaft, fehler:true };
    return { geloescht:true, anzahl:items.length, fehler:false };
  }catch(e){ return { geloescht:false, grund:e.message, fehler:true }; }
}

router.post('/', express.json({ limit:'1mb' }), async (req, res) => {
  const { nummer, pfad, ordnerLoeschen, bearbeiter } = req.body || {};
  const nr = String(nummer||'').trim();
  if(!nr) return res.status(400).json({ ok:false, error:'nummer fehlt' });

  const out = { ok:false, monday:{geloescht:false}, offerte:{geloescht:false}, nummerFrei:false, ordner:{geloescht:false} };

  // 1) Monday-Item(s) löschen (extern, nicht Teil der folgenden DB-Transaktion)
  out.monday = await mondayLoeschen(nr);

  // 2) DB: Offerte (+ Positionen CASCADE) + Projektzeile + Audit + Nummer,
  // als echte Transaktion über denselben Client. Response-Felder werden NUR
  // aus den tatsächlich COMMITteten Werten befüllt (Review r0008, K2/T11) —
  // vorher konnte 'offerte.geloescht=true' auch nach einem ROLLBACK stehen
  // bleiben, weil die Felder direkt während der (dann verworfenen)
  // Transaktion gesetzt wurden.
  let dbClient = null;
  let dbOk = false;
  let vorlaeufig = { offerteGeloescht:false, nummerFrei:false, nummerGrund:null };
  try{
    dbClient = await pool.connect();
    await dbClient.query('BEGIN');

    const rOff = await dbClient.query('DELETE FROM offerten WHERE auftragsnr=$1', [nr]);
    vorlaeufig.offerteGeloescht = rOff.rowCount > 0;

    await dbClient.query('DELETE FROM projekte WHERE projektnr=$1', [nr]);

    // Audit-Insert über einen SAVEPOINT: PostgreSQL markiert die gesamte
    // Transaktion nach einem SQL-Fehler als abgebrochen — ein einfacher
    // JS-try/catch darum herum stellt sie NICHT wieder her (Review r0008,
    // K2 Punkt 3). Ein Fehler im Audit-Eintrag darf die eigentliche
    // Löschung deshalb nicht mit sich reissen.
    try{
      await dbClient.query('SAVEPOINT audit_sp');
      await dbClient.query(
        "INSERT INTO audit_log (tabelle, aktion, bearbeiter, nachher) VALUES ('offerten','geloescht',$1,$2)",
        [ (bearbeiter||'System'), JSON.stringify({ nummer:nr }) ]
      );
      await dbClient.query('RELEASE SAVEPOINT audit_sp');
    }catch(auditErr){
      try{ await dbClient.query('ROLLBACK TO SAVEPOINT audit_sp'); }catch(spErr){}
      console.warn('[Projekt-Löschen] Audit-Eintrag fehlgeschlagen (Transaktion läuft weiter):', auditErr.message);
    }

    // Nummer NUR aus status='reserviert' freigeben — siehe Moduldoku oben.
    const rNr = await dbClient.query(
      `UPDATE nummern SET status='frei', session=NULL, reserved_at=NULL, committed_at=NULL
       WHERE nummer=$1 AND status='reserviert'`,
      [nr]
    );
    vorlaeufig.nummerFrei = rNr.rowCount > 0;

    if(!vorlaeufig.nummerFrei){
      const rCheck = await dbClient.query(`SELECT status FROM nummern WHERE nummer=$1`, [nr]);
      const aktuellerStatus = rCheck.rows[0] && rCheck.rows[0].status;
      if(aktuellerStatus === 'vergeben'){
        vorlaeufig.nummerGrund = 'Nummer war bereits vergeben — automatische Wiederfreigabe ist ohne ausdrückliche Fachentscheidung bewusst nicht ausgeführt worden.';
      } else if(aktuellerStatus){
        vorlaeufig.nummerGrund = 'Nummer hatte Status "'+aktuellerStatus+'", nicht "reserviert" — keine Änderung vorgenommen.';
      } else {
        vorlaeufig.nummerGrund = 'Nummer nicht im Pool gefunden (nummern-Tabelle) — keine Änderung möglich.';
      }
    }

    await dbClient.query('COMMIT');
    dbOk = true;
  }catch(e){
    if(dbClient){ try{ await dbClient.query('ROLLBACK'); }catch(rollbackErr){ console.error('[Projekt-Löschen] Rollback fehlgeschlagen:', rollbackErr.message); } }
    console.error('[Projekt-Löschen] DB-Transaktion fehlgeschlagen, zurückgerollt:', e.message);
    out.offerte.grund = e.message;
  }finally{
    if(dbClient) dbClient.release();
  }

  // Response-Felder erst JETZT aus den vorläufigen Werten übernehmen — nur
  // wenn die Transaktion wirklich committed wurde. Nach ROLLBACK bleiben
  // offerte.geloescht=false und nummerFrei=false, exakt wie es der
  // tatsächliche (zurückgerollte) DB-Zustand ist.
  if(dbOk){
    out.offerte.geloescht = vorlaeufig.offerteGeloescht;
    out.nummerFrei = vorlaeufig.nummerFrei;
    if(vorlaeufig.nummerGrund) out.nummerGrund = vorlaeufig.nummerGrund;
  }

  // 4) Ordner (optional, mehrfach abgesichert) — läuft NUR, wenn die
  // DB-Transaktion tatsächlich committed wurde. Nach einem ROLLBACK bleibt
  // die Datenbank beim alten Stand; den Ordner trotzdem zu löschen würde
  // Dateisystem und Datenbank auseinanderlaufen lassen (Review r0008, K2/T11).
  if(ordnerLoeschen && pfad && dbOk){
    try{
      const ziel = zuLokal(String(pfad).trim().replace(/[\\/]+$/,''));
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
  } else if(ordnerLoeschen && pfad && !dbOk){
    out.ordner = { geloescht:false, grund:'Übersprungen — DB-Transaktion wurde zurückgerollt' };
  }

  // Ehrlicher Gesamterfolg: DB-Transaktion committed UND Monday ohne echten
  // Fehler (kein Treffer ist kein Fehler, siehe mondayLoeschen()). Vorher
  // sprang ok bereits bei blossem DB-Erfolg auf true, auch wenn Monday
  // fehlgeschlagen war (Review r0008, K2/T10).
  out.ok = dbOk && out.monday.fehler !== true;

  console.log(`[Projekt-Löschen] ${nr} · Monday:${out.monday.geloescht} · Offerte:${out.offerte.geloescht} · NummerFrei:${out.nummerFrei} · Ordner:${out.ordner.geloescht} · ok:${out.ok}`);
  res.json(out);
});

module.exports = router;
