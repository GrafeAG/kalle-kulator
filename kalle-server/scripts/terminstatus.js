// terminstatus.js — setzt am Projekt (Hauptboard) den "Terminstatus" 🔴/🟢
//
// Regel: 🔴 Überfällig, wenn IRGENDEIN Subelement einen Termin (Datum) in der
//         Vergangenheit hat UND nicht "Fertig"/"Brauchts nicht" ist UND nicht
//         "Anfrage eingegangen" heisst. Sonst 🟢 OK.
//
// NEU (wichtig): Die Ampel gilt NUR für die AKTIVEN Produktionsgruppen
//   (Anfragen → Offerprüfung → Vorbereitung → Produktionsplanung →
//    Montageplanung → Produktion → Endkontrolle → Montage).
//   Die Gruppen "Rechnungsstellung" und "Abgeschlossen" werden bewusst NICHT
//   bewertet — dort sind die Projekte erledigt, überfällige Termine wären nur
//   Rauschen (und würden hunderte alte Projekte rot färben). Siehe ALLOWED_GROUPS.
//
// NEU (Ausführung): Dieser Job muss nicht mehr über die Windows-Aufgabenplanung
//   laufen. Am robustesten läuft er DIREKT IM kalle-server mit:
//        require('./scripts/terminstatus').start();      // einmal in server.js
//   Dann rechnet er beim Serverstart sofort und danach alle 2 Minuten — solange
//   der Server läuft (also solange auch die App läuft). Kein externer Scheduler,
//   der stillschweigend ausfallen kann.
//   Weiterhin möglich: einmaliger/manueller Lauf per  node scripts/terminstatus.js
//
// Optimiert: schreibt NUR Projekte, deren Status sich ändert (alle anderen nur lesen).
//
// Voraussetzung in .env:  MONDAY_TOKEN=<Monday-API-Token>
//
// Logdatei: …/terminstatus.log (Verlauf, 500 Zeilen) und …/terminstatus_last.txt
//   (nur die letzte Zeile). So sieht man sofort, OB und WANN der Job zuletzt lief.

const fs   = require('fs');
const path = require('path');

const MONDAY_API = 'https://api.monday.com/v2';
const BOARD      = 1012481465;              // GRAFE Produktionsübersicht (Projekte)
const COL_STATUS = 'color_mm5syzb9';        // Spalte "Terminstatus"
const LABEL_RED  = '2';                     // 🔴 Überfällig  (Label-ID)
const LABEL_OK   = '1';                     // 🟢 OK          (Label-ID)
const TEXT_RED   = '🔴 Überfällig';         // angezeigter Text (für Vergleich)
const TEXT_OK    = '🟢 OK';
const SUB_DATE   = 'date0';                 // Subelement: Datum
const SUB_STATUS = 'status';               // Subelement: Status
const DONE       = new Set(['Fertig', 'Brauchts nicht']);
const IGNORE_SUB = 'Anfrage eingegangen';   // dieses Subelement zählt nie

// ── Nur diese (aktiven) Gruppen bekommen eine Ampel ────────────────────────
//   Bewusst NICHT enthalten:
//     duplicate_of_project_a = "Rechnungsstellung"
//     group_mksw4paf         = "Abgeschlossen"
const ALLOWED_GROUPS = new Set([
  'group_mm5hq91f',   // Projekt und Offertanfragen
  'group_mm5p5zwq',   // Offerprüfung Kunde / Vergabe
  'group_mkt2vn54',   // Vorbereitung
  'new_group29179',   // Produktionsplanung
  'group_mkw1rbx',    // Montageplanung
  'new_group43041',   // Produktion
  'group_mm5h369s',   // Endkontrolle
  'topics',           // Montage
]);

// Wie oft im eingebetteten Betrieb neu gerechnet wird (Millisekunden):
const INTERVAL_MS = 2 * 60 * 1000;          // alle 2 Minuten

// ── Logging in Datei (neben der .env im kalle-server-Stamm) ────────────────
const LOG_FILE  = path.join(__dirname, '..', 'terminstatus.log');
const LAST_FILE = path.join(__dirname, '..', 'terminstatus_last.txt');
const MAX_LOG_LINES = 500;

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  try {
    let prev = '';
    try { prev = fs.readFileSync(LOG_FILE, 'utf8'); } catch (e) {}
    let lines = (prev ? prev.split('\n') : []).filter(Boolean);
    lines.push(line);
    if (lines.length > MAX_LOG_LINES) lines = lines.slice(lines.length - MAX_LOG_LINES);
    fs.writeFileSync(LOG_FILE, lines.join('\n') + '\n');
  } catch (e) { /* Log darf den Job nie stoppen */ }
  try { fs.writeFileSync(LAST_FILE, line + '\n'); } catch (e) {}
  console.log(msg);
}

