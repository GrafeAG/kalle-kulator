// terminstatus.js — setzt am Projekt (Hauptboard) den "Terminstatus" 🔴/🟢
// Regel: 🔴 Überfällig, wenn IRGENDEIN Subelement einen Termin (Datum) in der
//         Vergangenheit hat UND nicht "Fertig"/"Brauchts nicht" ist UND nicht
//         "Anfrage eingegangen" heisst. Sonst 🟢 OK.
//
// Optimiert für häufige Läufe: schreibt NUR Projekte, deren Status sich ändert
// (alle anderen werden nur gelesen). Dadurch kann der Job alle paar Minuten laufen.
//
// Läuft komplett serverseitig (Monday-Token aus der .env, verlässt den Server nie).
//   Einmal/periodisch:  node scripts/terminstatus.js
// Für schnelle Aktualisierung alle 2 Min per Aufgabenplanung / cron (siehe LIESMICH.txt).
//
// Voraussetzung in .env:  MONDAY_TOKEN=<Monday-API-Token>
//
// NEU: Jeder Lauf schreibt in eine Logdatei (…/terminstatus.log) und in
//      …/terminstatus_last.txt (nur die letzte Zeile). Damit sieht man sofort,
//      OB und WANN der Job zuletzt lief und ob er Fehler hatte — auch wenn er
//      per Aufgabenplanung läuft (dort landet die Konsolenausgabe sonst nirgends).

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

// ── Logging in Datei (neben der .env im kalle-server-Stamm) ────────────────
const LOG_FILE  = path.join(__dirname, '..', 'terminstatus.log');
const LAST_FILE = path.join(__dirname, '..', 'terminstatus_last.txt');
const MAX_LOG_LINES = 500;                  // Log rollt, damit es nicht endlos wächst

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

// .env robust laden: absoluter Pfad relativ zum Skript (…/scripts/terminstatus.js → …/.env),
// damit der Job unabhängig vom Arbeitsverzeichnis der Aufgabenplanung funktioniert.
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (e) {}
try { if(!process.env.MONDAY_TOKEN) require('dotenv').config(); } catch (e) {}

const TOKEN = process.env.MONDAY_TOKEN;
if (!TOKEN) {
  log('[Terminstatus] FEHLER: MONDAY_TOKEN fehlt — .env nicht gefunden? Skript in …/scripts/ ablegen, .env im kalle-server-Stamm.');
  process.exit(1);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const TODAY = todayStr();

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

function subOverdue(s) {
  const name = (s.name || '').trim();
  if (name === IGNORE_SUB) return false;
  const cv = {};
  (s.column_values || []).forEach(c => { cv[c.id] = c.text || ''; });
  const st = cv[SUB_STATUS] || '';
  const dt = cv[SUB_DATE]   || '';
  if (DONE.has(st)) return false;
  if (!dt) return false;
  return dt.slice(0, 10) < TODAY;            // ISO-Datum: lexikografisch = chronologisch
}

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
              column_values(ids:["${COL_STATUS}"]){ text }
              subitems{ name column_values(ids:["${SUB_DATE}","${SUB_STATUS}"]){ id text } }
            }
          }
        }
      }`, { cursor });
    const page = data.boards[0].items_page;
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

async function setStatuses(updates) {
  const CHUNK = 40;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const parts = slice.map((u, j) =>
      `a${j}: change_simple_column_value(board_id:${BOARD}, item_id:${u.id}, column_id:"${COL_STATUS}", value:"${u.value}"){id}`
    );
    await gql(`mutation{ ${parts.join(' ')} }`);
  }
}

(async () => {
  const items = await fetchAllProjects();
  let red = 0, ok = 0;
  const updates = [];
  for (const it of items) {
    const isRed = (it.subitems || []).some(subOverdue);
    if (isRed) red++; else ok++;
    const current = ((it.column_values && it.column_values[0] && it.column_values[0].text) || '').trim();
    const wantText = isRed ? TEXT_RED : TEXT_OK;
    if (current !== wantText) updates.push({ id: it.id, value: isRed ? LABEL_RED : LABEL_OK });
  }
  await setStatuses(updates);
  log(`[Terminstatus ${TODAY}] ${items.length} Projekte · 🔴 ${red} · 🟢 ${ok} · geändert: ${updates.length}`);
})().catch(e => {
  log('[Terminstatus] FEHLER beim Lauf: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
