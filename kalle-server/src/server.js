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
app.use('/kunden',       require('./routes/kunden'));
app.use('/auswertungen', require('./routes/auswertungen'));

// ── NEU: Monday-Datei-Upload (Dateien/Offerte-PDF an Monday-Item hängen) ──
// Abgesichert: fehlt src/routes/monday.js, startet der Server trotzdem (nur diese
// Route ist dann inaktiv), statt beim Start abzustürzen.
try {
  app.use('/monday', require('./routes/monday'));
  console.log('✓ Route /monday aktiv');
} catch (e) {
  console.warn('⚠ Route /monday NICHT geladen — fehlt src/routes/monday.js? (' + e.message + ')');
}

// ── NEU: Projekt löschen (Monday-Item + Offerte + Nummer freigeben + Ordner) ──
try {
  app.use('/projekt-loeschen', require('./routes/projekt_loeschen'));
  console.log('✓ Route /projekt-loeschen aktiv');
} catch (e) {
  console.warn('⚠ Route /projekt-loeschen NICHT geladen — fehlt src/routes/projekt_loeschen.js? (' + e.message + ')');
}

// ── NEU: SharePoint-Ordneranlage (Microsoft Graph, App REACTOR-Server) ────
try {
  app.use(require('./routes/cloud'));
  console.log('✓ Route /cloud/ordner aktiv');
} catch (e) {
  console.warn('⚠ Route /cloud NICHT geladen — fehlt src/routes/cloud.js? (' + e.message + ')');
}

// ── Montage-Laufzettel-Generator (QR-Label, Live-Daten aus Monday) ────────
// Wieder ergänzt — war beim letzten server.js-Ersatz versehentlich verloren
// gegangen. Voraussetzung: src/routes/label.js vorhanden + MONDAY_TOKEN in .env.
try {
  app.use('/label', require('./routes/label'));
  console.log('✓ Route /label aktiv');
} catch (e) {
  console.warn('⚠ Route /label NICHT geladen — fehlt src/routes/label.js? (' + e.message + ')');
}

// ── NEU: Montage-Rückmeldung — KI-Zerlegung in Monday-Subelemente + SharePoint-Fotos ──
try {
  app.use(require('./routes/montage'));
  console.log('✓ Route /montage/melden aktiv');
} catch (e) {
  console.warn('⚠ Route /montage NICHT geladen — fehlt src/routes/montage.js? (' + e.message + ')');
}

// ── NEU: E-Mail-Analyse für die Anfrage-Erfassung (analyse.js) ───────────
// Fehlte bisher komplett in server.js — nur die GET /analyse/zusammenfassung-
// Route (Cockpit-Kurzzusammenfassung, siehe unten) war gemountet, die
// eigentliche POST /analyse-Route (Kontakterkennung aus der Anfrage-Mail,
// von analyseWithServer() im Frontend aufgerufen) lief dadurch ins Leere
// (404 → SPA-Fallback lieferte index.html statt JSON zurück). Root Cause
// des "Zusammenfassung fehlt"-Bugs vom 16.09.2026 — nicht max_tokens allein,
// die Route war schlicht nie erreichbar. Beide /analyse-Router vertragen
// sich (Express probiert POST / bzw. GET /zusammenfassung der Reihe nach
// durch, kein Konflikt), müssen aber BEIDE gemountet sein.
try {
  app.use('/analyse', require('./routes/analyse'));
  console.log('✓ Route /analyse aktiv');
} catch (e) {
  console.warn('⚠ Route /analyse NICHT geladen — fehlt src/routes/analyse.js? (' + e.message + ')');
}

// ── NEU: KI-Kurzzusammenfassung fürs Cockpit (analyse_zusammenfassung.js) ──
// Eigene Route, unabhängig von einer eventuell separat gemounteten /analyse-
// Route für die Mail-Analyse — Express probiert beide GET-Pfade der Reihe
// nach durch, kein Konflikt. Voraussetzung: ANTHROPIC_API_KEY + MONDAY_TOKEN
// in der .env (beide bereits für Mail-Analyse bzw. Monday-Anbindung vorhanden).
try {
  app.use('/analyse', require('./routes/analyse_zusammenfassung'));
  console.log('✓ Route /analyse/zusammenfassung aktiv');
} catch (e) {
  console.warn('⚠ Route /analyse/zusammenfassung NICHT geladen — fehlt src/routes/analyse_zusammenfassung.js? (' + e.message + ')');
}

// ── NEU: Mail-Entwurf-Abruf für den grafemail:-Helfer + Bestätigung nach Versand ──
try {
  app.use('/reply', require('./routes/reply'));
  console.log('✓ Route /reply aktiv');
} catch (e) {
  console.warn('⚠ Route /reply NICHT geladen — fehlt src/routes/reply.js oder src/lib/replyStore.js? (' + e.message + ')');
}

