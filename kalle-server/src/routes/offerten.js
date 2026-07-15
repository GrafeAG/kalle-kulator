// src/routes/offerten.js — Offerten CRUD
const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const fs   = require('fs');
const path = require('path');

// Hilfsfunktion: Positionen aus Payload normalisieren
function extrahierePositionen(offerteId, positions = []) {
  return positions.map((p, i) => ({
    offerte_id:  offerteId,
    pos_nr:      i + 1,
    typ:         p.type || 'unbekannt',
    bezeichnung: p.label || '',
    menge:       p.stk || 1,
    einzelpreis: p.stk > 0 ? (p.totalVK || 0) / p.stk : 0,
    total_vk:    p.totalVK || 0,
    details:     JSON.stringify(p),
  }));
}

// GET /offerten — Alle Offerten (Liste)
router.get('/', async (req, res) => {
  try {
    const { status, bearbeiter, limit = 50, offset = 0 } = req.query;
    let where = [];
    let params = [];
    let pi = 1;

    if (status)     { where.push(`o.status = $${pi++}`);            params.push(status); }
    if (bearbeiter) { where.push(`o.bearbeiter_kuerzel = $${pi++}`); params.push(bearbeiter); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const result = await query(`
      SELECT
        o.id, o.auftragsnr, o.datum, o.status,
        o.total_netto, o.total_brutto,
        o.bearbeiter, o.bearbeiter_kuerzel,
        o.sl_exportiert, o.erstellt_am, o.geaendert_am,
        k.name as kundenname, k.email as kundenemail,
        p.projektnr, p.objektname, p.ort
      FROM offerten o
      LEFT JOIN kunden k ON o.kunde_id = k.id
      LEFT JOIN projekte p ON o.projekt_id = p.id
      ${whereClause}
      ORDER BY o.erstellt_am DESC
      LIMIT $${pi++} OFFSET $${pi++}
    `, [...params, limit, offset]);

    const total = await query(`SELECT COUNT(*) FROM offerten o ${whereClause}`, params);

    res.json({
      offerten: result.rows,
      total: parseInt(total.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (err) {
    console.error('[Offerten] Liste fehlgeschlagen:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /offerten/nextnr?prefix=KA150726SKU — Nächste freie Auftragsnummer (atomar aus DB)
router.get('/nextnr', async (req, res) => {
  const { prefix } = req.query;
  if (!prefix || !prefix.match(/^KA\d{6}/)) {
    return res.status(400).json({ error: 'Ungültiger prefix' });
  }
  try {
    const result = await query(
      `SELECT auftragsnr FROM offerten
       WHERE auftragsnr LIKE $1
       ORDER BY auftragsnr DESC
       LIMIT 1`,
      [prefix + '%']
    );
    let next = 1;
    if (result.rows.length) {
      const m = result.rows[0].auftragsnr.match(/(\d+)$/);
      if (m) next = parseInt(m[1]) + 1;
    }
    const nr = prefix + String(next).padStart(2, '0');
    console.log(`[Offerten] nextnr: ${nr}`);
    res.json({ nr, next, prefix });
  } catch (e) {
    console.error('[Offerten] nextnr Fehler:', e.message);
    const ts = Date.now().toString().slice(-4);
    res.json({ nr: prefix + ts, next: parseInt(ts), prefix });
  }
});

// GET /offerten/:id — Einzelne Offerte (vollständiger Payload)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // id kann Auftragsnummer oder DB-ID sein
    const isNum = /^\d+$/.test(id);
    const result = await query(
      `SELECT o.*, k.name as kundenname FROM offerten o
       LEFT JOIN kunden k ON o.kunde_id = k.id
       WHERE ${isNum ? 'o.id' : 'o.auftragsnr'} = $1`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /offerten — Neue Offerte speichern
router.post('/', async (req, res) => {
  try {
    const auftrag = req.body;
    const {
      auftragsnr, kundenname, kontaktperson, email, telefon,
      adresse, datum, bearbeiter, bearbeiterKuerzel,
      positions = [], total = 0, bemerkung,
    } = auftrag;

    // Kunde suchen oder anlegen
    let kundeId = null;
    if (kundenname && kundenname !== '–') {
      let kunde = await query('SELECT id FROM kunden WHERE name=$1 LIMIT 1', [kundenname]);
      if (kunde.rows.length) {
        kundeId = kunde.rows[0].id;
        // Daten aktualisieren
        await query(
          'UPDATE kunden SET kontaktperson=$2, email=$3, telefon=$4, adresse=$5, geaendert_am=NOW() WHERE id=$1',
          [kundeId, kontaktperson, email, telefon, adresse]
        );
      } else {
        const neu = await query(
          'INSERT INTO kunden (name, kontaktperson, email, telefon, adresse) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [kundenname, kontaktperson, email, telefon, adresse]
        );
        kundeId = neu.rows[0].id;
      }
    }

    // Offerte speichern (INSERT oder UPDATE bei Duplikat)
    const result = await query(`
      INSERT INTO offerten
        (auftragsnr, kunde_id, bearbeiter, bearbeiter_kuerzel, datum, total_netto, bemerkung, status, payload)
      VALUES ($1,$2,$3,$4,$5::date,$6,$7,'entwurf',$8)
      ON CONFLICT (auftragsnr) DO UPDATE SET
        kunde_id=$2, bearbeiter=$3, bearbeiter_kuerzel=$4, datum=$5::date,
        total_netto=$6, bemerkung=$7, payload=$8, geaendert_am=NOW()
      RETURNING id, auftragsnr
    `, [
      auftragsnr,
      kundeId,
      bearbeiter,
      bearbeiterKuerzel,
      datum || new Date().toISOString().split('T')[0],
      total,
      bemerkung || null,
      JSON.stringify(auftrag),
    ]);

    const offerteId = result.rows[0].id;

    // Positionen speichern (löschen + neu)
    await query('DELETE FROM positionen WHERE offerte_id=$1', [offerteId]);
    for (const pos of extrahierePositionen(offerteId, positions)) {
      await query(
        'INSERT INTO positionen (offerte_id, pos_nr, typ, bezeichnung, menge, einzelpreis, total_vk, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [pos.offerte_id, pos.pos_nr, pos.typ, pos.bezeichnung, pos.menge, pos.einzelpreis, pos.total_vk, pos.details]
      );
    }

    // Als JSON auf Netzlaufwerk ablegen
    const offertPfad = process.env.OFFERTEN_PFAD;
    if (offertPfad) {
      try {
        const safe = auftragsnr.replace(/[^a-zA-Z0-9_-]/g, '');
        const filePath = path.join(offertPfad, safe + '.json');
        fs.mkdirSync(offertPfad, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(auftrag, null, 2), 'utf-8');
        // Pfad in DB speichern
        await query('UPDATE offerten SET pdf_pfad=$1 WHERE id=$2', [filePath.replace('.json', '.pdf'), offerteId]);
      } catch (e) {
        console.warn('[Offerten] Netzlaufwerk-Ablage fehlgeschlagen:', e.message);
      }
    }

    // Audit
    await query(
      "INSERT INTO audit_log (tabelle, datensatz_id, aktion, bearbeiter) VALUES ('offerten',$1,'erstellt',$2)",
      [offerteId, bearbeiter]
    );

    console.log(`[Offerten] ${auftragsnr} gespeichert (ID ${offerteId})`);
    res.json({ ok: true, id: offerteId, auftragsnr });
  } catch (err) {
    console.error('[Offerten] Speichern fehlgeschlagen:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /offerten — sl_exportiert + projektPfad aktualisieren
router.patch('/', async (req, res) => {
  try {
    const { auftragsnr, slExportiert, slExportiertAm, slPfad, projektPfad } = req.body;
    if (!auftragsnr) return res.status(400).json({ error: 'auftragsnr fehlt' });
    const updates = [];
    const params = [];
    let pi = 1;
    if (slExportiert !== undefined) { updates.push(`sl_exportiert=$${pi++}`); params.push(slExportiert); }
    if (slExportiertAm)             { updates.push(`sl_exportiert_am=$${pi++}`); params.push(slExportiertAm); }
    if (slPfad)                     { updates.push(`sl_pfad=$${pi++}`); params.push(slPfad); }
    if (projektPfad)                { updates.push(`projekt_pfad=$${pi++}`); params.push(projektPfad); }
    if (!updates.length) return res.status(400).json({ error: 'Keine Felder zum Aktualisieren' });
    updates.push(`geaendert_am=NOW()`);
    params.push(auftragsnr);
    await query(
      `UPDATE offerten SET ${updates.join(',')} WHERE auftragsnr=$${pi}`,
      params
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[Offerten] PATCH Fehler:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /offerten/:id/status — Status ändern
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, bearbeiter } = req.body;
    const valid = ['entwurf','gesendet','bestellt','abgelehnt','storniert'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Ungültiger Status' });

    await query(
      'UPDATE offerten SET status=$1, geaendert_am=NOW() WHERE auftragsnr=$2 OR id::text=$2',
      [status, id]
    );
    await query(
      "INSERT INTO audit_log (tabelle, aktion, bearbeiter, nachher) VALUES ('offerten',$1,$2,$3)",
      [`status_${status}`, bearbeiter, JSON.stringify({ status, id })]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /offerten/:id/payload — Roher KALLE-JSON (für Restore)
router.get('/:id/payload', async (req, res) => {
  try {
    const result = await query(
      'SELECT payload, auftragsnr FROM offerten WHERE auftragsnr=$1 OR id::text=$1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(result.rows[0].payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
