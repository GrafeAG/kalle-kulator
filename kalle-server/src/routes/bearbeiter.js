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

// ── NEU: Mailversand-Signatur (MAILVERSAND_Spec.md) ───────────────────────
// Eigene Endpunkte statt Erweiterung von PATCH /:kuerzel oben: wer nur seine
// Signatur ändert, soll nicht das ganze Bearbeiter-Formular (Name/E-Mail/
// Telefon) mitschicken müssen. mail_aktiv wird hier bewusst NICHT gesetzt —
// das ist eine IT-Freigabe (Josh/Sven, siehe MAILVERSAND_Integration.md),
// keine Selbstbedienung.

// GET /bearbeiter/:kuerzel/signatur — für die Vorschau im Cockpit
router.get('/:kuerzel/signatur', async (req, res) => {
  try {
    const r = await query(
      'SELECT kuerzel, signatur_html, mail_aktiv FROM bearbeiter WHERE kuerzel=$1',
      [req.params.kuerzel]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unbekannter Bearbeiter' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /bearbeiter/:kuerzel/signatur — Signatur selbst pflegen
// body: { signatur_html }
router.patch('/:kuerzel/signatur', async (req, res) => {
  const { signatur_html } = req.body || {};
  if (typeof signatur_html !== 'string') {
    return res.status(400).json({ error: 'signatur_html (string) fehlt' });
  }
  try {
    const r = await query(
      'UPDATE bearbeiter SET signatur_html=$1 WHERE kuerzel=$2 RETURNING kuerzel',
      [signatur_html, req.params.kuerzel]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unbekannter Bearbeiter' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
