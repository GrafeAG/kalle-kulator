// scripts/migrate.js — Datenbankschema erstellen
require('dotenv').config();
const { pool } = require('../src/db');

const SCHEMA = `
-- ═══════════════════════════════════════════════════════════════════════
-- KALLE-KULATOR Datenbankschema v1.0
-- PostgreSQL
-- ═══════════════════════════════════════════════════════════════════════

-- Erweiterungen
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── BEARBEITER ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bearbeiter (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  kuerzel      TEXT NOT NULL UNIQUE,
  email        TEXT,
  telefon      TEXT,
  aktiv        BOOLEAN NOT NULL DEFAULT TRUE,
  erstellt_am  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── KUNDEN ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kunden (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  kontaktperson   TEXT,
  email           TEXT,
  telefon         TEXT,
  adresse         TEXT,
  sl_kundennr     TEXT,         -- SelectLine Kundennummer (für späteren Export)
  notiz           TEXT,
  erstellt_am     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  geaendert_am    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── PROJEKTE ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projekte (
  id              SERIAL PRIMARY KEY,
  kunde_id        INTEGER REFERENCES kunden(id) ON DELETE SET NULL,
  projektnr       TEXT UNIQUE,
  ort             TEXT,
  strasse         TEXT,
  objektname      TEXT,
  ordnerpfad      TEXT,         -- absoluter Pfad auf Netzlaufwerk
  status          TEXT NOT NULL DEFAULT 'offen'
                  CHECK (status IN ('offen','angebot','bestellung','abgeschlossen','storniert')),
  notiz           TEXT,
  erstellt_von    TEXT,
  erstellt_am     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  geaendert_am    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── OFFERTEN ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS offerten (
  id              SERIAL PRIMARY KEY,
  projekt_id      INTEGER REFERENCES projekte(id) ON DELETE SET NULL,
  kunde_id        INTEGER REFERENCES kunden(id) ON DELETE SET NULL,
  auftragsnr      TEXT NOT NULL UNIQUE,
  bearbeiter      TEXT,
  bearbeiter_kuerzel TEXT,
  datum           DATE NOT NULL DEFAULT CURRENT_DATE,
  gueltig_bis     DATE,
  total_netto     NUMERIC(12,2) NOT NULL DEFAULT 0,
  mwst_betrag     NUMERIC(12,2) GENERATED ALWAYS AS (ROUND(total_netto * 0.081, 2)) STORED,
  total_brutto    NUMERIC(12,2) GENERATED ALWAYS AS (ROUND(total_netto * 1.081, 2)) STORED,
  status          TEXT NOT NULL DEFAULT 'entwurf'
                  CHECK (status IN ('entwurf','gesendet','bestellt','abgelehnt','storniert')),
  pdf_pfad        TEXT,         -- Pfad zur PDF auf Netzlaufwerk
  sl_exportiert   BOOLEAN NOT NULL DEFAULT FALSE,
  sl_export_am    TIMESTAMPTZ,
  bemerkung       TEXT,
  payload         JSONB NOT NULL,  -- vollständiger KALLE-JSON (für Restore)
  erstellt_am     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  geaendert_am    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── POSITIONEN ───────────────────────────────────────────────────────────
-- Normalisiert für Reporting / Auswertungen
CREATE TABLE IF NOT EXISTS positionen (
  id              SERIAL PRIMARY KEY,
  offerte_id      INTEGER NOT NULL REFERENCES offerten(id) ON DELETE CASCADE,
  pos_nr          INTEGER NOT NULL,
  typ             TEXT NOT NULL,  -- schild/fraes/folientechnik/gravur/montage/text/rabatt
  bezeichnung     TEXT,
  menge           INTEGER NOT NULL DEFAULT 1,
  einzelpreis     NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_vk        NUMERIC(12,2) NOT NULL DEFAULT 0,
  details         JSONB          -- typ-spezifische Details
);

-- ── PREISLISTE (versioniert) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS preislisten (
  id              SERIAL PRIMARY KEY,
  version         TEXT,
  payload         JSONB NOT NULL,      -- vollständige kalle-preise.json
  erstellt_von    TEXT,
  aktiv           BOOLEAN NOT NULL DEFAULT FALSE,
  erstellt_am     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── PROJEKT-DATEIEN ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projekt_dateien (
  id              SERIAL PRIMARY KEY,
  projekt_id      INTEGER NOT NULL REFERENCES projekte(id) ON DELETE CASCADE,
  offerte_id      INTEGER REFERENCES offerten(id) ON DELETE SET NULL,
  typ             TEXT NOT NULL,  -- offerte_pdf/offerte_json/anfrage_email/dokument
  dateiname       TEXT NOT NULL,
  pfad            TEXT NOT NULL,
  groesse_bytes   INTEGER,
  hochgeladen_von TEXT,
  hochgeladen_am  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── AUDIT LOG ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id              SERIAL PRIMARY KEY,
  tabelle         TEXT,
  datensatz_id    INTEGER,
  aktion          TEXT NOT NULL,  -- erstellt/geaendert/geloescht/gesendet/exportiert
  bearbeiter      TEXT,
  vorher          JSONB,
  nachher         JSONB,
  zeitpunkt       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── INDIZES ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_offerten_auftragsnr ON offerten(auftragsnr);
CREATE INDEX IF NOT EXISTS idx_offerten_kunde      ON offerten(kunde_id);
CREATE INDEX IF NOT EXISTS idx_offerten_status     ON offerten(status);
CREATE INDEX IF NOT EXISTS idx_offerten_datum      ON offerten(datum DESC);
CREATE INDEX IF NOT EXISTS idx_positionen_offerte  ON positionen(offerte_id);
CREATE INDEX IF NOT EXISTS idx_projekte_projektnr  ON projekte(projektnr);
CREATE INDEX IF NOT EXISTS idx_projekte_status     ON projekte(status);
CREATE INDEX IF NOT EXISTS idx_audit_zeitpunkt     ON audit_log(zeitpunkt DESC);
CREATE INDEX IF NOT EXISTS idx_offerten_payload    ON offerten USING GIN(payload);

-- ── TRIGGER: geaendert_am automatisch aktualisieren ─────────────────────
CREATE OR REPLACE FUNCTION update_geaendert_am()
RETURNS TRIGGER AS $$
BEGIN
  NEW.geaendert_am = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_offerten_geaendert ON offerten;
CREATE TRIGGER trg_offerten_geaendert
  BEFORE UPDATE ON offerten
  FOR EACH ROW EXECUTE FUNCTION update_geaendert_am();

DROP TRIGGER IF EXISTS trg_kunden_geaendert ON kunden;
CREATE TRIGGER trg_kunden_geaendert
  BEFORE UPDATE ON kunden
  FOR EACH ROW EXECUTE FUNCTION update_geaendert_am();

DROP TRIGGER IF EXISTS trg_projekte_geaendert ON projekte;
CREATE TRIGGER trg_projekte_geaendert
  BEFORE UPDATE ON projekte
  FOR EACH ROW EXECUTE FUNCTION update_geaendert_am();
`;

async function migrate() {
  console.log('═══════════════════════════════════════');
  console.log('  KALLE-KULATOR Datenbank Migration');
  console.log('═══════════════════════════════════════');

  try {
    await pool.query(SCHEMA);
    console.log('✓ Schema erfolgreich erstellt / aktualisiert');
    console.log('\nTabellen:');
    const tables = await pool.query(`
      SELECT tablename, pg_size_pretty(pg_total_relation_size(tablename::text)) as groesse
      FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    tables.rows.forEach(r => console.log(`  • ${r.tablename.padEnd(20)} ${r.groesse}`));
  } catch (err) {
    console.error('✗ Fehler:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
