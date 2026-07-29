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
  return `Du analysierst eine eingehende Kunden-E-Mail und extrahierst die Daten des ABSENDERS (= Kunde) für unser Schweizer Werbetechnik-Unternehmen „Grafe AG".

WICHTIGE REGELN (unbedingt beachten):
- „Grafe", „Grafe AG", „grafe.ch" sind UNSER EIGENES Unternehmen (der Empfänger) — NIEMALS der Kunde. Kommt „Grafe" im Text vor, ignoriere es als Kundennamen.
- Der KUNDE ist der ABSENDER (Von/From). Erkenne ihn an der Absender-E-Mail (die Domain, die NICHT grafe.ch ist) und an der Signatur am Ende der Nachricht (Firmenname, Adresse, Telefon).
- kundenname = Firma/Organisation des Absenders aus Signatur bzw. E-Mail-Domain (z. B. @bhm.ch → „Bernisches Historisches Museum"). Eine im Fliesstext beiläufig genannte Firma ist NICHT der Kunde.
- kontaktperson = NUR Vor- und Nachname der Absender-Person — niemals ein ganzer Satz.
- Adresse/Telefon = aus der Absender-Signatur (nicht unsere Adresse).

Extrahiere folgende Felder (leer lassen, wenn nicht vorhanden):
- kundenname: Firma/Organisation des Absenders (oder vollständiger Name bei Privatperson)
- kontaktperson: Vorname + Nachname der Absender-Person (nur der Name!)
- telefon: Telefonnummer des Absenders (mit Vorwahl, z.B. +41 61 123 45 67)
- email: E-Mail-Adresse des Absenders (die Nicht-grafe.ch-Adresse)
- adresseStrasse: Strasse + Hausnummer (z.B. "Hauptstrasse 12")
- adressePLZ: Postleitzahl (4-stellig, z.B. "4127")
- adresseOrt: Ortsname (z.B. "Birsfelden")
- betreff: Kurzer Projekttitel / Betreff der Anfrage (max 80 Zeichen, KEINE Zeichen : oder -). NUR Thema/Was — OHNE Ort, Adresse, PLZ und OHNE Kundenname (Adresse & Kunde werden separat erfasst).
- zusammenfassung: 1–2 ganze Sätze, worum es in der Anfrage konkret geht — so dass man die E-Mail NICHT lesen muss (wird als Monday-Kommentar hinterlegt)

Wichtig: Trenne die Adresse immer in Strasse, PLZ und Ort auf — auch wenn sie in einer Zeile steht.
Schweizer PLZ sind immer 4-stellig. Deutsche PLZ sind 5-stellig.

Antworte NUR mit einem JSON-Objekt, ohne Erklärungen, ohne Markdown-Backticks:
{"kundenname":"...","kontaktperson":"...","telefon":"...","email":"...","adresseStrasse":"...","adressePLZ":"...","adresseOrt":"...","betreff":"...","zusammenfassung":"..."}

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
