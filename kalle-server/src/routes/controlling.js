// src/routes/controlling.js
// Controlling-Übersicht für KALLE-Cockpit — aggregiert Monday-Daten aus Pipeline,
// Anfragen/Offerten und Produktionsübersicht zu Wochenwerten (letzte ~3 Monate).
// Token: process.env.MONDAY_TOKEN (wie label.js/monday.js).
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

const BOARDS = {
  pipeline: 908257145,       // Verkauf / Pipeline (Leads)
  anfragen: 18423106800,     // Anfragen und Offerten (REAKTOR-Durchlaufboard)
  produktion: 1012481465     // GRAFE Produktionsübersicht
};

// Verkauf/Projektleiter, dessen Aktivität laut interner Vereinbarung (4-8
// bearbeitete Leads/Tag) im Sales-Performance-Indikator ausgewertet wird.
// Bewusst nicht namentlich in der UI — dort heisst es "Sales".
const SALES_USER_ID = '18168107';
const SALES_ZIEL_MIN = 4;
const SALES_ZIEL_MAX = 8;

const WEEKS_BACK = 13; // ~3 Monate

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

function weekListBack(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const lbl = isoWeekLabel(d);
    if (!out.includes(lbl)) out.push(lbl);
  }
  return out;
}

// Alle Items eines Boards holen (paginiert), inkl. gewünschter Spalten
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

