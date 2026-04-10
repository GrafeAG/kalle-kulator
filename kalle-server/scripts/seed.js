// scripts/seed.js — Grunddaten einspielen (Bearbeiter)
require('dotenv').config();
const { pool } = require('../src/db');

const BEARBEITER = [
  { name: 'Sven Kurtz',          kuerzel: 'SKU', email: 'sven.kurtz@grafe.ch',          telefon: '061 421 24 02' },
  { name: 'Leonie Bröcher',      kuerzel: 'LBR', email: 'leonie.broecher@grafe.ch',      telefon: '061 561 59 07' },
  { name: 'Daniel Dettwiler',    kuerzel: 'DDE', email: 'daniel.dettwiler@grafe.ch',     telefon: '076 585 57 71' },
  { name: 'Alex Gleissberg',     kuerzel: 'AGL', email: 'alex.gleissberg@grafe.ch',      telefon: '061 421 23 18' },
  { name: 'Claudia Portmann',    kuerzel: 'CPO', email: 'claudia.portmann@grafe.ch',     telefon: '061 561 59 03' },
  { name: 'Marc Reisenauer',     kuerzel: 'MRE', email: 'marc.reisenauer@grafe.ch',      telefon: '061 421 36 69' },
  { name: 'Benjamin Scheuring',  kuerzel: 'BSC', email: 'benjamin.scheuring@grafe.ch',   telefon: '061 561 59 01' },
  { name: 'Jessica Schlienger',  kuerzel: 'JSC', email: 'jessica.schlienger@grafe.ch',   telefon: '061 561 59 04' },
];

async function seed() {
  console.log('Bearbeiter einspielen...');
  for (const b of BEARBEITER) {
    await pool.query(`
      INSERT INTO bearbeiter (name, kuerzel, email, telefon)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (kuerzel) DO UPDATE SET name=$1, email=$3, telefon=$4
    `, [b.name, b.kuerzel, b.email, b.telefon]);
    console.log(`  ✓ ${b.name} (${b.kuerzel})`);
  }
  console.log('Fertig.');
  await pool.end();
}

seed().catch(e => { console.error(e); process.exit(1); });
