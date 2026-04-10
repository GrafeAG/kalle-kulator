// src/routes/projekte.js — Projektordner erstellen und verwalten
const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const fs   = require('fs');
const path = require('path');

// Ordnerpfad aus Projektdaten berechnen
// Schema: Z:\01-Kundenprojekte\Objekte\[Ort]\[Strasse Objekt]\[Nr] [Objektname]
function berechnePfad(ort, strasse, projektnr, objektname) {
  const basisPfad = process.env.NETZLAUFWERK || 'Z:/01-Kundenprojekte';
  const clean = s => (s || '').replace(/[<>:"|?*]/g, '').trim();
  return path.join(
    basisPfad, 'Objekte',
    clean(ort),
    clean(strasse),
    `${clean(projektnr)} ${clean(objektname)}`
  ).replace(/\\/g, '/');
}

// GET /projekte — Alle Projekte
router.get('/', async (req, res) => {
  try {
    const result = await query(`
      SELECT p.*, k.name as kundenname,
        (SELECT COUNT(*) FROM offerten WHERE projekt_id = p.id) as anzahl_offerten
      FROM projekte p
      LEFT JOIN kunden k ON p.kunde_id = k.id
      ORDER BY p.erstellt_am DESC LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /projekte — Neues Projekt anlegen + Ordner erstellen
router.post('/', async (req, res) => {
  try {
    const { ort, strasse, objektname, projektnr, kundenname, bearbeiter } = req.body;

    if (!projektnr || !objektname) {
      return res.status(400).json({ error: 'projektnr und objektname sind Pflichtfelder' });
    }

    const ordnerpfad = berechnePfad(ort, strasse, projektnr, objektname);

    // Unterordner erstellen
    const unterordner = ['Offerten', 'Anfragen', 'Dokumente'];
    const erstellteOrdner = [];
    const fehler = [];

    for (const uo of unterordner) {
      const vollpfad = path.join(ordnerpfad, uo);
      try {
        fs.mkdirSync(vollpfad, { recursive: true });
        erstellteOrdner.push(vollpfad);
      } catch (e) {
        fehler.push(`${uo}: ${e.message}`);
      }
    }

    // Kunde suchen oder anlegen
    let kundeId = null;
    if (kundenname) {
      let k = await query('SELECT id FROM kunden WHERE name=$1 LIMIT 1', [kundenname]);
      if (k.rows.length) {
        kundeId = k.rows[0].id;
      } else {
        const neu = await query('INSERT INTO kunden (name) VALUES ($1) RETURNING id', [kundenname]);
        kundeId = neu.rows[0].id;
      }
    }

    // Projekt in DB speichern
    const result = await query(`
      INSERT INTO projekte (projektnr, ort, strasse, objektname, ordnerpfad, kunde_id, erstellt_von)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (projektnr) DO UPDATE SET
        ort=$2, strasse=$3, objektname=$4, ordnerpfad=$5, geaendert_am=NOW()
      RETURNING id, projektnr, ordnerpfad
    `, [projektnr, ort, strasse, objektname, ordnerpfad, kundeId, bearbeiter]);

    await query(
      "INSERT INTO audit_log (tabelle, datensatz_id, aktion, bearbeiter) VALUES ('projekte',$1,'erstellt',$2)",
      [result.rows[0].id, bearbeiter]
    );

    console.log(`[Projekte] ${projektnr} angelegt — ${ordnerpfad}`);

    res.json({
      ok: true,
      id: result.rows[0].id,
      projektnr: result.rows[0].projektnr,
      ordnerpfad: result.rows[0].ordnerpfad,
      erstellteOrdner,
      warnungen: fehler.length ? fehler : undefined,
    });
  } catch (err) {
    console.error('[Projekte] Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /projekte/:id/upload — Datei in Projektordner ablegen
router.post('/:id/upload', async (req, res) => {
  try {
    const proj = await query('SELECT * FROM projekte WHERE id=$1 OR projektnr=$1', [req.params.id]);
    if (!proj.rows.length) return res.status(404).json({ error: 'Projekt nicht gefunden' });

    const { ordnerpfad } = proj.rows[0];
    const { typ = 'dokument', dateiname, inhalt_base64, bearbeiter } = req.body;

    const unterordner = typ === 'offerte_pdf' || typ === 'offerte_json' ? 'Offerten'
                      : typ === 'anfrage_email' ? 'Anfragen'
                      : 'Dokumente';

    const zielPfad = path.join(ordnerpfad, unterordner, dateiname);

    if (inhalt_base64) {
      const buf = Buffer.from(inhalt_base64, 'base64');
      fs.writeFileSync(zielPfad, buf);
    }

    await query(
      'INSERT INTO projekt_dateien (projekt_id, typ, dateiname, pfad, hochgeladen_von) VALUES ($1,$2,$3,$4,$5)',
      [proj.rows[0].id, typ, dateiname, zielPfad, bearbeiter]
    );

    console.log(`[Upload] ${dateiname} → ${zielPfad}`);
    res.json({ ok: true, pfad: zielPfad });
  } catch (err) {
    console.error('[Upload] Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
