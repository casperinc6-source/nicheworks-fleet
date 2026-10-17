const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'paperclip.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS state (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    json       TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS premium_subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_identifier TEXT NOT NULL,
    tier            TEXT NOT NULL DEFAULT 'free',
    expires_at      TEXT NOT NULL,
    monthly_clips   INTEGER NOT NULL DEFAULT 100
  );
`);

const getState = () => {
  const row = db.prepare('SELECT json FROM state WHERE id = 1').get();
  return row ? JSON.parse(row.json) : null;
};

const saveState = (obj) => {
  db.prepare(
    "INSERT INTO state (id, json, updated_at) VALUES (1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) " +
    'ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at'
  ).run(JSON.stringify(obj));
  return db.prepare('SELECT updated_at FROM state WHERE id = 1').get().updated_at;
};

const clearState = () => db.prepare('DELETE FROM state WHERE id = 1').run();

module.exports = { getState, saveState, clearState };
