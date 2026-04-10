// src/server.js — KALLE-KULATOR Backend Server
// Node.js + Express + PostgreSQL
require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const morgan      = require('morgan');
const path        = require('path');
const { testConnection } = require('./db');

const app  = express();
const PORT = process.env.PORT || 8765;

// ── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('[:date[clf]] :method :url :status :response-time ms'));

// ── STATISCHE DATEIEN (KALLE-KULATOR.html) ───────────────────────────────
// KALLE.html liegt in /public/index.html
// Aufruf: http://kalle.grafe.local:8765/
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API ROUTES ────────────────────────────────────────────────────────────
app.use('/status',       require('./routes/status'));
app.use('/preise',       require('./routes/preise'));
app.use('/offerten',     require('./routes/offerten'));
app.use('/projekte',     require('./routes/projekte'));
app.use('/bearbeiter',   require('./routes/bearbeiter'));
app.use('/auswertungen', require('./routes/auswertungen'));

// ── 404 / ERROR HANDLER ───────────────────────────────────────────────────
app.use((req, res) => {
  // API-Routen: JSON
  if (req.path.startsWith('/api') || req.headers.accept?.includes('application/json')) {
    return res.status(404).json({ error: `Route nicht gefunden: ${req.path}` });
  }
  // Alles andere → index.html (Single Page App)
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[Server] Fehler:', err.message);
  res.status(500).json({ error: 'Interner Serverfehler', details: err.message });
});

// ── START ─────────────────────────────────────────────────────────────────
async function start() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  KALLE-KULATOR Backend Server v2.0');
  console.log('═══════════════════════════════════════════════════');

  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('✗ DB-Verbindung fehlgeschlagen — .env prüfen');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✓ KALLE App:   http://localhost:${PORT}/`);
    console.log(`✓ API Status:  http://localhost:${PORT}/status`);
    console.log(`✓ Datenbank:   ${process.env.DB_HOST || 'localhost'}/${process.env.DB_NAME || 'kalle'}`);
    console.log(`✓ Netzlaufwerk: ${process.env.OFFERTEN_PFAD || '(nicht konfiguriert)'}`);
    console.log('═══════════════════════════════════════════════════');
  });
}

start();
