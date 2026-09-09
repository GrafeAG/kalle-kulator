// src/routes/analyse_zusammenfassung.js
//
// GET /analyse/zusammenfassung?id=<Monday-Item-ID>
// Liefert eine 1–2-Satz-KI-Kurzzusammenfassung des Projektstands fürs Cockpit
// ("wo steht das Projekt, was ist offen"). Nutzt dieselbe Anthropic-Anbindung
// wie die bestehende Mail-Analyse (analyse.js) — kein neuer Schlüssel nötig,
// der Key bleibt serverseitig in der .env.
//
// Einbinden in server.js (zusammen mit den anderen app.use(...)):
//   app.use('/analyse', require('./routes/analyse_zusammenfassung'));
// Kann parallel zur bestehenden POST-Route unter /analyse gemountet werden —
// Express probiert beide Router der Reihe nach durch, es gibt keinen Konflikt,
// solange Methode (GET) und Pfad (/zusammenfassung) nicht bereits belegt sind.
//
// Voraussetzung: ANTHROPIC_API_KEY und MONDAY_TOKEN in der .env (beide bereits
// für analyse.js bzw. die Monday-Anbindung vorhanden).

const express = require('express');
const router = express.Router();

const MONDAY_API = 'https://api.monday.com/v2';
const MONDAY_VER = '2024-01';

// Kleiner In-Memory-Cache (5 Min) — verhindert, dass ein mehrfaches Öffnen
// desselben Projekts im Cockpit jedes Mal einen neuen Claude-Aufruf auslöst.
const CACHE = new Map(); // id -> { text, ts }
const CACHE_MS = 5 * 60 * 1000;

async function mondayFetch(query, variables) {
  const token = process.env.MONDAY_TOKEN;
  if (!token) throw new Error('MONDAY_TOKEN fehlt in .env');
  const r = await fetch(MONDAY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
      'API-Version': MONDAY_VER,
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  if (!r.ok) throw new Error('Monday HTTP ' + r.status);
  const d = await r.json();
  if (d.errors) throw new Error((d.errors[0] && d.errors[0].message) || 'Monday API Fehler');
  return d.data;
}

function buildKontext(item) {
  const cv = {};
  (item.column_values || []).forEach((c) => {
    if (c.text) cv[c.column.title] = c.text;
  });

  const lines = [];
  lines.push('Projekt: ' + (item.name || '—'));
  ['Status', 'Priorität', 'Kunde'].forEach((k) => {
    if (cv[k]) lines.push(k + ': ' + cv[k]);
  });

  const subs = item.subitems || [];
  if (subs.length) {
    lines.push('');
    lines.push('Schritte:');
    subs.forEach((s) => {
      const scv = {};
      (s.column_values || []).forEach((c) => {
        if (c.text) scv[c.column.title] = c.text;
      });
      const status = scv.Status || scv.status || 'ohne Status';
      const datum = scv.Datum || scv.date0 || '';
      lines.push(`- ${s.name}: ${status}${datum ? ' · ' + datum : ''}`);
    });
  }

  const updates = (item.updates || []).slice(0, 8);
  if (updates.length) {
    lines.push('');
    lines.push('Letzte Kommentare (neueste zuerst):');
    updates.forEach((u) => {
      const wer = (u.creator && u.creator.name) || '—';
      const text = (u.text_body || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (text) lines.push(`- ${wer}: ${text}`);
    });
  }

  return lines.join('\n');
}

router.get('/zusammenfassung', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id fehlt' });

  const cached = CACHE.get(id);
  if (cached && Date.now() - cached.ts < CACHE_MS) {
    return res.json({ text: cached.text, cached: true });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY fehlt in .env' });
  }

  try {
    const q = `query{ items(ids:[${id}]){
      name
      column_values{ text column{ title } }
      updates(limit:10){ text_body creator{ name } }
      subitems{ name column_values{ text column{ title } } }
    } }`;
    const d = await mondayFetch(q);
    const item = (d.items || [])[0];
    if (!item) return res.status(404).json({ error: 'Item nicht gefunden' });

    const kontext = buildKontext(item);
    const prompt = `Du bist Assistent einer Signaletik-/Beschriftungsfirma (Grafe AG). Fasse den aktuellen Stand dieses Projekts für einen Betriebsleiter in maximal 2 kurzen, konkreten Sätzen zusammen — was ist der aktuelle Stand, was ist offen oder verzögert. Kein Vorspann, keine Höflichkeitsfloskeln, direkt der Inhalt. Deutsch, Schweizer Hochdeutsch (kein „ß").

${kontext}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error((errBody.error && errBody.error.message) || resp.statusText);
    }
    const data = await resp.json();
    const text = (data.content || []).map((b) => b.text || '').join('').trim();
    if (!text) throw new Error('Leere Antwort von Claude');

    CACHE.set(id, { text, ts: Date.now() });
    res.json({ text, cached: false });
  } catch (err) {
    console.error('[Analyse/Zusammenfassung]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
