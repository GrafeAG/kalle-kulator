// scripts/nachfassen_erstellen.js
// Erstellt automatisch ein Subitem "Nachfassen beim Kunde" auf der GRAFE
// Produktionsübersicht, sobald der Haupt-Status auf "Offerte ist raus" steht.
// Läuft SOFORT (kein Warten auf eine Monday-Automations-Verzögerung — die
// unterstützt beim Datum-Setzen nur "Heute", kein "+X Tage"). Das Fälligkeits-
// datum wird hier direkt korrekt berechnet: heute + FAELLIG_TAGE.
// Bearbeiter des Subitems = die Person, die den Status-Wechsel auf "Offerte
// ist raus" tatsächlich ausgelöst hat (per Activity-Log ermittelt) — nicht
// zwingend der Projektleiter, falls jemand anderes den Status gesetzt hat.
// Subitem-Status wird direkt auf "Geplant" gesetzt.
//
// Voraussetzung: MONDAY_TOKEN in der .env (wie bei den anderen Monday-Jobs).
// Idempotent: legt pro Hauptelement nur EIN Subitem mit diesem Namen an,
// auch wenn der Job mehrfach über denselben Status-Wechsel läuft.
//
// Start: von server.js aus wie terminstatus.js / email_updates.js aufgerufen.

const MONDAY_API = 'https://api.monday.com/v2';
const MONDAY_VER = '2024-01';
const BOARD_PRODUKTION = 1012481465; // GRAFE Produktionsübersicht
const STATUS_LABEL = 'Offerte ist raus';
const SUBITEM_NAME = 'Nachfassen beim Kunde';
const SUBITEM_STATUS = 'Geplant';
const FAELLIG_TAGE = 7;
const INTERVAL_MS = 5 * 60 * 1000; // alle 5 Minuten — unkritisch genug, kein 2-Min-Takt nötig

let cachedStatusIndex = null; // Label-Index von "Offerte ist raus", einmal aufgelöst und gecacht

async function mq(query, variables) {
  const tok = process.env.MONDAY_TOKEN;
  if (!tok) throw new Error('MONDAY_TOKEN fehlt in .env');
  const r = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': tok, 'API-Version': MONDAY_VER },
    body: JSON.stringify({ query, variables: variables || {} })
  });
  if (!r.ok) throw new Error('Monday HTTP ' + r.status);
  const d = await r.json();
  if (d.errors) throw new Error((d.errors[0] && d.errors[0].message) || 'Monday API Fehler');
  return d.data;
}

// Löst den Label-Index von "Offerte ist raus" live gegen die Board-Struktur auf
// (statt einen Index hart zu codieren, der sich ändert, falls die Status-Spalte
// mal umsortiert wird). Ergebnis wird für die Laufzeit des Prozesses gecacht.
async function resolveStatusIndex() {
  if (cachedStatusIndex !== null) return cachedStatusIndex;
  const query = `query($board:[ID!]){
    boards(ids:$board){ columns(ids:["status"]){ settings_str } }
  }`;
  const data = await mq(query, { board: [String(BOARD_PRODUKTION)] });
  const settings = JSON.parse(data.boards[0].columns[0].settings_str);
  // settings.labels ist ein Objekt {"17":"Offerte ist raus", ...} — kein Array
  const entry = Object.entries(settings.labels || {}).find(([, label]) => label === STATUS_LABEL);
  if (!entry) throw new Error(`Status-Label "${STATUS_LABEL}" nicht gefunden — wurde die Spalte umbenannt?`);
  cachedStatusIndex = Number(entry[0]);
  return cachedStatusIndex;
}