// Anfragen/Offerten-Items inkl. Nachfass-relevanter Spalten + Kommentare (Updates).
// Braucht eigene Query (statt fetchAllItems), weil "updates" pro Item mitgeladen wird.
async function fetchAnfragenWithUpdates(boardId) {
  let items = [];
  let cursor = null;
  do {
    const query = `query($board:[ID!], $cursor:String){
      boards(ids:$board){
        items_page(limit:100, cursor:$cursor){
          cursor
          items{
            id name created_at updated_at
            column_values(ids:["color_mm5f5t2b","date_mm5fkwf9","date_mm5fywwj","multiple_person_mm5fmajv","text_mm5f47ba","text_mm5fq49c"]){ id text value }
            updates(limit:25){ creator_id created_at }
          }
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
  const fromDate = mondayOfWeek(new Date());
  fromDate.setUTCDate(fromDate.getUTCDate() - (WEEKS_BACK - 1) * 7); // Montag der ältesten vollständigen Woche
  const fromISO = fromDate.toISOString();
  const toISO = new Date().toISOString();

  progress(5, 'Lade Pipeline-Board (Leads)...');
  const pipelineItems = await fetchAllItems(BOARDS.pipeline, ['status', 'person', 'people', 'creation_log']);

  progress(30, 'Lade Anfragen/Offerten-Board (inkl. Kommentare)...');
  const anfragenItems = await fetchAnfragenWithUpdates(BOARDS.anfragen);

  progress(50, 'Lade Produktionsübersicht...');
  const produktionItems = await fetchAllItems(BOARDS.produktion, ['status', 'people0']);

  progress(65, 'Lade Activity-Log Pipeline (Sales)...');
  const ddeActPipeline = await fetchActivity(BOARDS.pipeline, fromISO, toISO, [SALES_USER_ID], true);

  progress(80, 'Lade Activity-Log Anfragen (Sales)...');
  const ddeActAnfragen = await fetchActivity(BOARDS.anfragen, fromISO, toISO, [SALES_USER_ID]);

  progress(90, 'Aggregiere Wochenwerte...');

  // Neue Leads/Woche — Pipeline, gezählt nach Erstellungsdatum
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
  const ddeWeek = {};
  for (const ev of [...ddeActPipeline, ...ddeActAnfragen]) {
    const ts = parseMondayTimestamp(ev.created_at);
    if (!ts) continue;
    const wk = isoWeekLabel(ts);
    if (!ddeWeek[wk]) ddeWeek[wk] = { bearbeitungen: 0, verschoben: 0, kommentare: 0, tage: new Set() };
    ddeWeek[wk].tage.add(ts.toISOString().slice(0, 10));
    if (ev.event === 'update_column_value') ddeWeek[wk].bearbeitungen++;
    else if (ev.event === 'move_pulse_from_group' || ev.event === 'move_pulse_into_group') ddeWeek[wk].verschoben++;
    else if (ev.event === 'create_update') ddeWeek[wk].kommentare++;
  }

  // Sales-Performance-Indikator: Vereinbarung ist "4-8 Leads/Tag bearbeitet".
  // Zählt EINDEUTIGE Leads (pulse_id), nicht rohe Events — wer denselben Lead
  // dreimal anfasst, hat trotzdem nur 1 Lead bearbeitet an dem Tag.
  const dailyPipelineLeads = {}; // { 'YYYY-MM-DD': Set<pulse_id> }
  for (const ev of ddeActPipeline) {
    const ts = parseMondayTimestamp(ev.created_at);
    const pid = pulseIdFromActivity(ev);
    if (!ts || !pid) continue;
    const day = ts.toISOString().slice(0, 10);
    if (!dailyPipelineLeads[day]) dailyPipelineLeads[day] = new Set();
    dailyPipelineLeads[day].add(pid);
  }

  // Neue Anfragen/Woche — Anfragen-Board (alle, inkl. abgelehnte) PLUS
  // gewonnene, die per Automatisierung ins Produktionsboard gewandert sind.
  // Item-ID bleibt laut Sven über alle Phasen hinweg stabil (bestätigt) ->
  // Herkunft lässt sich damit exakt bestimmen statt über Erstelldatum zu
  // mutmassen: Pipeline-ID bekannt -> "aus Lead qualifiziert", sonst -> "direkt
  // erfasst" (z.B. via KALLE-KULATOR ohne vorherige Lead-Qualifikation).
  const pipelineIds = new Set(pipelineItems.map(it => String(it.id)));
  const anfragenPerWeek = {};          // gesamt (Kompatibilität)
  const anfragenDirektPerWeek = {};    // ohne vorherige Pipeline-Station
  const anfragenAusLeadPerWeek = {};   // aus Pipeline promoviert
  function bumpAnfrage(id, wk) {
    anfragenPerWeek[wk] = (anfragenPerWeek[wk] || 0) + 1;
    if (pipelineIds.has(String(id))) anfragenAusLeadPerWeek[wk] = (anfragenAusLeadPerWeek[wk] || 0) + 1;
    else anfragenDirektPerWeek[wk] = (anfragenDirektPerWeek[wk] || 0) + 1;
  }
  for (const it of anfragenItems) {
    const created = parseMondayTimestamp(it.created_at);
    if (!created || created < fromDate) continue;
    bumpAnfrage(it.id, isoWeekLabel(created));
  }
  for (const it of produktionItems) {
    const created = parseMondayTimestamp(it.created_at);
    if (!created || created < fromDate) continue;
    bumpAnfrage(it.id, isoWeekLabel(created));
  }

  // Offerten raus/Woche (Offertdatum gesetzt) + Gewonnen/Abgelehnt-Zähler.
  // Abgelehnt wird über updated_at auf den Zeitraum eingegrenzt (Näherung: das
  // Anfragen-Board hält abgelehnte Offerten dauerhaft, ohne eigenes "seit wann
  // abgelehnt"-Datum — updated_at ist der beste verfügbare Proxy).
  const offertenPerWeek = {};
  let abgelehnt = 0;
  for (const it of anfragenItems) {
    const cv = cvMap(it);
    const phase = cv['color_mm5f5t2b'] && cv['color_mm5f5t2b'].text;
    const offertDatumTxt = cv['date_mm5fkwf9'] && cv['date_mm5fkwf9'].text;
    if (offertDatumTxt) {
      const od = new Date(offertDatumTxt);
      if (od >= fromDate) {
        const wk = isoWeekLabel(od);
        offertenPerWeek[wk] = (offertenPerWeek[wk] || 0) + 1;
      }
    }
    if (phase === 'Abgelehnt') {
      const updated = parseMondayTimestamp(it.updated_at);
      if (updated && updated >= fromDate) abgelehnt++;
    }
  }
  const gewonnen = produktionItems.filter(it => {
    const created = parseMondayTimestamp(it.created_at);
    return created && created >= fromDate;
  }).length;

  // Produktionsstatus-Verteilung (aktueller Stand, nicht zeitlich gefiltert)
  const produktionStatus = {};
  for (const it of produktionItems) {
    const cv = cvMap(it);
    const st = (cv['status'] && cv['status'].text) || 'Unbekannt';
    produktionStatus[st] = (produktionStatus[st] || 0) + 1;
  }

  // Mitarbeiterübersicht: Leads (Pipeline) + offene Anfragen/Offerten + laufende Produktion
  const mitarbeiter = {};
  function bump(name, key) {
    if (!name) return;
    if (!mitarbeiter[name]) mitarbeiter[name] = { leads: 0, anfragen: 0, produktion: 0 };
    mitarbeiter[name][key]++;
  }
  Object.entries(leadsProMitarbeiter).forEach(([n, c]) => {
    if (!mitarbeiter[n]) mitarbeiter[n] = { leads: 0, anfragen: 0, produktion: 0 };
    mitarbeiter[n].leads = c;
  });
  for (const it of anfragenItems) {
    const cv = cvMap(it);
    splitNames(cv['multiple_person_mm5fmajv'] && cv['multiple_person_mm5fmajv'].text).forEach(n => bump(n, 'anfragen'));
  }
  for (const it of produktionItems) {
    const cv = cvMap(it);
    splitNames(cv['people0'] && cv['people0'].text).forEach(n => bump(n, 'produktion'));
  }

  // Nachfassquote: pro Anfrage/Offerte mit gesetztem "Nachfassen am" prüfen,
  // ob nach diesem Datum ein Kommentar (Update) im Item verfasst wurde.
  // Bewusst ohne Autoren-Abgleich (einfacher, robuster) — zählt auf den/die
  // im Item hinterlegten Verkäufer, wie von Sven vorgegeben ("jeder PL fasst
  // seine eigenen Offerten nach"). Stand: reine Auswertung, kein Cockpit-Zwang.
  const today = new Date();
  const nachfassWeek = {};      // { kw: { faellig, nachgefasst } }
  const nachfassMitarbeiter = {}; // { name: { faellig, nachgefasst } }
  const offeneNachfassungen = [];
  for (const it of anfragenItems) {
    const cv = cvMap(it);
    const naTxt = cv['date_mm5fywwj'] && cv['date_mm5fywwj'].text;
    if (!naTxt) continue;
    const naDate = new Date(naTxt);
    if (isNaN(naDate.getTime()) || naDate > today) continue; // noch nicht fällig
    const verkaeufer = splitNames(cv['multiple_person_mm5fmajv'] && cv['multiple_person_mm5fmajv'].text);
    const updates = it.updates || [];
    const nachgefasst = updates.some(u => {
      const ts = parseMondayTimestamp(u.created_at);
      return ts && ts >= naDate;
    });

    if (naDate >= fromDate) {
      const wk = isoWeekLabel(naDate);
      if (!nachfassWeek[wk]) nachfassWeek[wk] = { faellig: 0, nachgefasst: 0 };
      nachfassWeek[wk].faellig++;
      if (nachgefasst) nachfassWeek[wk].nachgefasst++;
    }

    const names = verkaeufer.length ? verkaeufer : ['(kein Verkäufer)'];
    names.forEach(n => {
      if (!nachfassMitarbeiter[n]) nachfassMitarbeiter[n] = { faellig: 0, nachgefasst: 0 };
      nachfassMitarbeiter[n].faellig++;
      if (nachgefasst) nachfassMitarbeiter[n].nachgefasst++;
    });

    if (!nachgefasst) {
      offeneNachfassungen.push({
        projektnummer: (cv['text_mm5fq49c'] && cv['text_mm5fq49c'].text) || '',
        kunde: (cv['text_mm5f47ba'] && cv['text_mm5f47ba'].text) || it.name,
        verkaeufer: names.join(', '),
        nachfassenAm: naTxt,
        tageUeberfaellig: Math.round((today - naDate) / 86400000)
      });
    }
  }
  offeneNachfassungen.sort((a, b) => b.tageUeberfaellig - a.tageUeberfaellig);

  const weekList = weekListBack(WEEKS_BACK);
  const weekMondays = weekList.map((_, idx) => {
    const monday = mondayOfWeek(today);
    monday.setUTCDate(monday.getUTCDate() - (WEEKS_BACK - 1 - idx) * 7);
    return monday;
  });
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
      offertenRaus: offertenPerWeek[wk] || 0,
      sales: {
        bearbeitungen: (ddeWeek[wk] && ddeWeek[wk].bearbeitungen) || 0,
        verschoben: (ddeWeek[wk] && ddeWeek[wk].verschoben) || 0,
        kommentare: (ddeWeek[wk] && ddeWeek[wk].kommentare) || 0,
        aktiveTage: (ddeWeek[wk] && ddeWeek[wk].tage.size) || 0
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
    zeitraum: { von: fromISO, bis: toISO, wochen: WEEKS_BACK },
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

// ─── Routen ────────────────────────────────────────────────────────────────
router.get('/data', (req, res) => {
  const cache = loadCache();
  if (!cache) return res.status(404).json({ ok: false, msg: 'Noch kein Report vorhanden — bitte Aktualisieren klicken.' });
  res.json({ ok: true, ...cache });
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
