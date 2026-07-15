// src/routes/kunden.js — Kundenstamm (KUNDEN.json)
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');

// KUNDEN.json liegt im public-Ordner (direkt neben index.html)
const KUNDEN_FILE = path.join(__dirname, '..', '..', 'public', 'kunden.json');

// ── GET /kunden ── Kundenstamm abrufen ───────────────────────────────────
router.get('/', (req, res) => {
  try {
    if (!fs.existsSync(KUNDEN_FILE)) {
      return res.json([]);
    }
    const raw  = fs.readFileSync(KUNDEN_FILE, 'utf8');
    const data = JSON.parse(raw);
    const liste = Array.isArray(data) ? data : (data.kunden || []);
    res.json(liste);
  } catch (e) {
    console.error('[Kunden] Ladefehler:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /kunden/upload ── Kundenstamm speichern (aus KALLE Admin) ────────
router.post('/upload', (req, res) => {
  try {
    const body   = req.body;
    const kunden = Array.isArray(body) ? body : (body.kunden || []);

    if (!kunden.length) {
      return res.status(400).json({ error: 'Keine Kunden-Daten erhalten' });
    }

    fs.writeFileSync(KUNDEN_FILE, JSON.stringify(kunden), 'utf8');
    console.log(`[Kunden] Gespeichert: ${kunden.length} Einträge → ${KUNDEN_FILE}`);
    res.json({ ok: true, anzahl: kunden.length });

  } catch (e) {
    console.error('[Kunden] Upload-Fehler:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
