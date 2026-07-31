// src/routes/roche.js — Roche-Sonderablage
// Roche hat ein eigenes Ordnersystem unter  Objekte/Basel/Roche/ :
//   • Jahresablage (kein Bau):   <ROCHE_BASE>/<Jahr>/<Projektbezeichnung>
//   • Bau-Zuordnung:             <ROCHE_BASE>/<Bau X>/<Projektbezeichnung>   (Bau evtl. neu)
//
// Mounten in server.js:  app.use('/roche', require('./routes/roche'));
// Voraussetzung .env:    ROCHE_BASE = absoluter Pfad zum Roche-Ordner
//   z. B.  ROCHE_BASE=\\\\server\\Daten\\Objekte\\Basel\\Roche

const express = require('express');
const router  = express.Router();
const fs   = require('fs');
const path = require('path');

function base(){
  const b = process.env.ROCHE_BASE;
  if(!b) throw new Error('ROCHE_BASE nicht gesetzt (.env) — Pfad zu Objekte/Basel/Roche');
  return b;
}
// Ordnernamen säubern (keine Pfad-/Sonderzeichen, kein Traversal)
function clean(s){
  return String(s||'').replace(/[\\/:*?"<>|]/g,'').replace(/\.+$/,'').trim();
}

// GET /roche/bauten  → { ok, bauten:[...], alle:[...] }
// Liefert die Unterordner unter ROCHE_BASE. „bauten" = nur die mit „Bau" beginnenden,
// „alle" = alle Ordner (Jahre, Roche Kaiseraugst, Info-Ordner …), sortiert.
router.get('/bauten', (req, res) => {
  try{
    const root = base();
    const ent = fs.readdirSync(root, { withFileTypes:true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    const collator = new Intl.Collator('de', { numeric:true, sensitivity:'base' });
    const alle = ent.slice().sort(collator.compare);
    const bauten = alle.filter(n => /^bau\b/i.test(n));
    res.json({ ok:true, bauten, alle });
  }catch(e){
    console.error('[Roche] bauten:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// POST /roche/ordner  { ziel, projektbezeichnung }
//   ziel = Bau-Name (z. B. „Bau 91") ODER Jahr (z. B. „2026")
//   Legt <ROCHE_BASE>/<ziel>/<projektbezeichnung> an (ziel wird bei Bedarf neu erstellt).
router.post('/ordner', express.json(), (req, res) => {
  try{
    const root = base();
    const ziel = clean(req.body && req.body.ziel);
    const proj = clean(req.body && req.body.projektbezeichnung);
    if(!ziel) return res.status(400).json({ ok:false, error:'ziel (Bau oder Jahr) fehlt' });
    if(!proj) return res.status(400).json({ ok:false, error:'projektbezeichnung fehlt' });

    const zielPfad = path.join(root, ziel);
    // Sicherheit: Ergebnis muss innerhalb von ROCHE_BASE liegen
    if(!path.resolve(zielPfad).startsWith(path.resolve(root))) {
      return res.status(400).json({ ok:false, error:'ungültiges Ziel' });
    }
    const neuBau = !fs.existsSync(zielPfad);
    fs.mkdirSync(zielPfad, { recursive:true });

    const ordnerpfad = path.join(zielPfad, proj);
    const existierte = fs.existsSync(ordnerpfad);
    fs.mkdirSync(ordnerpfad, { recursive:true });

    res.json({ ok:true, ordnerpfad, ziel, neuerBau: neuBau, ordnerExistierte: existierte });
  }catch(e){
    console.error('[Roche] ordner:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

module.exports = router;
