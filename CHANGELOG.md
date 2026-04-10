# KALLE-KULATOR Changelog

## v2.1.0 — April 2026

### Neue Features
- **Reliefschriften** (ehemals Fräsbuchstaben): Umbenannt + 3 Herstellungsarten
  - Fräsen (wie bisher)
  - Laserschnitt (Zukauf oder eigene Herstellung CO2 150W, CHF 75/h, Rüst 10 Min.)
  - Wasserstrahlschnitt (immer Zukauf, EK + Marge 40%)
- **Manuelle Buchstabenanzahl**: Checkbox überschreibt automatische Erkennung
- **Textposition**: Neuer Positionstyp ohne Kalkulation (Hinweis/Bemerkung/Info)
- **Kundenstamm-Autocomplete**: 9'674 Kunden aus SelectLine, Suche nach Name/Nr.
- **SelectLine CSV-Export**: BELEG.CSV + BELEGP.CSV gemäss Schnittstellenbeschreibung
- **Adressfelder aufgeteilt**: Strasse, PLZ, Ort als separate Felder
- **Nav-Reiter**: «Preise» umbenannt in «Administration»
- **Administration-Tabs**: Buttons jetzt ganz oben auf der Seite

### Bug Fixes
- PDF: Einzelpreis + Gesamtpreis in separaten Spalten (EP = VK/Stk, GP = Total)
- PDF: Menge zeigt tatsächliche Stückzahl (nicht mehr fix «1»)
- PDF: Keine Preisangaben (CHF) im Detailtext
- PDF: Neue Zeile pro Konfiguration statt «·» Trennung
- PDF: Zeitangaben (Min.) nur noch bei Montage-Konfiguration
- Brünieren: Keine Minutenangaben mehr in PDF

### Backend
- Node.js + PostgreSQL Server (kalle-server/)
- KALLE.html läuft über Webserver: http://[Server]:8765/
- Automatischer Kundenstamm-Import via kunden.json
