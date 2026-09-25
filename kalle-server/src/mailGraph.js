// src/mailGraph.js — Microsoft Graph App-only Client für den Mailversand.
// Eigene, von der bestehenden SharePoint/REACTOR-Server-App GETRENNTE Entra-App
// (eigenes Secret) -- siehe MAILVERSAND_Integration.md. Client-Credentials-Flow,
// Scope https://graph.microsoft.com/.default, gleiches Muster wie die
// SharePoint-Anbindung (Vorgabe aus der Infrastruktur-Übergabe vom 28.08.2026).
//
// Voraussetzung: Node 18+ (globales fetch). Falls der Server auf einer älteren
// Node-Version läuft, hier stattdessen 'node-fetch' importieren -- bitte vor
// dem ersten Einsatz mit `node --version` auf dem Server prüfen, das steht mir
// hier nicht zur Verfügung.

const TENANT_ID     = process.env.MAIL_GRAPH_TENANT_ID;
const CLIENT_ID     = process.env.MAIL_GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.MAIL_GRAPH_CLIENT_SECRET;

let cachedToken = null;   // { value, expiresAt }

async function holeToken() {
  const jetzt = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60000 > jetzt) {
    return cachedToken.value; // noch mind. 60s gültig
  }
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('MAIL_GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET fehlt in .env');
  }
  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    // Niemals Secret loggen -- nur Status/Fehlertext von Microsoft.
    throw new Error(`Graph-Token-Anfrage fehlgeschlagen (${r.status}): ${txt.slice(0, 300)}`);
  }
  const j = await r.json();
  cachedToken = { value: j.access_token, expiresAt: jetzt + (j.expires_in * 1000) };
  return cachedToken.value;
}

// anhaenge: [{ name, contentType, contentBytes(base64) }]
async function sendMail({ upn, an, betreff, htmlBody, anhaenge = [] }) {
  if (!upn) throw new Error('upn fehlt -- kein freigegebenes Postfach für diesen Bearbeiter hinterlegt');
  const token = await holeToken();

  const message = {
    subject: betreff,
    body: { contentType: 'HTML', content: htmlBody },
    toRecipients: [{ emailAddress: { address: an } }],
  };
  if (anhaenge.length) {
    message.attachments = anhaenge.map(a => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.name,
      contentType: a.contentType || 'application/octet-stream',
      contentBytes: a.contentBytes,
    }));
  }

  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(upn)}/sendMail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Graph sendMail fehlgeschlagen (${r.status}) für ${upn}: ${txt.slice(0, 300)}`);
  }
  // sendMail liefert bei Erfolg 202 Accepted ohne Body.
  return { ok: true };
}

module.exports = { sendMail };