// Alle Items mit Status "Offerte ist raus" inkl. vorhandenen Subitem-Namen.
// Zwei getrennte Queries für erste/Folgeseiten — Monday erlaubt query_params
// nur auf der ersten Seite, nicht kombiniert mit einem Cursor (auch nicht als
// ungenutzte Variable). Siehe gleicher Fix in src/routes/controlling.js.
async function fetchKandidaten(statusIndex) {
  let items = [];
  let cursor = null;
  const firstQuery = `query($board:[ID!], $idx:CompareValue!){
    boards(ids:$board){
      items_page(limit:100, query_params:{rules:[{column_id:"status", compare_value:$idx, operator:any_of}]}){
        cursor
        items{ id name subitems{ id name } }
      }
    }
  }`;
  const nextQuery = `query($board:[ID!], $cursor:String!){
    boards(ids:$board){
      items_page(limit:100, cursor:$cursor){
        cursor
        items{ id name subitems{ id name } }
      }
    }
  }`;
  do {
    const query = cursor ? nextQuery : firstQuery;
    const variables = cursor
      ? { board: [String(BOARD_PRODUKTION)], cursor }
      : { board: [String(BOARD_PRODUKTION)], idx: [statusIndex] };
    const data = await mq(query, variables);
    const page = data.boards[0].items_page;
    items = items.concat(page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

// Wer hat den Status-Wechsel auf "Offerte ist raus" für dieses Item zuletzt
// ausgelöst? Per Activity-Log ermittelt (nicht per Projektleiter-Feld, das
// könnte jemand ganz anderes sein). Gibt die Monday-User-ID zurück oder null,
// falls kein passender Log-Eintrag gefunden wird (z.B. sehr alter Wechsel,
// ausserhalb des Activity-Log-Zeitraums, oder Import ohne Nutzerkontext).
async function findeAusloeser(itemId, statusIndex) {
  const query = `query($board:[ID!], $items:[ID!]){
    boards(ids:$board){
      activity_logs(item_ids:$items, column_ids:["status"], limit:50){ created_at user_id data }
    }
  }`;
  const data = await mq(query, { board: [String(BOARD_PRODUKTION)], items: [String(itemId)] });
  const logs = (data.boards[0] && data.boards[0].activity_logs) || [];
  const treffer = logs
    .map(l => {
      let idx = null;
      try { idx = JSON.parse(l.data).value.label.index; } catch (e) { /* Eintrag ohne verwertbare Daten */ }
      return { ...l, idx };
    })
    .filter(l => l.idx === statusIndex)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return treffer.length ? treffer[0].user_id : null;
}

function faelligDatum() {
  const d = new Date();
  d.setDate(d.getDate() + FAELLIG_TAGE);
  return d.toISOString().slice(0, 10);
}

async function erstelleNachfassSubitem(item, statusIndex) {
  const ausloeserId = await findeAusloeser(item.id, statusIndex);

  const columnValues = {
    date0: { date: faelligDatum() },
    status: { label: SUBITEM_STATUS }
  };
  if (ausloeserId) {
    columnValues.person = { personsAndTeams: [{ id: Number(ausloeserId), kind: 'person' }] };
  }

  const mutation = `mutation($parent:ID!, $name:String!, $colvals:JSON){
    create_subitem(parent_item_id:$parent, item_name:$name, column_values:$colvals){ id }
  }`;
  await mq(mutation, {
    parent: String(item.id),
    name: SUBITEM_NAME,
    colvals: JSON.stringify(columnValues)
  });
}

async function run() {
  try {
    const statusIndex = await resolveStatusIndex();
    const items = await fetchKandidaten(statusIndex);
    let erstellt = 0;
    for (const item of items) {
      const hatSchon = (item.subitems || []).some(s => s.name === SUBITEM_NAME);
      if (hatSchon) continue;
      await erstelleNachfassSubitem(item, statusIndex);
      erstellt++;
    }
    if (erstellt > 0) console.log(`[nachfassen] ${erstellt} neue "${SUBITEM_NAME}"-Subitem(s) erstellt (fällig in ${FAELLIG_TAGE} Tagen)`);
  } catch (e) {
    console.error('[nachfassen] Fehler:', e.message);
  }
}

function start() {
  if (!process.env.MONDAY_TOKEN) {
    console.warn('⚠ Nachfassen-Job NICHT gestartet — MONDAY_TOKEN fehlt in .env');
    return;
  }
  setTimeout(run, 30 * 1000); // erster Lauf 30s nach Serverstart
  setInterval(run, INTERVAL_MS);
  console.log(`✓ Nachfassen-Job aktiv (alle 5 Min, Fälligkeit +${FAELLIG_TAGE} Tage)`);
}

module.exports = { start };

