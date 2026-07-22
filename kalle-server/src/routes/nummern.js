// src/routes/nummern.js — zentrale Vorgangsnummern-Vergabe (26xxxx)
// Ersetzt funktional das bisherige sequenzielle /offerten/nextnr.
// Zustände je Nummer: frei → reserviert → vergeben (Rücksprung reserviert→frei).
const express = require('express');
const router  = express.Router();
const { query } = require('../db');

const TTL_STUNDEN = 6; // reservierte, nie committete Nummern nach x Std. automatisch freigeben

// POST /nummern/reservieren  → { nummer }
// Atomar: zieht zufällig eine freie Nummer und markiert sie reserviert.
router.post('/reservieren', express.json(), async (req, res) => {
  const session = (req.body && req.body.session) || null;
  try {
    // 1) abgelaufene Reservierungen freigeben (Sicherheitsnetz, Browser-Close liefert kein Signal)
    await query(
      `UPDATE nummern SET status='frei', session=NULL, reserved_at=NULL
       WHERE status='reserviert' AND reserved_at < NOW() - INTERVAL '${TTL_STUNDEN} hours'`
    );
    // 2) atomar eine freie Nummer ziehen
    const r = await query(
      `UPDATE nummern SET status='reserviert', session=$1, reserved_at=NOW()
       WHERE nummer = (SELECT nummer FROM nummern WHERE status='frei'
                       ORDER BY random() LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING nummer`,
      [session]
    );
    if (!r.rows.length) return res.status(409).json({ error: 'Keine freie Nummer im Pool verfügbar' });
    console.log('[Nummern] reserviert:', r.rows[0].nummer);
    res.json({ nummer: r.rows[0].nummer });
  } catch (e) {
    console.error('[Nummern] reservieren:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /nummern/commit { nummer }  → status vergeben (bei Speichern/Ablage/monday)
router.post('/commit', express.json(), async (req, res) => {
  const { nummer } = req.body || {};
  if (!nummer) return res.status(400).json({ error: 'nummer fehlt' });
  try {
    await query(`UPDATE nummern SET status='vergeben', committed_at=NOW() WHERE nummer=$1`, [String(nummer)]);
    // Falls die Nummer (Fallback-Vergabe ohne vorherige Reservierung) noch nicht im Pool war: eintragen.
    await query(`INSERT INTO nummern (nummer, status, committed_at) VALUES ($1,'vergeben',NOW()) ON CONFLICT (nummer) DO NOTHING`, [String(nummer)]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Nummern] commit:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /nummern/freigeben { nummer }  → status frei (nur wenn noch reserviert)
router.post('/freigeben', express.json(), async (req, res) => {
  const { nummer } = req.body || {};
  if (!nummer) return res.status(400).json({ error: 'nummer fehlt' });
  try {
    await query(
      `UPDATE nummern SET status='frei', session=NULL, reserved_at=NULL
       WHERE nummer=$1 AND status='reserviert'`,
      [String(nummer)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[Nummern] freigeben:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /nummern/status  → Zählung je Status (Monitoring)
router.get('/status', async (req, res) => {
  try {
    const r = await query(`SELECT status, COUNT(*)::int AS anzahl FROM nummern GROUP BY status ORDER BY status`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
