// src/routes/mail.js — Mailversand aus dem Cockpit über Microsoft Graph (App-only).
// Ersetzt den grafemail:-Helfer-Mechanismus (Richtungsentscheid 22.09.2026).
// express.json() ist bereits global in server.js gemountet, hier nicht nochmal nötig.
const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { sendMail } = require('../mailGraph');

// POST /mail/senden
// body: { bearbeiterKuerzel, projektNr, empfaenger, betreff, text, anhaenge? }
// anhaenge (optional): [{ name, contentType, contentBytes(base64) }]
router.post('/senden', async (req, res) => {
  const { bearbeiterKuerzel, projektNr, empfaenger, betreff, text, anhaenge } = req.body || {};

  if (!bearbeiterKuerzel || !empfaenger || !betreff || !text) {
    return res.status(400).json({ error: 'bearbeiterKuerzel, empfaenger, betreff und text sind Pflichtfelder' });
  }

  try {
    // Serverseitige Berechtigungsprüfung -- der im Request mitgeschickte Absender
    // wird NIE ungeprüft übernommen (ausdrückliche Vorgabe der Richtungsentscheidung).
    const b = await query(
      'SELECT kuerzel, name, email, signatur_html, mail_aktiv FROM bearbeiter WHERE kuerzel=$1',
      [bearbeiterKuerzel]
    );
    if (!b.rows.length) {
      return res.status(404).json({ error: 'Unbekannter Bearbeiter: ' + bearbeiterKuerzel });
    }
    const bearbeiter = b.rows[0];
    if (!bearbeiter.mail_aktiv) {
      return res.status(403).json({ error: 'Absender nicht freigegeben (mail_aktiv=false) für ' + bearbeiterKuerzel });
    }
    if (!bearbeiter.email) {
      return res.status(422).json({ error: 'Kein Postfach (email) für Bearbeiter ' + bearbeiterKuerzel + ' hinterlegt' });
    }

    const signatur = bearbeiter.signatur_html || '';
    const htmlBody = `<div>${text}</div>${signatur ? '<div style="margin-top:24px">' + signatur + '</div>' : ''}`;

    await sendMail({
      upn: bearbeiter.email,
      an: empfaenger,
      betreff,
      htmlBody,
      anhaenge: Array.isArray(anhaenge) ? anhaenge : [],
    });

    console.log(`[Mail] gesendet von ${bearbeiter.email} an ${empfaenger}` + (projektNr ? ` (Projekt ${projektNr})` : ''));
    res.json({ ok: true, gesendetVon: bearbeiter.email, gesendetAm: new Date().toISOString() });
  } catch (e) {
    console.error('[Mail] senden:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
