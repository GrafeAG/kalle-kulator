// src/routes/controlling.js
// Controlling-Übersicht für KALLE-Cockpit — aggregiert Monday-Daten aus Pipeline
// und GRAFE Produktionsübersicht (inkl. deren Subitems) zu Wochenwerten (letzte ~3 Monate).
// Token: process.env.MONDAY_TOKEN (wie label.js/monday.js).
//
// Stand 20.09.2026: Umgestellt von "Anfragen und Offerten"-Board (18423106800,
// nur 2 Elemente — neu aufgesetztes, kaum genutztes System) auf die
// GRAFE Produktionsübersicht (1012481465, 1485+ Elemente — der tatsächlich
// gelebte Arbeitsablauf, von Sven bestätigt). Anfragen/Offerten-Board wird
// nicht mehr abgefragt.
//
// Routen:
//   GET  /controlling/data            -> letzter gecachter Report (JSON)
//   POST /controlling/refresh         -> stösst Neuberechnung an (async), liefert { jobId }
//   GET  /controlling/refresh/status  -> Fortschritt des laufenden/letzten Jobs
//
// Cache-Datei: data/controlling_cache.json (im Git-Root des Node-Apps, also
// C:\kalle-server\kalle-server\data\controlling_cache.json)
// Automatische Aktualisierung: 60s nach Serverstart, danach alle 24h.

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const MONDAY_API = 'https://api.monday.com/v2';
const MONDAY_VER = '2024-01';
const TOKEN = () => process.env.MONDAY_TOKEN;

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'controlling_cache.json');
const FINANZEN_FILE = path.join(__dirname, '..', '..', 'data', 'finanzen.json');

const BOARDS = {
  pipeline: 908257145,           // Verkauf / Pipeline (Leads)
  produktion: 1012481465,        // GRAFE Produktionsübersicht — echter Arbeitsablauf
  produktionSubitems: 1012481470 // Unterelemente von GRAFE Produktionsübersicht
};

// Gruppen auf der Produktionsübersicht (IDs live abgefragt, nicht geraten)
const GROUPS = {
  anfragen: 'group_mm5hq91f',       // "Projekt und Offertanfragen"
  offertpruefung: 'group_mm5p5zwq', // "Offerprüfung Kunde / Vergabe"
  verloren: 'group_mm7293mg',       // "Verloren / Abgesagt"
  // "In Umsetzung" — bewusst ALLE aktiven Produktionsgruppen, nicht nur die
  // drei in der Design-Vorlage genannten (Vorbereitung/Produktion/Montage),
  // um Produktionsplanung/Montageplanung/Endkontrolle/Versandbereit nicht zu
  // unterschlagen. Bei Bedarf mit Sven auf die engere Auswahl zurückstellen.
  inUmsetzung: ['group_mkt2vn54', 'new_group29179', 'group_mkw1rbx', 'new_group43041', 'group_mm5h369s', 'topics', 'group_mm6csxe1'],
  // "Rechnung / abgeschlossen" — wie in der Design-Vorlage vorgeschlagen
  abgeschlossen: ['duplicate_of_project_a', 'group_mksw4paf']
};

// Subitem-Namen, auf die exakt gefiltert wird (Monday-seitige contains_text-
// Suche, live gegen echte Daten bestätigt)
const SUBITEM_OFFERTE_ERSTELLEN = 'Offerte erstellen';
const SUBITEM_NACHFASSEN = 'Nachfassen beim Kunde'; // ab der neuen Monday-Automation (9 Kalendertage-Näherung an 7 Werktage)
const STATUS_OFFERTE_RAUS = 'Offerte ist raus';      // Haupt-Status-Label auf der Produktionsübersicht
const SUBITEM_STATUS_IN_ARBEIT = 'in Offertstellung'; // Subitem-Status-Label auf "Offerte erstellen"
const SUBITEM_STATUS_FERTIG = 'Fertig';

// Verkauf/Projektleiter, dessen Aktivität laut interner Vereinbarung (4-8
// bearbeitete Leads/Tag) im Sales-Performance-Indikator ausgewertet wird.
// Bewusst nicht namentlich in der UI — dort heisst es "Sales".
const SALES_USER_ID = '18168107';
const SALES_ZIEL_MIN = 4;
const SALES_ZIEL_MAX = 8;

