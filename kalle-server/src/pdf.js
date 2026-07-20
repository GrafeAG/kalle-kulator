// src/pdf.js — HTML → PDF Rendering für KALLE-KULATOR
// ----------------------------------------------------------------------------
// Rendert die (bereits druckfertige) Offerten-HTML serverseitig zu PDF (A4).
// Nutzt Puppeteer mit eigenem Chromium. Der Browser wird EINMAL gestartet und
// für alle weiteren Offerten wiederverwendet (schnell + ressourcenschonend).
//
// Installation auf dem Server (einmalig, im Ordner kalle-server):
//   npm install puppeteer
// (lädt beim ersten Mal ein eigenes Chromium herunter ~150 MB)
//
// Optional: eigenen Browser erzwingen via Umgebungsvariable in .env, z.B.
//   PUPPETEER_EXECUTABLE_PATH=C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe
// (dann kein Chromium-Download nötig — Puppeteer respektiert diese Variable
//  automatisch beim Start.)
// ----------------------------------------------------------------------------

let _browserPromise = null;

// Startet Chromium (bzw. den in PUPPETEER_EXECUTABLE_PATH gesetzten Browser)
// und hält genau eine Instanz vor. Bei Verbindungsverlust wird neu gestartet.
async function getBrowser() {
  const puppeteer = require('puppeteer'); // lazy: klare Fehlermeldung wenn nicht installiert

  if (_browserPromise) {
    try {
      const b = await _browserPromise;
      const alive = typeof b.connected === 'boolean' ? b.connected
                  : (typeof b.isConnected === 'function' ? b.isConnected() : true);
      if (alive) return b;
    } catch (_) { /* unten neu starten */ }
    _browserPromise = null;
  }

  _browserPromise = puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  }).catch(err => {
    _browserPromise = null;                 // Fehlstart nicht cachen
    throw err;
  });

  return _browserPromise;
}

// Entfernt das eingebettete Auto-Print-Script aus der Offerten-HTML — beim
// serverseitigen Rendern lösen wir den PDF-Druck selbst aus, nicht window.print().
function stripAutoPrint(html) {
  return String(html).replace(
    /<script>\s*window\.onload\s*=\s*\(\)\s*=>\s*window\.print\(\)\s*;?\s*<\/script>/gi, ''
  );
}

// Wandelt HTML in ein PDF (Buffer) um. Respektiert die @page-Regeln der HTML
// (A4 + Ränder) dank preferCSSPageSize.
async function htmlToPdf(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.emulateMediaType('print');
    await page.setContent(stripAutoPrint(html), { waitUntil: 'networkidle0', timeout: 60000 });
    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,   // nutzt @page{size:A4;margin:...} aus der Offerten-HTML
      format: 'A4',              // Fallback, falls keine @page-Regel vorhanden
    });
    return pdf;
  } finally {
    await page.close().catch(() => {});
  }
}

// Sauberes Herunterfahren (optional beim Server-Stop aufrufbar).
async function closeBrowser() {
  if (!_browserPromise) return;
  try { const b = await _browserPromise; await b.close(); } catch (_) {}
  _browserPromise = null;
}

module.exports = { htmlToPdf, closeBrowser };
