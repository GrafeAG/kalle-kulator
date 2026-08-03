// email_updates.js — zieht per Drag&Drop ins Update-Feld gezogene E-Mails (.msg)
// als lesbaren Kommentar (Antwort unter die E-Mail) in Monday.
//
// Ablauf (alle 2 Min per Aufgabenplanung):
//   1. Neueste Updates durchsehen; jene mit .msg-Anhang finden.
//   2. Nur Updates auf den erlaubten Boards (Haupt- + Subelement-Board) berücksichtigen.
//   3. Ist die E-Mail noch nicht übernommen (keine Antwort mit „Ref <AssetId>"),
//      .msg herunterladen, auslesen und als Antwort-Kommentar posten.
//   4. Bereits übernommene E-Mails werden NICHT doppelt gepostet (Markierung in Monday).
//
// Läuft serverseitig (Monday-Token aus der .env). Manuell:  node scripts/email_updates.js
// Nur anzeigen ohne zu posten:  DRY_RUN=1 node scripts/email_updates.js
//
// Voraussetzung: npm i @kenjiuno/msgreader   (einmalig im kalle-server-Ordner)
//                .env mit  MONDAY_TOKEN=…     Node 18+

const MONDAY_API = 'https://api.monday.com/v2';

// Boards, auf denen E-Mails übernommen werden sollen:
//   1012481465 = GRAFE Produktionsübersicht (Projekte)
//   1012481470 = deren Subelemente (dorthin werden die Mails meist gezogen)
const ALLOWED_BOARDS = new Set(['1012481465', '1012481470']);

const SCAN_PAGES   = 5;                 // wie viele Seiten à 100 Updates rückwärts prüfen
const MAX_AGE_DAYS = 30;                // ältere Updates ignorieren (Sicherheitslimit)
const DRY_RUN      = !!process.env.DRY_RUN;

// .env robust laden (absoluter Pfad: …/scripts → …/.env)
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch (e) {}
try { if (!process.env.MONDAY_TOKEN) require('dotenv').config(); } catch (e) {}

const TOKEN = process.env.MONDAY_TOKEN;
if (!TOKEN) { console.error('[E-Mail] MONDAY_TOKEN fehlt — .env nicht gefunden?'); process.exit(1); }

let MsgReader;
try { MsgReader = require('@kenjiuno/msgreader').default; }
catch (e) { console.error('[E-Mail] Modul @kenjiuno/msgreader fehlt. Bitte einmalig:  npm i @kenjiuno/msgreader'); process.exit(1); }

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

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Absender hübsch machen: Exchange-DN (/O=EXCHANGELABS/…) verwerfen, echte Adresse bevorzugen
function niceSender(d) {
  const name = (d.senderName || '').trim();
  let mail = (d.senderSmtpAddress || d.senderEmail || '').trim();
  if (mail.startsWith('/') || /EXCHANGELABS/i.test(mail)) mail = '';
  if (name && mail && name.toLowerCase() !== mail.toLowerCase()) return `${name} <${mail}>`;
  return name || mail || '(unbekannt)';
}

function recipients(d) {
  return (d.recipients || [])
    .map(x => {
      const m = (x.smtpAddress || x.email || '').trim();
      const n = (x.name || '').trim();
      return n && m && n.toLowerCase() !== m.toLowerCase() ? `${n} <${m}>` : (n || m);
    })
    .filter(Boolean).join('; ');
}

function buildBody(d, assetId, filename) {
  const body = (d.body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const bodyHtml = esc(body).replace(/\n/g, '<br>');
  const dt = d.messageDeliveryTime || d.clientSubmitTime || d.creationTime || '';
  const head = [
    '<b>📧 E-Mail (aus Anhang übernommen)</b>',
    `<b>Betreff:</b> ${esc(d.subject)}`,
    `<b>Von:</b> ${esc(niceSender(d))}`,
    `<b>An:</b> ${esc(recipients(d))}`,
    `<b>Datum:</b> ${esc(String(dt))}`,
  ].join('<br>');
  const foot = `<br>—<br><i>automatisch aus ${esc(filename)} übernommen · Ref ${esc(assetId)}</i>`;
  return head + '<br><br>' + bodyHtml + foot;
}

// Kandidaten-Updates (mit .msg-Anhang) über mehrere Seiten sammeln
async function fetchCandidateUpdates() {
  const out = [];
  const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
  for (let page = 1; page <= SCAN_PAGES; page++) {
    const data = await gql(`
      query($page:Int){
        updates(limit:100, page:$page){
          id item_id created_at
          assets{ id name file_extension public_url }
          replies{ body }
        }
      }`, { page });
    const ups = (data && data.updates) || [];
    if (!ups.length) break;
    let allOld = true;
    for (const u of ups) {
      const t = Date.parse(u.created_at || '');
      if (!isNaN(t)) { if (t >= cutoff) allOld = false; else continue; }
      else allOld = false;
      const msgs = (u.assets || []).filter(a => (a.file_extension || '').toLowerCase() === '.msg');
      if (msgs.length) out.push({ ...u, msgs });
    }
    if (allOld) break;   // ganze Seite älter als Limit → aufhören
  }
  return out;
}

// Board-Zuordnung der Items (Batch) — nur erlaubte Boards zulassen
async function boardsForItems(itemIds) {
  const map = {};
  const ids = [...new Set(itemIds)];
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const data = await gql(`query($ids:[ID!]){ items(ids:$ids){ id board{ id } } }`, { ids: slice });
    (data.items || []).forEach(it => { map[it.id] = it.board && it.board.id; });
  }
  return map;
}

async function downloadMsg(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Download HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function postReply(itemId, parentId, body) {
  const d = await gql(
    `mutation($item:ID!,$parent:ID!,$body:String!){ create_update(item_id:$item, parent_id:$parent, body:$body){ id } }`,
    { item: itemId, parent: parentId, body }
  );
  return d && d.create_update && d.create_update.id;
}

(async () => {
  const cands = await fetchCandidateUpdates();
  const boardMap = await boardsForItems(cands.map(c => c.item_id));

  let neu = 0, schon = 0, uebersprungen = 0, fehler = 0;
  for (const u of cands) {
    const board = boardMap[u.item_id];
    if (!ALLOWED_BOARDS.has(String(board))) { uebersprungen++; continue; }
    const replyText = (u.replies || []).map(r => r.body || '').join('\n');
    for (const a of u.msgs) {
      if (replyText.includes('Ref ' + a.id)) { schon++; continue; }   // schon übernommen
      try {
        const buf = await downloadMsg(a.public_url);
        const data = new MsgReader(buf).getFileData();
        const body = buildBody(data, a.id, a.name || 'E-Mail.msg');
        if (DRY_RUN) { console.log(`[DRY] würde posten → Item ${u.item_id} · ${data.subject}`); neu++; continue; }
        await postReply(u.item_id, u.id, body);
        neu++;
      } catch (e) { fehler++; console.error(`[E-Mail] Update ${u.id} / Asset ${a.id}:`, e.message); }
    }
  }
  console.log(`[E-Mail ${new Date().toISOString().slice(0,16).replace('T',' ')}] Kandidaten: ${cands.length} · neu übernommen: ${neu} · schon vorhanden: ${schon}${uebersprungen?(' · fremdes Board: '+uebersprungen):''}${fehler?(' · Fehler: '+fehler):''}${DRY_RUN?'  (DRY_RUN)':''}`);
})().catch(e => { console.error('[E-Mail] Fehler:', e.message); process.exit(1); });
