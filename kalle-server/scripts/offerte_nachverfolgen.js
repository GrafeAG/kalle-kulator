// offerte_nachverfolgen.js — Auto-Subitem in der Gruppe „Offerprüfung Kunde / Vergabe"
//
// Regel: Jedes Projekt in der Gruppe „Offerprüfung Kunde / Vergabe" (Board 1012481465)
// bekommt EINMAL ein Subitem „Offerte nachverfolgen / Nachfragen" mit
//   • Datum   = +7 Arbeitstage (Mo–Fr) ab Erstellung
//   • Bearbeiter = der Projektleiter des Projekts (Spalte „Projektleiter")
// Bereits vorhandene Subitems mit diesem Namen werden NICHT doppelt angelegt.
//
// Läuft serverseitig (Monday-Token aus der .env). Alle paar Minuten per Aufgabenplanung
// starten (siehe LIESMICH.txt).  Manuell:  node scripts/offerte_nachverfolgen.js

const MONDAY_API   = 'https://api.monday.com/v2';
const BOARD        = 1012481465;                 // GRAFE Produktionsübersicht
const GROUP        = 'group_mm5p5zwq';           // „Offerprüfung Kunde / Vergabe"
const SUB_NAME     = 'Offerte nachverfolgen / Nachfragen';
const COL_PL       = 'people0';                  // Projektleiter (Hauptitem)
const SUB_PERSON   = 'person';                   // Bearbeiter (Subitem)
const SUB_DATE     = 'date0';                    // Datum (Subitem)
const WORKING_DAYS = 7;

// .env robust laden (absoluter Pfad relativ zum Skript: …/scripts → …/.env)
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch (e) {}
try { if(!process.env.MONDAY_TOKEN) require('dotenv').config(); } catch (e) {}

const TOKEN = process.env.MONDAY_TOKEN;
if (!TOKEN) { console.error('[Nachverfolgen] MONDAY_TOKEN fehlt — .env nicht gefunden?'); process.exit(1); }

// +N Arbeitstage (Sa/So zählen nicht) → 'YYYY-MM-DD'
function plusWerktage(n){
  const d = new Date(); let a = 0;
  while (a < n) { d.setDate(d.getDate()+1); const wd = d.getDay(); if (wd!==0 && wd!==6) a++; }
  return d.toISOString().slice(0,10);
}

async function gql(query, variables){
  const r = await fetch(MONDAY_API, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':TOKEN, 'API-Version':'2024-01' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// Projekte der Gruppe holen (inkl. Projektleiter + vorhandene Subitem-Namen)
async function fetchGroupItems(){
  const items = [];
  let cursor = null;
  do {
    const data = await gql(`
      query($cursor:String){
        boards(ids:${BOARD}){
          groups(ids:["${GROUP}"]){
            items_page(limit:100, cursor:$cursor){
              cursor
              items{
                id
                column_values(ids:["${COL_PL}"]){ value }
                subitems{ name }
              }
            }
          }
        }
      }`, { cursor });
    const g = data.boards[0].groups[0];
    if (!g) break;
    const page = g.items_page;
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

// Personen-IDs aus dem people-Wert lesen
function personsFrom(cv){
  try{
    const v = cv && cv[0] && cv[0].value;
    if(!v) return [];
    const o = JSON.parse(v);
    return (o.personsAndTeams||[]).map(p => ({ id:Number(p.id), kind:p.kind||'person' }));
  }catch(e){ return []; }
}

async function createSubitem(parentId, persons){
  const scv = {};
  scv[SUB_DATE]   = { date: plusWerktage(WORKING_DAYS) };
  if (persons.length) scv[SUB_PERSON] = { personsAndTeams: persons };
  const d = await gql(
    `mutation($cv:JSON!){ create_subitem(parent_item_id:${parentId}, item_name:${JSON.stringify(SUB_NAME)}, column_values:$cv){ id } }`,
    { cv: JSON.stringify(scv) }
  );
  return d && d.create_subitem && d.create_subitem.id;
}

(async () => {
  const items = await fetchGroupItems();
  let angelegt = 0, vorhanden = 0, ohnePL = 0;
  for (const it of items){
    const hat = (it.subitems||[]).some(s => (s.name||'').trim() === SUB_NAME);
    if (hat){ vorhanden++; continue; }
    const persons = personsFrom(it.column_values);
    if (!persons.length) ohnePL++;
    try{
      await createSubitem(it.id, persons);
      angelegt++;
    }catch(e){ console.error('[Nachverfolgen] Item '+it.id+':', e.message); }
  }
  console.log(`[Nachverfolgen ${new Date().toISOString().slice(0,10)}] Gruppe: ${items.length} Projekte · neu angelegt: ${angelegt} · schon vorhanden: ${vorhanden}${ohnePL?(' · ohne Projektleiter: '+ohnePL):''}`);
})().catch(e => { console.error('[Nachverfolgen] Fehler:', e.message); process.exit(1); });
