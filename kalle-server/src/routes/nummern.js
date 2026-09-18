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
    await query(
      `UPDATE nummern SET status='frei', session=NULL, reserved_at=NULL
       WHERE status='reserviert' AND reserved_at < NOW() - INTERVAL '${TTL_STUNDEN} hours'`
    );
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

// POST /nummern/commit { nummer, session? }  → status vergeben
//
// Überarbeitet (Review r0006/r0008, K3). Vorher: UPDATE ohne Session-Prüfung,
// danach bedingungsloser INSERT-Fallback, IMMER {ok:true} — dadurch konnte
// Session Y eine von Session X reservierte Nummer committen (UPDATE traf 0
// Zeilen, der Fallback-INSERT griff wegen ON CONFLICT DO NOTHING ebenfalls
// nicht, die Antwort war trotzdem {ok:true}, kein DB-Zustand hatte sich
// geändert).
//
// Neuer Vertrag, vier Fälle:
//   1) Eigene gültige Reservierung (session passt, Status 'reserviert') → ok:true
//   2) Bestätigter Retry: Nummer bereits 'vergeben' → idempotent ok:true,
//      bereitsVergeben:true (kein Fehler)
//   3) Keine Session mitgeschickt (manuelle Eingabe) → darf NUR eine
//      aktuell 'freie' Nummer beanspruchen, markiert manuell:true
//   4) Alles andere (fremde/abgelaufene Reservierung, unbekannte Nummer) →
//      HTTP 409, ok:false
router.post('/commit', express.json(), async (req, res) => {
  const { nummer, session } = req.body || {};
  if (!nummer) return res.status(400).json({ ok:false, error: 'nummer fehlt' });
  const nr = String(nummer);
  try {
    if (session) {
      const r1 = await query(
        `UPDATE nummern SET status='vergeben', committed_at=NOW(), session=NULL
         WHERE nummer=$1 AND status='reserviert' AND session=$2
         RETURNING nummer`,
        [nr, String(session)]
      );
      if (r1.rows.length) {
        console.log('[Nummern] vergeben (eigene Reservierung):', nr);
        return res.json({ ok: true, manuell: false });
      }
    }

    const rCheck = await query(`SELECT status FROM nummern WHERE nummer=$1`, [nr]);
    const aktuellerStatus = rCheck.rows[0] && rCheck.rows[0].status;
    if (aktuellerStatus === 'vergeben') {
      return res.json({ ok: true, bereitsVergeben: true, manuell: false });
    }

    if (!session) {
      const r2 = await query(
        `INSERT INTO nummern (nummer, status, committed_at) VALUES ($1,'vergeben',NOW())
         ON CONFLICT (nummer) DO UPDATE SET status='vergeben', committed_at=NOW()
         WHERE nummern.status='frei'
         RETURNING nummer`,
        [nr]
      );
      if (r2.rows.length) {
        console.log('[Nummern] vergeben (manuell, war frei):', nr);
        return res.json({ ok: true, manuell: true });
      }
    }

    console.warn('[Nummern] commit abgelehnt — Nummer nicht (mehr) unter dieser Session reserviert:', nr, 'Status:', aktuellerStatus);
    return res.status(409).json({ ok: false, error: 'Nummer ist nicht (mehr) unter dieser Session reserviert und kann nicht bestätigt werden.' });
  } catch (e) {
    console.error('[Nummern] commit:', e.message);
    res.status(500).json({ ok:false, error: e.message });
  }
});

// POST /nummern/freigeben { nummer, session? }  → status frei (nur wenn noch reserviert)
// session optional (Abwärtskompatibilität) — wird sie mitgeschickt, muss sie
// zusätzlich passen, damit eine Session nicht versehentlich die Reservierung
// einer anderen aufheben kann.
router.post('/freigeben', express.json(), async (req, res) => {
  const { nummer, session } = req.body || {};
  if (!nummer) return res.status(400).json({ error: 'nummer fehlt' });
  const nr = String(nummer);
  try {
    const r = session
      ? await query(
          `UPDATE nummern SET status='frei', session=NULL, reserved_at=NULL
           WHERE nummer=$1 AND status='reserviert' AND session=$2`,
          [nr, String(session)]
        )
      : await query(
          `UPDATE nummern SET status='frei', session=NULL, reserved_at=NULL
           WHERE nummer=$1 AND status='reserviert'`,
          [nr]
        );
    res.json({ ok: true, geaendert: r.rowCount > 0 });
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
