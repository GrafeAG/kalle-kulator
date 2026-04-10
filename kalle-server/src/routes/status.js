// src/routes/status.js
const express = require('express');
const router  = express.Router();
const { query } = require('../db');

// GET /status — Health check
router.get('/', async (req, res) => {
  try {
    const db = await query('SELECT COUNT(*) as offerten FROM offerten');
    const pr = await query('SELECT COUNT(*) as preislisten FROM preislisten WHERE aktiv=true');
    res.json({
      status:  'ok',
      server:  'KALLE-KULATOR Node.js Server',
      version: '2.0.0',
      db:      'PostgreSQL',
      offerten: parseInt(db.rows[0].offerten),
      preisliste_aktiv: parseInt(pr.rows[0].preislisten) > 0,
      zeit:    new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
