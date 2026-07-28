// src/routes/analyse.js — E-Mail-Analyse via Claude (Anthropic API)
// Der API-Schlüssel liegt serverseitig in der .env — er verlässt den Server NIE
// und muss in keinem Browser eingetragen werden.
//
// Mounten in server.js:  app.use('/analyse', require('./routes/analyse'));
// Voraussetzung in .env:  ANTHROPIC_API_KEY=sk-ant-...
//                         ANTHROPIC_MODEL=claude-haiku-4-5-20251001   (optional)

const express = require('express');
const router  = express.Router();

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

function buildPrompt(text){
  return `Du analysierst einen E-Mail-Text und extrahierst Kundendaten für ein Schweizer Werbetechnik-Unternehmen.

Extrahiere folgende Felder (wenn vorhanden):
- kundenname: Firmenname oder vollständiger Name des Absenders
- kontaktperson: Vorname + Nachname der Kontaktperson
- telefon: Telefonnummer (mit Vorwahl, z.B. +41 61 123 45 67)
- email: E-Mail-Adresse des Absenders
- adresseStrasse: Strasse + Hausnummer (z.B. "Hauptstrasse 12")
- adressePLZ: Postleitzahl (4-stellig, z.B. "4127")
- adresseOrt: Ortsname (z.B. "Birsfelden")
- betreff: Kurze Zusammenfassung worum es geht (max 80 Zeichen)

Wichtig: Trenne die Adresse immer in Strasse, PLZ und Ort auf — auch wenn sie in einer Zeile steht.
Schweizer PLZ sind immer 4-stellig. Deutsche PLZ sind 5-stellig.

Antworte NUR mit einem JSON-Objekt, ohne Erklärungen, ohne Markdown-Backticks:
{"kundenname":"...","kontaktperson":"...","telefon":"...","email":"...","adresseStrasse":"...","adressePLZ":"...","adresseOrt":"...","betreff":"..."}

Wenn ein Feld nicht gefunden wird, setze es auf "".

E-Mail-Text:
${text}`;
}

// POST /analyse  { text }  → { ok:true, fields:{...} }
router.post('/', async (req, res) => {
  const text = ((req.body && req.body.text) || '').toString().trim();
  if(!text) return res.status(400).json({ ok:false, error:'text fehlt' });

  const key = process.env.ANTHROPIC_API_KEY;
  if(!key) return res.status(500).json({ ok:false, error:'ANTHROPIC_API_KEY nicht gesetzt (.env)' });

  try{
    const r = await fetch(ANTHROPIC_API, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':key, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:MODEL, max_tokens:400, messages:[{ role:'user', content: buildPrompt(text) }] }),
    });
    const data = await r.json();
    if(!r.ok){
      const msg = (data && data.error && data.error.message) || ('Anthropic HTTP ' + r.status);
      console.error('[Analyse] Anthropic-Fehler:', msg);
      return res.status(502).json({ ok:false, error: msg });
    }
    const raw = (data.content || []).map(b => b.text || '').join('');
    let fields;
    try{ fields = JSON.parse(raw.replace(/```json?|```/g, '').trim()); }
    catch(e){ return res.status(502).json({ ok:false, error:'Antwort nicht als JSON lesbar', raw }); }

    res.json({ ok:true, fields, model:MODEL });
  }catch(e){
    console.error('[Analyse] Fehler:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

module.exports = router;
