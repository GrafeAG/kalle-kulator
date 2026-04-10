// src/db/index.js — PostgreSQL Verbindung
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'kalle',
  user:     process.env.DB_USER     || 'kalle_user',
  password: process.env.DB_PASSWORD || '',
  max: 10,                    // max Verbindungen im Pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('[DB] Unerwarteter Fehler:', err.message);
});

// Hilfsfunktion für einfache Queries
async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

// Verbindung testen
async function testConnection() {
  try {
    const res = await query('SELECT NOW() as zeit');
    console.log('[DB] Verbindung OK —', res.rows[0].zeit);
    return true;
  } catch (err) {
    console.error('[DB] Verbindung fehlgeschlagen:', err.message);
    return false;
  }
}

module.exports = { pool, query, testConnection };