// Fester Startpunkt statt rollendem Wochenfenster — auf Wunsch von Sven soll
// die gesamte Datengrundlage seit dem 01.06.2026 abgebildet werden. Board-
// Activity-Logs haben (anders als die separate User-Activity-Log-API) keine
// 90-Tage-Grenze, das funktioniert also technisch sauber.
const REPORT_START_DATE = '2026-06-01'; // ist selbst ein Montag

let job = null; // { id, progress, step, done, error }

// ─── Monday-GraphQL-Client ───────────────────────────────────────────────
async function mq(query, variables) {
  const tok = TOKEN();
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

// Monday liefert activity_logs.created_at als String in 100ns-Ticks seit Unix-Epoche
// (nicht ISO). Items selbst (created_at/updated_at) liefern normales ISO8601.
function parseMondayTimestamp(ts) {
  if (!ts) return null;
  const s = String(ts);
  if (/^\d{15,}$/.test(s)) return new Date(Number(s) / 1e4);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ISO-Kalenderwoche als Label, z.B. "2026-KW34"
function isoWeekLabel(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() + '-KW' + String(week).padStart(2, '0');
}

// Montag der Kalenderwoche eines Datums (UTC) — für sauberen, vollständigen Wochenrand
function mondayOfWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d;
}

// Werktage (Mo-Fr) einer Kalenderwoche, die nicht in der Zukunft liegen —
// Basis für den Tagesdurchschnitt des Sales-Performance-Indikators
function workdaysOfWeek(mondayDate, today) {
  const days = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(mondayDate);
    d.setUTCDate(d.getUTCDate() + i);
    if (d <= today) days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

// Wochen-Labels vorwärts vom festen Start bis heute (statt rückwärts von
// "jetzt" über eine feste Anzahl) — liefert zugleich die Montage jeder Woche,
// damit Wochenrand-Berechnungen (workdaysOfWeek etc.) exakt bleiben.
function weekListFrom(fromMonday, today) {
  const labels = [];
  const mondays = [];
  const d = new Date(fromMonday);
  while (d <= today) {
    labels.push(isoWeekLabel(d));
    mondays.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return { labels, mondays };
}

// Alle Items eines Boards holen (paginiert), inkl. gewünschter Spalten + Gruppe
async function fetchAllItems(boardId, columnIds) {
  let items = [];
  let cursor = null;
  const colsField = columnIds
    ? `column_values(ids: ${JSON.stringify(columnIds)}) { id text value }`
    : `column_values { id text value }`;
  do {
    const query = `query($board:[ID!], $cursor:String){
      boards(ids:$board){
        items_page(limit:100, cursor:$cursor){
          cursor
          items{ id name created_at updated_at group{ id title } ${colsField} }
        }
      }
    }`;
    const data = await mq(query, { board: [String(boardId)], cursor });
    const page = data.boards[0].items_page;
    items = items.concat(page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

// Subitems eines Boards, deren Name einen Text enthält (serverseitig gefiltert
// via query_params/contains_text — live gegen echte Daten getestet, spart das
// Laden aller ~4500 Subitems nur um z.B. "Offerte erstellen" herauszufiltern).
// Liefert zusätzlich parent_item{id name}, da der Projektname bereits
// Projektnummer+Kunde enthält (kein separater Join nötig).
async function fetchSubitemsByName(boardId, nameContains, columnIds) {
  let items = [];
  let cursor = null;
  const colsField = `column_values(ids: ${JSON.stringify(columnIds)}) { id text value }`;
  // Monday erlaubt query_params NUR auf der ersten Seite — sobald ein Cursor
  // mitgeschickt wird, darf query_params nicht mehr im Request stehen (auch
  // nicht als ungenutzte Variable). Deshalb zwei komplett getrennte Queries
  // statt einer bedingt zusammengesetzten — sonst meckert GraphQL über die
  // dann unbenutzte $name-Variable auf Folgeseiten.
  const firstQuery = `query($board:[ID!], $name:CompareValue!){
    boards(ids:$board){
      items_page(limit:100, query_params:{rules:[{column_id:"name", compare_value:$name, operator:contains_text}]}){
        cursor
        items{ id name created_at updated_at parent_item{ id name } ${colsField} }
      }
    }
  }`;
  const nextQuery = `query($board:[ID!], $cursor:String!){
    boards(ids:$board){
      items_page(limit:100, cursor:$cursor){
        cursor
        items{ id name created_at updated_at parent_item{ id name } ${colsField} }
      }
    }
  }`;
  do {
    const query = cursor ? nextQuery : firstQuery;
    const variables = cursor
      ? { board: [String(boardId)], cursor }
      : { board: [String(boardId)], name: [nameContains] };
    const data = await mq(query, variables);
    const page = data.boards[0].items_page;
    items = items.concat(page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

// Activity-Log eines Boards für Zeitraum + optional Nutzer-Filter (paginiert,
// da activity_logs pro Aufruf begrenzt zurückliefert). includeData liefert das
// "data"-JSON pro Eintrag mit (u.a. pulse_id) — nötig, um eindeutige Leads
// statt nur rohe Events zu zählen.
async function fetchActivity(boardId, fromISO, toISO, userIds, includeData) {
  let logs = [];
  let page = 1;
  const dataField = includeData ? ' data' : '';
  for (;;) {
    const query = `query($board:[ID!], $from:ISO8601DateTime, $to:ISO8601DateTime, $page:Int){
      boards(ids:$board){
        activity_logs(from:$from, to:$to, limit:1000, page:$page){ event created_at user_id entity${dataField} }
      }
    }`;
    const data = await mq(query, { board: [String(boardId)], from: fromISO, to: toISO, page });
    const batch = (data.boards[0] && data.boards[0].activity_logs) || [];
    logs = logs.concat(batch);
    if (batch.length < 1000 || page > 20) break; // Sicherheitsdeckel: max 20'000 Events/Board
    page++;
  }
  if (userIds && userIds.length) logs = logs.filter(l => userIds.includes(String(l.user_id)));
  return logs;
}

// pulse_id aus dem activity_logs "data"-JSON extrahieren (Feldname variiert
// nicht zwischen Event-Typen, aber JSON.parse kann bei kaputten Einträgen
// scheitern — dann wird der Eintrag ignoriert statt den ganzen Report zu killen)
function pulseIdFromActivity(ev) {
  if (!ev.data) return null;
  try { return JSON.parse(ev.data).pulse_id || null; }
  catch (e) { return null; }
}

function cvMap(item) {
  const m = {};
  (item.column_values || []).forEach(c => { m[c.id] = c; });
  return m;
}

function splitNames(text) {
  return (text || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ─── Hauptaggregation ────────────────────────────────────────────────────
async function buildReport(progress) {
  const today = new Date();
  const fromDate = mondayOfWeek(new Date(REPORT_START_DATE)); // fester Start, nicht mehr rollend
  const fromISO = fromDate.toISOString();
  const toISO = today.toISOString();

  progress(5, 'Lade Pipeline-Board (Leads)...');
  const pipelineItems = await fetchAllItems(BOARDS.pipeline, ['status', 'person', 'people', 'creation_log']);

  progress(25, 'Lade GRAFE Produktionsübersicht...');
  const produktionItems = await fetchAllItems(BOARDS.produktion, ['text_mkv7v7m6', 'text_mm5hbe90', 'people0', 'status']);

  progress(45, 'Lade Subitems "Offerte erstellen"...');
  const offerteErstellenItems = await fetchSubitemsByName(BOARDS.produktionSubitems, SUBITEM_OFFERTE_ERSTELLEN, ['person', 'status', 'date0']);

  progress(55, 'Lade Subitems "Nachfassen beim Kunde"...');
  const nachfassItems = await fetchSubitemsByName(BOARDS.produktionSubitems, SUBITEM_NACHFASSEN, ['person', 'status', 'date0']);

  progress(70, 'Lade Activity-Log Pipeline (Sales)...');
  const salesActPipeline = await fetchActivity(BOARDS.pipeline, fromISO, toISO, [SALES_USER_ID], true);

  progress(85, 'Lade Activity-Log Produktionsübersicht (Sales)...');
  const salesActProduktion = await fetchActivity(BOARDS.produktion, fromISO, toISO, [SALES_USER_ID]);

  progress(92, 'Aggregiere Wochenwerte...');

  // Neue Leads/Woche + pro Mitarbeiter — Pipeline, gezählt nach Erstellungsdatum
  const leadsPerWeek = {};
  const leadsProMitarbeiter = {};
  for (const it of pipelineItems) {
    const created = parseMondayTimestamp(it.created_at);
    if (!created || created < fromDate) continue;
    const wk = isoWeekLabel(created);
    leadsPerWeek[wk] = (leadsPerWeek[wk] || 0) + 1;
    const cv = cvMap(it);
    splitNames(cv['person'] && cv['person'].text).forEach(n => {
      leadsProMitarbeiter[n] = (leadsProMitarbeiter[n] || 0) + 1;
    });
  }

  // Sales-Aktivität/Woche: Bearbeitungen, Gruppenwechsel (Mutation), Kommentare, aktive Tage
  const salesWeek = {};
  for (const ev of [...salesActPipeline, ...salesActProduktion]) {
    const ts = parseMondayTimestamp(ev.created_at);
    if (!ts) continue;
    const wk = isoWeekLabel(ts);
    if (!salesWeek[wk]) salesWeek[wk] = { bearbeitungen: 0, verschoben: 0, kommentare: 0, tage: new Set() };
    salesWeek[wk].tage.add(ts.toISOString().slice(0, 10));
    if (ev.event === 'update_column_value') salesWeek[wk].bearbeitungen++;
    else if (ev.event === 'move_pulse_from_group' || ev.event === 'move_pulse_into_group') salesWeek[wk].verschoben++;
    else if (ev.event === 'create_update') salesWeek[wk].kommentare++;
  }

  // Sales-Performance-Indikator: Vereinbarung ist "4-8 Leads/Tag bearbeitet".
  // Zählt EINDEUTIGE Leads (pulse_id), nicht rohe Events — wer denselben Lead
  // dreimal anfasst, hat trotzdem nur 1 Lead bearbeitet an dem Tag.
  const dailyPipelineLeads = {}; // { 'YYYY-MM-DD': Set<pulse_id> }
  for (const ev of salesActPipeline) {
    const ts = parseMondayTimestamp(ev.created_at);
    const pid = pulseIdFromActivity(ev);
    if (!ts || !pid) continue;
    const day = ts.toISOString().slice(0, 10);
    if (!dailyPipelineLeads[day]) dailyPipelineLeads[day] = new Set();
    dailyPipelineLeads[day].add(pid);
  }

  // Neue Anfragen/Woche — jetzt: ALLE Elemente der Produktionsübersicht nach
  // Erstellungsdatum (jedes Element dort beginnt als Anfrage, unabhängig davon,
  // wo es aktuell in der Gruppen-Kette steht). Herkunft (direkt vs. aus Lead)
  // weiterhin exakt per Item-ID gegen die Pipeline bestimmt (von Sven bestätigt:
  // Item-ID bleibt über alle Board-/Phasenwechsel stabil).
  const pipelineIds = new Set(pipelineItems.map(it => String(it.id)));
  const anfragenPerWeek = {};
  const anfragenDirektPerWeek = {};
  const anfragenAusLeadPerWeek = {};
  for (const it of produktionItems) {
    const created = parseMondayTimestamp(it.created_at);
    if (!created || created < fromDate) continue;
    const wk = isoWeekLabel(created);
    anfragenPerWeek[wk] = (anfragenPerWeek[wk] || 0) + 1;
    if (pipelineIds.has(String(it.id))) anfragenAusLeadPerWeek[wk] = (anfragenAusLeadPerWeek[wk] || 0) + 1;
    else anfragenDirektPerWeek[wk] = (anfragenDirektPerWeek[wk] || 0) + 1;
  }

  // Offerten erstellt/Woche + pro Mitarbeiter — Subitem "Offerte erstellen",
  // gezählt nach Erstellungsdatum des Subitems (= Start der Bearbeitung).
  // Ersetzt die frühere "Offerten raus"-Zahl (die brauchte ein Offertdatum-Feld,
  // das es auf der Produktionsübersicht nicht gibt) — diese Zahl ist die
  // direkte Antwort auf "wer erstellt wie viele Offerten".
  const offertenErstelltPerWeek = {};
  const offertenErstelltProMitarbeiter = {};
  const inOffertbearbeitungProMitarbeiter = {}; // Snapshot: aktuell offene "Offerte erstellen"-Subitems
  for (const it of offerteErstellenItems) {
    const cv = cvMap(it);
    const bearbeiter = (cv['person'] && cv['person'].text) || '(kein Bearbeiter)';
    const status = cv['status'] && cv['status'].text;
    const created = parseMondayTimestamp(it.created_at);
    if (created && created >= fromDate) {
      const wk = isoWeekLabel(created);
      offertenErstelltPerWeek[wk] = (offertenErstelltPerWeek[wk] || 0) + 1;
      offertenErstelltProMitarbeiter[bearbeiter] = (offertenErstelltProMitarbeiter[bearbeiter] || 0) + 1;
    }
    if (status === SUBITEM_STATUS_IN_ARBEIT) {
      inOffertbearbeitungProMitarbeiter[bearbeiter] = (inOffertbearbeitungProMitarbeiter[bearbeiter] || 0) + 1;
    }
  }

  // Offerten aktuell beim Kunden pro Mitarbeiter — Snapshot: Haupt-Status =
  // "Offerte ist raus" auf der Produktionsübersicht, gruppiert nach Projektleiter.
  const offerteBeimKundeProMitarbeiter = {};
  for (const it of produktionItems) {
    const cv = cvMap(it);
    if ((cv['status'] && cv['status'].text) !== STATUS_OFFERTE_RAUS) continue;
    splitNames(cv['people0'] && cv['people0'].text).forEach(n => {
      offerteBeimKundeProMitarbeiter[n] = (offerteBeimKundeProMitarbeiter[n] || 0) + 1;
    });
  }

  // Gewonnen/Abgelehnt/Konversion — über die Gruppen-Zugehörigkeit auf der
  // Produktionsübersicht (Annahme, bitte gegenprüfen): "Verloren / Abgesagt"
  // = abgelehnt; jedes Element, das die Anfrage- und Offertprüfungs-Gruppen
  // bereits verlassen hat (und nicht verloren ist), gilt als gewonnen. Beide
  // über updated_at auf den Zeitraum eingegrenzt (bestes verfügbares Datum für
  // "wann erreicht", da es keine eigene Datums-Spalte dafür gibt).
  let gewonnen = 0, abgelehnt = 0;
  for (const it of produktionItems) {
    const updated = parseMondayTimestamp(it.updated_at);
    if (!updated || updated < fromDate) continue;
    const gid = it.group && it.group.id;
    if (gid === GROUPS.verloren) abgelehnt++;
    else if (gid !== GROUPS.anfragen && gid !== GROUPS.offertpruefung) gewonnen++;
  }

  // Vollständige Projektleiter-Liste — jeder, der jemals als Projektleiter
  // (people0) auf der Produktionsübersicht gesetzt wurde, gilt als Mitarbeiter
  // und muss in der Übersicht erscheinen, auch mit 0 im aktuellen Zeitraum.
  // Bewusst NICHT auf Titel/Team gefiltert (die meisten Monday-User-Profile
  // haben kein Titel-Feld gesetzt) — die tatsächliche Verwendung im people0-
  // Feld ist das einzige verlässliche Kriterium für "ist Projektleiter".
  const alleProjektleiter = new Set();
  for (const it of produktionItems) {
    const cv = cvMap(it);
    splitNames(cv['people0'] && cv['people0'].text).forEach(n => alleProjektleiter.add(n));
  }

  // Anfragen bearbeitet / In Umsetzung / Rechnung & abgeschlossen — pro
  // Projektleiter (people0). "Anfragen bearbeitet" = im Zeitraum erstellt;
  // die anderen zwei sind Momentaufnahmen wie inOffertbearbeitung/offerteBeimKunde.
  const anfragenBearbeitetProMitarbeiter = {};
  const inUmsetzungProMitarbeiter = {};
  const abgeschlossenProMitarbeiter = {};
  for (const it of produktionItems) {
    const cv = cvMap(it);
    const namen = splitNames(cv['people0'] && cv['people0'].text);
    const created = parseMondayTimestamp(it.created_at);
    if (created && created >= fromDate) {
      namen.forEach(n => { anfragenBearbeitetProMitarbeiter[n] = (anfragenBearbeitetProMitarbeiter[n] || 0) + 1; });
    }
    const gid = it.group && it.group.id;
    if (GROUPS.inUmsetzung.includes(gid)) {
      namen.forEach(n => { inUmsetzungProMitarbeiter[n] = (inUmsetzungProMitarbeiter[n] || 0) + 1; });
    } else if (GROUPS.abgeschlossen.includes(gid)) {
      namen.forEach(n => { abgeschlossenProMitarbeiter[n] = (abgeschlossenProMitarbeiter[n] || 0) + 1; });
    }
  }

  // Produktionsstatus-Verteilung (aktueller Stand, nicht zeitlich gefiltert)
  const produktionStatus = {};
  for (const it of produktionItems) {
    const cv = cvMap(it);
    const st = (cv['status'] && cv['status'].text) || 'Unbekannt';
    produktionStatus[st] = (produktionStatus[st] || 0) + 1;
  }

  // Mitarbeiterübersicht: Leads (Pipeline) + Anfragen bearbeitet + Offerten
  // erstellt (alle im Zeitraum) + In Umsetzung + Abgeschlossen + aktuell in
  // Offertbearbeitung + aktuell beim Kunden (alle vier zuletzt: Snapshots)
  const mitarbeiter = {};
  function ensure(name) {
    if (!mitarbeiter[name]) mitarbeiter[name] = {
      leads: 0, anfragenBearbeitet: 0, offertenErstellt: 0, inUmsetzung: 0,
      abgeschlossen: 0, inOffertbearbeitung: 0, offerteBeimKunde: 0
    };
    return mitarbeiter[name];
  }
  Object.entries(leadsProMitarbeiter).forEach(([n, c]) => { ensure(n).leads = c; });
  alleProjektleiter.forEach(n => ensure(n)); // garantiert jeden echten Projektleiter, auch mit 0 überall
  Object.entries(anfragenBearbeitetProMitarbeiter).forEach(([n, c]) => { ensure(n).anfragenBearbeitet = c; });
  Object.entries(offertenErstelltProMitarbeiter).forEach(([n, c]) => { ensure(n).offertenErstellt = c; });
  Object.entries(inUmsetzungProMitarbeiter).forEach(([n, c]) => { ensure(n).inUmsetzung = c; });
  Object.entries(abgeschlossenProMitarbeiter).forEach(([n, c]) => { ensure(n).abgeschlossen = c; });
  Object.entries(inOffertbearbeitungProMitarbeiter).forEach(([n, c]) => { ensure(n).inOffertbearbeitung = c; });
  Object.entries(offerteBeimKundeProMitarbeiter).forEach(([n, c]) => { ensure(n).offerteBeimKunde = c; });

  // Nachfassquote — Subitem "Nachfassen beim Kunde" (neue Monday-Automation:
  // 9 Kalendertage nach Eintritt in "Offerprüfung Kunde / Vergabe", Bearbeiter
  // = Projektleiter der Offerte). Fällig = "Fällig bis"-Datum erreicht,
  // Nachgefasst = Subitem-Status "Fertig".
  const nachfassWeek = {};        // { kw: { faellig, nachgefasst } }
  const nachfassMitarbeiter = {}; // { name: { faellig, nachgefasst } }
  alleProjektleiter.forEach(n => { nachfassMitarbeiter[n] = { faellig: 0, nachgefasst: 0 }; });
  const offeneNachfassungen = [];
  for (const it of nachfassItems) {
    const cv = cvMap(it);
    const faelligTxt = cv['date0'] && cv['date0'].text;
    if (!faelligTxt) continue;
    const faelligDate = new Date(faelligTxt);
    if (isNaN(faelligDate.getTime()) || faelligDate > today) continue; // noch nicht fällig
    const bearbeiter = (cv['person'] && cv['person'].text) || '(kein Bearbeiter)';
    const nachgefasst = (cv['status'] && cv['status'].text) === SUBITEM_STATUS_FERTIG;

    if (faelligDate >= fromDate) {
      const wk = isoWeekLabel(faelligDate);
      if (!nachfassWeek[wk]) nachfassWeek[wk] = { faellig: 0, nachgefasst: 0 };
      nachfassWeek[wk].faellig++;
      if (nachgefasst) nachfassWeek[wk].nachgefasst++;
    }

    if (!nachfassMitarbeiter[bearbeiter]) nachfassMitarbeiter[bearbeiter] = { faellig: 0, nachgefasst: 0 };
    nachfassMitarbeiter[bearbeiter].faellig++;
    if (nachgefasst) nachfassMitarbeiter[bearbeiter].nachgefasst++;

    if (!nachgefasst) {
      offeneNachfassungen.push({
        projekt: (it.parent_item && it.parent_item.name) || '',
        bearbeiter,
        faelligSeit: faelligTxt,
        tageUeberfaellig: Math.round((today - faelligDate) / 86400000)
      });
    }
  }
  offeneNachfassungen.sort((a, b) => b.tageUeberfaellig - a.tageUeberfaellig);

  const { labels: weekList, mondays: weekMondays } = weekListFrom(fromDate, today);
  const weeks = weekList.map((wk, idx) => {
    const workdays = workdaysOfWeek(weekMondays[idx], today);
    const leadsBearbeitetTage = workdays.map(day => (dailyPipelineLeads[day] ? dailyPipelineLeads[day].size : 0));
    const leadsBearbeitetSumme = leadsBearbeitetTage.reduce((a, v) => a + v, 0);
    const avgProTag = workdays.length ? Math.round((leadsBearbeitetSumme / workdays.length) * 10) / 10 : 0;
    const status = workdays.length === 0 ? 'keine-daten'
      : avgProTag < SALES_ZIEL_MIN ? 'unter-ziel'
      : avgProTag > SALES_ZIEL_MAX ? 'ueber-ziel'
      : 'im-ziel';
    return {
      kw: wk,
      neueLeads: leadsPerWeek[wk] || 0,
      neueAnfragen: anfragenPerWeek[wk] || 0,
      neueAnfragenDirekt: anfragenDirektPerWeek[wk] || 0,
      neueAnfragenAusLead: anfragenAusLeadPerWeek[wk] || 0,
      offertenErstellt: offertenErstelltPerWeek[wk] || 0,
      sales: {
        bearbeitungen: (salesWeek[wk] && salesWeek[wk].bearbeitungen) || 0,
        verschoben: (salesWeek[wk] && salesWeek[wk].verschoben) || 0,
        kommentare: (salesWeek[wk] && salesWeek[wk].kommentare) || 0,
        aktiveTage: (salesWeek[wk] && salesWeek[wk].tage.size) || 0
      },
      salesPerformance: {
        leadsBearbeitet: leadsBearbeitetSumme,
        werktage: workdays.length,
        avgProTag,
        status
      },
      nachfass: {
        faellig: (nachfassWeek[wk] && nachfassWeek[wk].faellig) || 0,
        nachgefasst: (nachfassWeek[wk] && nachfassWeek[wk].nachgefasst) || 0
      }
    };
  });

  const nfTotalFaellig = Object.values(nachfassMitarbeiter).reduce((a, v) => a + v.faellig, 0);
  const nfTotalNachgefasst = Object.values(nachfassMitarbeiter).reduce((a, v) => a + v.nachgefasst, 0);

  return {
    generatedAt: new Date().toISOString(),
    zeitraum: { von: fromISO, bis: toISO, wochen: weekList.length },
    weeks,
    nachfassProMitarbeiter: nachfassMitarbeiter,
    offeneNachfassungen: offeneNachfassungen.slice(0, 50),
    kpis: {
      gewonnen,
      abgelehnt,
      konversionProzent: (gewonnen + abgelehnt) ? Math.round((gewonnen / (gewonnen + abgelehnt)) * 100) : null,
      nachfassquoteProzent: nfTotalFaellig ? Math.round((nfTotalNachgefasst / nfTotalFaellig) * 100) : null
    },
    produktionStatus,
    mitarbeiter
  };
}

// ─── Cache ────────────────────────────────────────────────────────────────
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (e) { return null; }
}
function saveCache(data) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

// ─── Finanzen (Selectline) ───────────────────────────────────────────────
// Kommt vorerst manuell von Sven (Weg noch nicht festgelegt) — deshalb bewusst
// eine eigene, kleine Datei statt Teil des Monday-Caches: eine Aktualisierung
// hier braucht weder einen Monday-Refresh noch einen Server-Neustart, und eine
// spätere automatische Anbindung (Selectline-Export, Zapier, o.ä.) kann einfach
// auf dieselbe Route schreiben, ohne am restlichen Controlling-Code etwas zu ändern.
function loadFinanzen() {
  try {
    const f = JSON.parse(fs.readFileSync(FINANZEN_FILE, 'utf8'));
    f.auftragsbestandGesamt = (f.auftragsbestandLTBisJahresende || 0) + (f.auftragsbestandFolgejahr || 0);
    if (f.jahreszielUmsatz == null) f.jahreszielUmsatz = 2500000; // Default, falls in älteren finanzen.json noch nicht gesetzt
    return f;
  } catch (e) { return null; }
}
function saveFinanzen(data) {
  fs.mkdirSync(path.dirname(FINANZEN_FILE), { recursive: true });
  fs.writeFileSync(FINANZEN_FILE, JSON.stringify(data, null, 2));
}

// ─── Routen ────────────────────────────────────────────────────────────────
router.get('/data', (req, res) => {
  const cache = loadCache();
  if (!cache) return res.status(404).json({ ok: false, msg: 'Noch kein Report vorhanden — bitte Aktualisieren klicken.' });
  res.json({ ok: true, ...cache, finanzen: loadFinanzen() });
});

// Finanzzahlen (Selectline) aktualisieren — vorerst manuell aufgerufen, bis
// der Lieferweg feststeht. Erwartet: { stichtag, umsatzBisStichtag,
// auftragsbestandLTBisJahresende, auftragsbestandFolgejahr,
// eingangsrechnungenBisStichtag, gutschriften }
router.post('/finanzen', (req, res) => {
  const b = req.body || {};
  const felder = ['stichtag', 'umsatzBisStichtag', 'auftragsbestandLTBisJahresende', 'auftragsbestandFolgejahr', 'eingangsrechnungenBisStichtag', 'gutschriften'];
  const fehlend = felder.filter(f => b[f] === undefined || b[f] === null);
  if (fehlend.length) return res.status(400).json({ ok: false, msg: 'Fehlende Felder: ' + fehlend.join(', ') });
  const data = {};
  felder.forEach(f => { data[f] = b[f]; });
  if (b.jahreszielUmsatz != null) data.jahreszielUmsatz = b.jahreszielUmsatz;
  data.aktualisiertAm = new Date().toISOString();
  saveFinanzen(data);
  res.json({ ok: true, finanzen: loadFinanzen() });
});

router.get('/finanzen', (req, res) => {
  const f = loadFinanzen();
  if (!f) return res.status(404).json({ ok: false, msg: 'Noch keine Finanzzahlen hinterlegt.' });
  res.json({ ok: true, finanzen: f });
});

router.post('/refresh', (req, res) => {
  if (job && !job.done) return res.json({ ok: true, jobId: job.id, already: true });
  const id = Date.now().toString(36);
  job = { id, progress: 0, step: 'Start...', done: false, error: null };
  res.json({ ok: true, jobId: id });
  buildReport((p, step) => { if (job && job.id === id) { job.progress = p; job.step = step; } })
    .then(data => {
      saveCache(data);
      if (job && job.id === id) { job.progress = 100; job.step = 'Fertig'; job.done = true; }
    })
    .catch(err => {
      console.error('[controlling] refresh error:', err.message);
      if (job && job.id === id) { job.done = true; job.error = err.message; }
    });
});

router.get('/refresh/status', (req, res) => {
  if (!job) return res.json({ ok: true, done: true, progress: 100, step: 'Kein Job gestartet' });
  res.json({ ok: true, ...job });
});

// Automatische tägliche Aktualisierung (60s nach Start, danach alle 24h)
function scheduleDaily() {
  const run = () => {
    if (job && !job.done) return; // laufender Job hat Vorrang
    const id = 'auto-' + Date.now().toString(36);
    job = { id, progress: 0, step: 'Automatische Aktualisierung...', done: false, error: null };
    buildReport((p, step) => { if (job && job.id === id) { job.progress = p; job.step = step; } })
      .then(data => {
        saveCache(data);
        if (job && job.id === id) { job.progress = 100; job.done = true; }
      })
      .catch(err => {
        console.error('[controlling] auto-refresh error:', err.message);
        if (job && job.id === id) { job.done = true; job.error = err.message; }
      });
  };
  setTimeout(run, 60 * 1000);
  setInterval(run, 24 * 60 * 60 * 1000);
}
scheduleDaily();

module.exports = router;