// ── NEU: Offerte nachfassen — generiert einen spezifischen Mailentwurf per KI ──
try {
  app.use('/nachfassen', require('./routes/nachfassen'));
  console.log('✓ Route /nachfassen aktiv');
} catch (e) {
  console.warn('⚠ Route /nachfassen NICHT geladen — fehlt src/routes/nachfassen.js? (' + e.message + ')');
}

// ── NEU: Mailversand über Microsoft Graph (App-only) — löst den grafemail:-
// Helfer ab, siehe MAILVERSAND_Spec.md / MAILVERSAND_Integration.md
// (Richtungsentscheid 22.09.2026). Voraussetzung: src/mailGraph.js,
// MAIL_GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET in der .env, sowie die
// signatur_html/mail_aktiv-Spalten in der bearbeiter-Tabelle (siehe
// scripts/migrate_mailversand.js).
try {
  app.use('/mail', require('./routes/mail'));
  console.log('✓ Route /mail aktiv');
} catch (e) {
  console.warn('⚠ Route /mail NICHT geladen — fehlt src/routes/mail.js oder src/mailGraph.js? (' + e.message + ')');
}

// ── NEU: Zentrale Vorgangsnummern-Vergabe (26xxxx) — reservieren/commit/freigeben ──
// Fehlte bisher komplett in server.js, exakt derselbe Fehler wie zuvor bei
// analyse.js: die Datei existierte und war korrekt, wurde aber nie gemountet.
// POST /nummern/reservieren lief dadurch ins Leere (404 → SPA-Fallback lieferte
// index.html statt JSON) — betraf sowohl den Reactor selbst als auch die Beta
// (rxErfassen()/reserveVorgangsnummer() rufen denselben Endpoint auf), blockierte
// dadurch vermutlich jede neue Anfrage-Erfassung komplett. Gefunden am 16.09.2026
// beim Live-Test der neuen Projektnummer-Live-Anzeige in der Beta.
try {
  app.use('/nummern', require('./routes/nummern'));
  console.log('✓ Route /nummern aktiv');
} catch (e) {
  console.warn('⚠ Route /nummern NICHT geladen — fehlt src/routes/nummern.js? (' + e.message + ')');
}

// ── NEU: Cockpit-Controlling — wöchentliche Monday-Auswertung (Leads/Anfragen/
// Offerten/Produktion/Sales-Performance/Nachfassquote), 1x täglich gecacht ──
try {
  app.use('/controlling', require('./routes/controlling'));
  console.log('✓ Route /controlling aktiv');
} catch (e) {
  console.warn('⚠ Route /controlling NICHT geladen — fehlt src/routes/controlling.js? (' + e.message + ')');
}

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

    // ── NEU: Terminstatus-Ampel direkt im Server (alle 2 Min) ─────────────
    // Startet den Ampel-Job, sobald der Server läuft. Abgesichert: fehlt
    // scripts/terminstatus.js, läuft der Server normal weiter (nur ohne Job).
    // Voraussetzung: scripts/terminstatus.js vorhanden + MONDAY_TOKEN in der .env.
    try {
      require('../scripts/terminstatus').start();
    } catch (e) {
      console.warn('⚠ Terminstatus-Job NICHT gestartet — fehlt scripts/terminstatus.js oder MONDAY_TOKEN? (' + e.message + ')');
    }

    // ── NEU: E-Mail→Monday-Kommentar-Job direkt im Server (alle 2 Min) ────
    // Ersetzt die frühere externe Windows-Aufgabe (ging bei einem Server-Umbau
    // verloren, siehe scripts/email_updates.js Kopfkommentar). Läuft jetzt wie
    // die Terminstatus-Ampel als Teil des KALLE-Servers selbst — start() prüft
    // intern MONDAY_TOKEN + @kenjiuno/msgreader und meldet sich nur mit einer
    // Warnung statt den Server zu stoppen, falls Voraussetzungen fehlen.
    try {
      require('../scripts/email_updates').start();
    } catch (e) {
      console.warn('⚠ E-Mail-Updates-Job NICHT gestartet — fehlt scripts/email_updates.js? (' + e.message + ')');
    }

    // ── NEU: Nachfassen-beim-Kunde-Job (alle 5 Min) ───────────────────────
    // Legt automatisch das Subitem "Nachfassen beim Kunde" auf der GRAFE
    // Produktionsübersicht an, sobald der Status auf "Offerte ist raus" steht
    // — sofort, mit Fälligkeit = heute + 7 Tage direkt berechnet (Monday-
    // Automationen können beim Datum-Setzen nur "Heute", kein "+X Tage").
    // Voraussetzung: scripts/nachfassen_erstellen.js vorhanden + MONDAY_TOKEN.
    try {
      require('../scripts/nachfassen_erstellen').start();
    } catch (e) {
      console.warn('⚠ Nachfassen-Job NICHT gestartet — fehlt scripts/nachfassen_erstellen.js? (' + e.message + ')');
    }
  });
}

start();
