// scripts/migrate_nummern.js — Nummern-Pool (26xxxx) anlegen & befüllen
// Aufruf:  node scripts/migrate_nummern.js
require('dotenv').config();
const { pool } = require('../src/db');

const START = 260513; // 260001–260512 = Historie (kommen NICHT als frei in den Pool)
const ENDE  = 269999; // Jahr 2026. Für 2027 zusätzlich 270001–279999 nachladen (START/ENDE anpassen).

async function run() {
  console.log('═══════════════════════════════════════');
  console.log('  KALLE — Nummern-Pool Migration (26xxxx)');
  console.log('═══════════════════════════════════════');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nummern (
      nummer       TEXT PRIMARY KEY,
      status       TEXT NOT NULL DEFAULT 'frei' CHECK (status IN ('frei','reserviert','vergeben')),
      session      TEXT,
      reserved_at  TIMESTAMPTZ,
      committed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_nummern_status ON nummern(status);
  `);

  // Pool befüllen (nur fehlende) — in Blöcken
  const CH = 2000;
  let batch = [];
  let eingefuegt = 0;
  for (let n = START; n <= ENDE; n++) {
    batch.push(`('${n}')`);
    if (batch.length >= CH) {
      const r = await pool.query(`INSERT INTO nummern (nummer) VALUES ${batch.join(',')} ON CONFLICT (nummer) DO NOTHING`);
      eingefuegt += r.rowCount; batch = [];
    }
  }
  if (batch.length) {
    const r = await pool.query(`INSERT INTO nummern (nummer) VALUES ${batch.join(',')} ON CONFLICT (nummer) DO NOTHING`);
    eingefuegt += r.rowCount;
  }

  // Bereits in offerten vergebene 26xxxx als 'vergeben' markieren (Doppelvergabe verhindern)
  await pool.query(`
    UPDATE nummern SET status='vergeben', committed_at=NOW()
    WHERE nummer IN (SELECT auftragsnr FROM offerten WHERE auftragsnr ~ '^26[0-9]{4}$')
  `);

  const c = await pool.query(`SELECT status, COUNT(*)::int AS anzahl FROM nummern GROUP BY status ORDER BY status`);
  console.log('✓ Pool bereit — neu eingefügt:', eingefuegt);
  c.rows.forEach(r => console.log(`  • ${r.status.padEnd(11)} ${r.anzahl}`));
  await pool.end();
}

run().catch(e => { console.error('✗ Fehler:', e.message); process.exit(1); });