// .env robust laden (absoluter Pfad relativ zum Skript)
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (e) {}
try { if(!process.env.MONDAY_TOKEN) require('dotenv').config(); } catch (e) {}

const TOKEN = process.env.MONDAY_TOKEN;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function gql(query, variables = {}) {
  const r = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': TOKEN, 'API-Version': '2024-01' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

function subOverdue(s, today) {
  const name = (s.name || '').trim();
  if (name === IGNORE_SUB) return false;
  const cv = {};
  (s.column_values || []).forEach(c => { cv[c.id] = c.text || ''; });
  const st = cv[SUB_STATUS] || '';
  const dt = cv[SUB_DATE]   || '';
  if (DONE.has(st)) return false;
  if (!dt) return false;
  return dt.slice(0, 10) < today;            // ISO-Datum: lexikografisch = chronologisch
}

// Holt alle Projekte MIT Gruppe; behält nur die aktiven Gruppen.
async function fetchAllProjects() {
  const items = [];
  let cursor = null;
  do {
    const data = await gql(`
      query($cursor:String){
        boards(ids:${BOARD}){
          items_page(limit:200, cursor:$cursor){
            cursor
            items{
              id
              group{ id }
              column_values(ids:["${COL_STATUS}"]){ text }
              subitems{ name column_values(ids:["${SUB_DATE}","${SUB_STATUS}"]){ id text } }
            }
          }
        }
      }`, { cursor });
    const page = data.boards[0].items_page;
    for (const it of page.items) {
      if (it.group && ALLOWED_GROUPS.has(it.group.id)) items.push(it);
    }
    cursor = page.cursor;
  } while (cursor);
  return items;
}

async function setStatuses(updates) {
  const CHUNK = 25;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const parts = slice.map((u, j) =>
      `a${j}: change_simple_column_value(board_id:${BOARD}, item_id:${u.id}, column_id:"${COL_STATUS}", value:"${u.value}"){id}`
    );
    await gql(`mutation{ ${parts.join(' ')} }`);
  }
}

// Ein einzelner Durchlauf. Gibt {items, red, ok, changed} zurück.
async function run() {
  const today = todayStr();
  const items = await fetchAllProjects();
  let red = 0, ok = 0;
  const updates = [];
  for (const it of items) {
    const isRed = (it.subitems || []).some(s => subOverdue(s, today));
    if (isRed) red++; else ok++;
    const current = ((it.column_values && it.column_values[0] && it.column_values[0].text) || '').trim();
    const wantText = isRed ? TEXT_RED : TEXT_OK;
    if (current !== wantText) updates.push({ id: it.id, value: isRed ? LABEL_RED : LABEL_OK });
  }
  await setStatuses(updates);
  log(`[Terminstatus ${today}] ${items.length} aktive Projekte · 🔴 ${red} · 🟢 ${ok} · geändert: ${updates.length}`);
  return { items: items.length, red, ok, changed: updates.length };
}

// Eingebetteter Dauerbetrieb: sofort rechnen + alle INTERVAL_MS wiederholen.
// Läufe überlappen nie (Guard). Fehler werden geloggt, der Timer läuft weiter.
let _running = false;
async function tick() {
  if (_running) return;
  _running = true;
  try { await run(); }
  catch (e) { log('[Terminstatus] FEHLER beim Lauf: ' + (e && e.message ? e.message : String(e))); }
  finally { _running = false; }
}
function start(intervalMs = INTERVAL_MS) {
  if (!TOKEN) { log('[Terminstatus] FEHLER: MONDAY_TOKEN fehlt — .env prüfen. Job NICHT gestartet.'); return null; }
  tick();                                   // sofort beim Start
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();           // hält den Prozess nicht künstlich am Leben
  log(`[Terminstatus] eingebetteter Betrieb aktiv — Intervall ${Math.round(intervalMs/1000)}s, ${[...ALLOWED_GROUPS].length} aktive Gruppen.`);
  return timer;
}

module.exports = { start, run, tick, ALLOWED_GROUPS };

// Direkter Aufruf (node scripts/terminstatus.js) → EIN Lauf, dann Ende.
if (require.main === module) {
  if (!TOKEN) {
    log('[Terminstatus] FEHLER: MONDAY_TOKEN fehlt — .env nicht gefunden? Skript in …/scripts/ ablegen, .env im kalle-server-Stamm.');
    process.exit(1);
  }
  run().catch(e => {
    log('[Terminstatus] FEHLER beim Lauf: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  });
}
