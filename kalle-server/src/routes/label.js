// src/routes/label.js — Live-Daten fürs Kisten-Label (Kisten-/Montage-Laufzettel)
// Holt pro Projektnummer die AKTUELLEN Werte aus Monday (serverseitig, Token versteckt).
// Mounten in server.js:  app.use('/label', require('./routes/label'));
// Voraussetzung in .env:  MONDAY_TOKEN=<Monday-API-Token>   (idealerweise Service-Konto)

const express = require('express');
const router  = express.Router();

const MONDAY_API = 'https://api.monday.com/v2';
const BOARD = 1012481465;                    // GRAFE Produktionsübersicht
const COL = {
  projektnr: 'text_mkv7v7m6',                // Projektnummer
  kunde:     'text_mm5hbe90',                // Kunde
  versand:   'date_mkwba8sk',                // VERSANDTERMIN
  montage:   'date_mkwb2tev',                // MONTAGETERMIN
  pl:        'people0',                       // Projektleiter
  adresse:   'location_mksw41wx',             // Montageadresse
};
const SUB = {                                // „Montage"-Subelement (Board 1012481470)
  person:       'person',                    // Bearbeiter = Monteure
  datum:        'date0',
  montagedatum: 'date_mkwf48rq',             // Montagedatum_
};

function fmtDate(d){
  if(!d) return '';
  const m = String(d).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(d);
}
function stripNr(name, nr){
  let n = (name||'').trim();
  if(nr && n.startsWith(nr)) n = n.slice(nr.length).replace(/^[\s\-–—·/,]+/,'');
  return n.trim();
}

async function mondayQuery(query, variables){
  const token = process.env.MONDAY_TOKEN;
  if(!token) throw new Error('MONDAY_TOKEN nicht gesetzt (.env)');
  const r = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization': token, 'API-Version':'2024-01' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if(j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// GET /label?nr=260215  → { ok, projektnr, name, kunde, projektleiter, monteure, montagedatum, versanddatum }
router.get('/', async (req, res) => {
  const nr = String(req.query.nr || '').trim();
  if(!nr) return res.status(400).json({ ok:false, error:'Projektnummer (nr) fehlt' });
  try{
    const data = await mondayQuery(`
      query($nr:[String!]!){
        items_page_by_column_values(board_id:${BOARD}, columns:[{column_id:"${COL.projektnr}", column_values:$nr}], limit:1){
          items{
            id name
            cols: column_values(ids:["${COL.pl}","${COL.kunde}","${COL.versand}","${COL.montage}","${COL.adresse}"]){ id text }
            subitems{ name column_values(ids:["${SUB.person}","${SUB.datum}","${SUB.montagedatum}"]){ id text } }
          }
        }
      }`, { nr:[nr] });

    const item = data && data.items_page_by_column_values && data.items_page_by_column_values.items[0];
    if(!item) return res.json({ ok:false, error:'Projekt nicht gefunden', projektnr:nr });

    const c = {}; (item.cols||[]).forEach(v => c[v.id] = v.text || '');

    // „Montage"-Subelement suchen (Varianten: Montage, Montage vor Ort, Montage am Auto …)
    const montageSub = (item.subitems||[]).find(s => (s.name||'').toLowerCase().startsWith('montage'));
    let monteure = '', subMontagedatum = '';
    if(montageSub){
      const sc = {}; (montageSub.column_values||[]).forEach(v => sc[v.id] = v.text || '');
      monteure = sc[SUB.person] || '';
      subMontagedatum = sc[SUB.montagedatum] || sc[SUB.datum] || '';
    }

    res.json({
      ok: true,
      projektnr:     nr,
      name:          stripNr(item.name, nr),
      kunde:         c[COL.kunde] || '',
      projektleiter: c[COL.pl] || '',
      monteure:      monteure,
      montagedatum:  fmtDate(c[COL.montage] || subMontagedatum),
      versanddatum:  fmtDate(c[COL.versand] || ''),
      montageadresse: c[COL.adresse] || '',
    });
  }catch(e){
    console.error('[Label] Fehler:', e.message);
    res.status(500).json({ ok:false, error:e.message, projektnr:nr });
  }
});

module.exports = router;
