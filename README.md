# KALLE-KULATOR

Internes Kalkulationstool der Grafe AG, Birsfelden.

## Für Mitarbeiter

```
http://[Server-IP]:8765/
```

## Struktur

```
kalle-server/
├── public/
│   ├── index.html       ← KALLE-KULATOR App
│   └── kunden.json      ← Kundenstamm (aus SelectLine)
├── src/
│   ├── server.js        ← Node.js Backend
│   ├── db/              ← PostgreSQL Verbindung
│   └── routes/          ← API Endpoints
├── scripts/
│   ├── migrate.js       ← npm run db:migrate
│   └── seed.js          ← npm run db:seed
└── .env.example         ← Konfigurationsvorlage
```

## Server Setup

Siehe `KALLE_IT_Setup_NodeJS.docx` für vollständige Anleitung.

```bash
cd kalle-server
npm install
cp .env.example .env   # Konfiguration anpassen
npm run db:migrate
npm run db:seed
npm start
```

## Updates einspielen

```bash
git pull
# Server-Neustart nur wenn sich kalle-server/src/ geändert hat
```

## Kontakt

Sven Kurtz · sven.kurtz@grafe.ch · 061 421 24 02
