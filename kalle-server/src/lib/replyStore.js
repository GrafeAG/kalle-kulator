// src/lib/replyStore.js
//
// Gemeinsamer Zwischenspeicher für Mail-Entwürfe, die der lokale grafemail:-
// Helfer abholt. Bewusst simpel (In-Memory, kein DB-Persistieren nötig) —
// ein Entwurf lebt nur zwischen "Nachfassen anklicken" und "in Outlook
// geöffnet" bzw. läuft nach 24h automatisch ab.
//
// Wird von mehreren Routen genutzt (aktuell reply.js + nachfassen.js,
// künftig auch für „Antwortmail" nutzbar) — deshalb als eigenes Modul,
// nicht in einer einzelnen Route versteckt.

const crypto = require('crypto');

const STORE = new Map(); // id -> draft
const TTL_MS = 24 * 60 * 60 * 1000;

function erstellen(draft) {
  const id = crypto.randomBytes(6).toString('hex');
  STORE.set(id, { ...draft, id, createdAt: Date.now(), gesendet: false });
  return id;
}

function holen(id) {
  const d = STORE.get(id);
  if (!d) return null;
  if (Date.now() - d.createdAt > TTL_MS) {
    STORE.delete(id);
    return null;
  }
  return d;
}

function alsGesendetMarkieren(id) {
  const d = STORE.get(id);
  if (!d) return null;
  d.gesendet = true;
  return d;
}

// Neu: bestehenden, noch nicht gesendeten Entwurf nachträglich ändern (z.B.
// weitere Anhänge hinzufügen/entfernen). Reines Object.assign — der Store
// selbst kennt kein festes Schema, siehe erstellen() oben.
function aktualisieren(id, patch) {
  const d = STORE.get(id);
  if (!d) return null;
  if (d.gesendet) return null; // ein bereits bestätigter Entwurf wird nicht mehr verändert
  Object.assign(d, patch);
  return d;
}

// Alte Entwürfe gelegentlich aufräumen (bei jedem 50. Aufruf reicht für die
// erwartete Nutzungsmenge völlig).
let calls = 0;
function aufraeumen() {
  calls++;
  if (calls % 50 !== 0) return;
  const now = Date.now();
  for (const [id, d] of STORE) {
    if (now - d.createdAt > TTL_MS) STORE.delete(id);
  }
}

module.exports = { erstellen, holen, alsGesendetMarkieren, aktualisieren, aufraeumen };
