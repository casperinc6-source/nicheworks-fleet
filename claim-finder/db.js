const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'claims.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS claims (
    id         INTEGER PRIMARY KEY,
    item       TEXT NOT NULL,
    state      TEXT NOT NULL DEFAULT '',
    url        TEXT NOT NULL DEFAULT '',
    value_cents INTEGER NOT NULL DEFAULT 0 CHECK (value_cents >= 0),
    status     TEXT NOT NULL DEFAULT 'researching' CHECK (status IN ('researching','filed','waiting','paid','closed')),
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS premium_subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_identifier TEXT NOT NULL,
    tier            TEXT NOT NULL DEFAULT 'free',
    expires_at      TEXT NOT NULL,
    monthly_claims  INTEGER NOT NULL DEFAULT 0
  );
  `);

const listClaims = () =>
  db.prepare('SELECT * FROM claims ORDER BY id DESC').all();

const createClaim = (c) => {
  const info = db
    .prepare('INSERT INTO claims (item, state, url, value_cents, status, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(c.item, c.state, c.url, c.value_cents, c.status, c.notes);
  return db.prepare('SELECT * FROM claims WHERE id = ?').get(info.lastInsertRowid);
};

const updateStatus = (id, status) => {
  const info = db
    .prepare("UPDATE claims SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(status, id);
  if (info.changes === 0) return null;
  return db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
};

const deleteClaim = (id) =>
  db.prepare('DELETE FROM claims WHERE id = ?').run(id).changes;

module.exports = { listClaims, createClaim, updateStatus, deleteClaim };
