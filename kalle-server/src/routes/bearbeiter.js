// src/routes/bearbeiter.js
const express = require('express');
const router  = express.Router();
const { query } = require('../db');

// GET /bearbeiter — Alle aktiven Bearbeiter
router.get('/', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, name, kuerzel, email, telefon FROM bearbeiter WHERE aktiv=true ORDER BY name'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /bearbeiter — Neuen Bearbeiter anlegen
router.post('/', async (req, res) => {
  try {
    const { name, kuerzel, email, telefon } = req.body;
    const result = await query(
      'INSERT INTO bearbeiter (name, kuerzel, email, telefon) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, kuerzel, email, telefon]
    );
    res.json({ ok: true, bearbeiter: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /bearbeiter/:kuerzel — Bearbeiter aktualisieren
router.patch('/:kuerzel', async (req, res) => {
  try {
    const { name, email, telefon, aktiv } = req.body;
    await query(
      'UPDATE bearbeiter SET name=$1, email=$2, telefon=$3, aktiv=$4 WHERE kuerzel=$5',
      [name, email, telefon, aktiv !== false, req.params.kuerzel]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
