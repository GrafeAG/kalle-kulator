// src/routes/preise.js — Preisliste laden und speichern
const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const fs = require('fs');
const path = require('path');

// GET /preise — Aktive Preisliste laden
router.get('/', async (req, res) => {
  try {
    const result = await query(
      'SELECT payload, version, erstellt_am FROM preislisten WHERE aktiv=true ORDER BY erstellt_am DESC LIMIT 1'
    );
    if (!result.rows.length) {
      // Fallback: kalle-preise.json vom Netzlaufwerk versuchen
      const pfad = process.env.PREISLISTE_PFAD;
      if (pfad && fs.existsSync(pfad)) {
        const data = JSON.parse(fs.readFileSync(pfad, 'utf-8'));
        return res.json(data);
      }
      return res.status(404).json({ error: 'Keine Preisliste gefunden' });
    }
    res.json(result.rows[0].payload);
  } catch (err) {
    console.error('[Preise] Laden fehlgeschlagen:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /preise — Neue Preisliste speichern (nur Admins / Backend)
router.post('/', async (req, res) => {
  try {
    const preise = req.body;
    const bearbeiter = req.headers['x-bearbeiter'] || 'System';
    const version = preise._appVersion || new Date().toISOString().split('T')[0];

    // Alte Preisliste deaktivieren
    await query('UPDATE preislisten SET aktiv=false');

    // Neue speichern
    const result = await query(
      'INSERT INTO preislisten (version, payload, erstellt_von, aktiv) VALUES ($1, $2, $3, true) RETURNING id',
      [version, JSON.stringify(preise), bearbeiter]
    );

    // Auch auf Netzlaufwerk schreiben (Fallback)
    const pfad = process.env.PREISLISTE_PFAD;
    if (pfad) {
      try {
        fs.writeFileSync(pfad, JSON.stringify(preise, null, 2), 'utf-8');
      } catch (e) {
        console.warn('[Preise] Netzlaufwerk-Schreiben fehlgeschlagen:', e.message);
      }
    }

    // Audit
    await query(
      "INSERT INTO audit_log (tabelle, datensatz_id, aktion, bearbeiter, nachher) VALUES ('preislisten', $1, 'erstellt', $2, $3)",
      [result.rows[0].id, bearbeiter, JSON.stringify({ version })]
    );

    console.log(`[Preise] Neue Preisliste v${version} gespeichert (ID ${result.rows[0].id})`);
    res.json({ ok: true, id: result.rows[0].id, version });
  } catch (err) {
    console.error('[Preise] Speichern fehlgeschlagen:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /preise/versionen — Alle gespeicherten Versionen
router.get('/versionen', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, version, erstellt_von, aktiv, erstellt_am FROM preislisten ORDER BY erstellt_am DESC LIMIT 20'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
