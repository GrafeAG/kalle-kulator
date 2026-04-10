// src/routes/auswertungen.js — SQL-Auswertungen / Reporting
const express = require('express');
const router  = express.Router();
const { query } = require('../db');

// GET /auswertungen/dashboard — Kennzahlen für Dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const [offerten, positionen, umsatz, bearbeiter] = await Promise.all([
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status='entwurf')  as entwuerfe,
          COUNT(*) FILTER (WHERE status='gesendet') as gesendet,
          COUNT(*) FILTER (WHERE status='bestellt') as bestellt,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE erstellt_am > NOW() - INTERVAL '30 days') as letzter_monat
        FROM offerten
      `),
      query(`
        SELECT typ, COUNT(*) as anzahl, SUM(total_vk) as umsatz
        FROM positionen GROUP BY typ ORDER BY umsatz DESC
      `),
      query(`
        SELECT
          ROUND(SUM(total_netto), 2) as gesamt_netto,
          ROUND(SUM(total_netto) FILTER (WHERE datum >= DATE_TRUNC('year', NOW())), 2) as dieses_jahr,
          ROUND(SUM(total_netto) FILTER (WHERE datum >= DATE_TRUNC('month', NOW())), 2) as diesen_monat
        FROM offerten WHERE status NOT IN ('storniert','abgelehnt')
      `),
      query(`
        SELECT o.bearbeiter, o.bearbeiter_kuerzel,
          COUNT(*) as offerten, ROUND(SUM(o.total_netto), 2) as umsatz
        FROM offerten o
        WHERE o.erstellt_am > NOW() - INTERVAL '365 days'
          AND o.status NOT IN ('storniert')
        GROUP BY o.bearbeiter, o.bearbeiter_kuerzel
        ORDER BY umsatz DESC
      `)
    ]);

    res.json({
      offerten: offerten.rows[0],
      positionen_nach_typ: positionen.rows,
      umsatz: umsatz.rows[0],
      bearbeiter: bearbeiter.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /auswertungen/offerten-verlauf — Monatlicher Umsatzverlauf
router.get('/offerten-verlauf', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        TO_CHAR(datum, 'YYYY-MM') as monat,
        COUNT(*) as anzahl,
        ROUND(SUM(total_netto), 2) as umsatz_netto
      FROM offerten
      WHERE datum >= NOW() - INTERVAL '24 months'
        AND status NOT IN ('storniert','abgelehnt')
      GROUP BY TO_CHAR(datum, 'YYYY-MM')
      ORDER BY monat DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /auswertungen/top-kunden — Umsatz nach Kunden
router.get('/top-kunden', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        k.name, k.email,
        COUNT(o.id) as anzahl_offerten,
        ROUND(SUM(o.total_netto), 2) as umsatz_netto
      FROM kunden k
      JOIN offerten o ON o.kunde_id = k.id
      WHERE o.status NOT IN ('storniert','abgelehnt')
      GROUP BY k.id, k.name, k.email
      ORDER BY umsatz_netto DESC
      LIMIT 20
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
