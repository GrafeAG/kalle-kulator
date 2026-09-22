// scripts/migrate_mailversand.js — Signatur-Felder in bestehender bearbeiter-Tabelle ergänzen
// Aufruf:  node scripts/migrate_mailversand.js
require('dotenv').config();
const { pool } = require('../src/db');

async function run() {
  console.log('═══════════════════════════════════════════');
  console.log('  KALLE — Mailversand Migration (bearbeiter)');
  console.log('═══════════════════════════════════════════');

  // bearbeiter.email existiert bereits (siehe routes/bearbeiter.js) und wird als
  // M365-UPN verwendet -- KEINE neue Tabelle, nur zwei zusätzliche Spalten.
  await pool.query(`
    ALTER TABLE bearbeiter
      ADD COLUMN IF NOT EXISTS signatur_html TEXT,
      ADD COLUMN IF NOT EXISTS mail_aktiv    BOOLEAN NOT NULL DEFAULT false;
  `);

  const c = await pool.query(
    `SELECT kuerzel, email, mail_aktiv, (signatur_html IS NOT NULL) AS hat_signatur
     FROM bearbeiter ORDER BY name`
  );
  console.log('✓ Spalten ergänzt. Aktueller Stand:');
  c.rows.forEach(r => {
    console.log(`  • ${(r.kuerzel||'').padEnd(6)} ${(r.email||'(keine E-Mail hinterlegt)').padEnd(32)} mail_aktiv=${r.mail_aktiv}  signatur=${r.hat_signatur}`);
  });
  console.log('');
  console.log('WICHTIG: mail_aktiv steht für ALLE Bearbeiter auf false. Erst auf true');
  console.log('setzen, sobald die Exchange Application Access Policy (Josh) für das');
  console.log('jeweilige Postfach bestätigt UND die Signatur im Cockpit gepflegt ist --');
  console.log('siehe MAILVERSAND_Integration.md Abschnitt 5 (Prüfkriterium).');
  await pool.end();
}

run().catch(e => { console.error('✗ Fehler:', e.message); process.exit(1); });
