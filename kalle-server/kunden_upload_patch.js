// PATCH: /kunden/upload Endpoint
// In server.js nach app.get('/kunden') einfügen:

const fs = require('fs');
const path = require('path');
const KUNDEN_FILE = path.join(__dirname, 'data', 'KUNDEN.json');

// GET /kunden — Kundenstamm abrufen
app.get('/kunden', (req, res) => {
  try {
    if (fs.existsSync(KUNDEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(KUNDEN_FILE, 'utf8'));
      const liste = Array.isArray(data) ? data : (data.kunden || []);
      res.json(liste);
    } else {
      res.json([]);
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /kunden/upload — Kundenstamm speichern (aus KALLE Admin-Import)
app.post('/kunden/upload', express.json({ limit: '10mb' }), (req, res) => {
  try {
    const kunden = Array.isArray(req.body) ? req.body : (req.body.kunden || []);
    if (!kunden.length) return res.status(400).json({ error: 'Keine Kunden-Daten' });

    // data-Ordner anlegen falls nicht vorhanden
    const dir = path.dirname(KUNDEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(KUNDEN_FILE, JSON.stringify(kunden, null, 0), 'utf8');
    console.log('[KALLE] Kundenstamm gespeichert:', kunden.length, 'Einträge');
    res.json({ ok: true, anzahl: kunden.length });
  } catch(e) {
    console.error('[KALLE] Kunden-Upload Fehler:', e);
    res.status(500).json({ error: e.message });
  }
});
