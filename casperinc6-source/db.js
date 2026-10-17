const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// Keep the DB file out of the repo; create its folder on first run.
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'casper.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS trips (
    id       INTEGER PRIMARY KEY,
    code     TEXT NOT NULL UNIQUE,
    name     TEXT NOT NULL,
    country  TEXT NOT NULL,
    price    INTEGER NOT NULL CHECK (price > 0),
    seats    INTEGER NOT NULL CHECK (seats >= 0),
    blurb    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id             INTEGER PRIMARY KEY,
    trip_id        INTEGER NOT NULL REFERENCES trips(id),
    guest          TEXT NOT NULL,
    email          TEXT NOT NULL,
    seats          INTEGER NOT NULL CHECK (seats > 0),
    total          INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
    stripe_session TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS premium_subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_identifier TEXT NOT NULL,
    tier            TEXT NOT NULL DEFAULT 'free',
    expires_at      TEXT NOT NULL,
    monthly_bookings INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_email   ON bookings(email);
  CREATE INDEX IF NOT EXISTS idx_bookings_trip    ON bookings(trip_id);
`);

// Migration for databases created before Stripe support: add the new
// columns/constraints when missing so old data files keep working.
const cols = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
if (!cols.includes('stripe_session')) {
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE bookings_new (
      id             INTEGER PRIMARY KEY,
      trip_id        INTEGER NOT NULL REFERENCES trips(id),
      guest          TEXT NOT NULL,
      email          TEXT NOT NULL,
      seats          INTEGER NOT NULL CHECK (seats > 0),
      total          INTEGER NOT NULL,
      status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
      stripe_session TEXT,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO bookings_new (id, trip_id, guest, email, seats, total, status, stripe_session, created_at)
      SELECT id, trip_id, guest, email, seats, total, status, NULL, created_at FROM bookings;
    DROP TABLE bookings;
    ALTER TABLE bookings_new RENAME TO bookings;`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Safe on both fresh (column exists) and migrated databases.
db.exec('CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings(stripe_session);');

// Seed trips once. Seats live here too, so availability survives restarts.
const tripCount = db.prepare('SELECT COUNT(*) AS n FROM trips').get().n;
if (tripCount === 0) {
  const insert = db.prepare(
    'INSERT INTO trips (id, code, name, country, price, seats, blurb) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const seed = [
    [1, 'CPT', 'Cape Town',      'South Africa', 480, 12, 'Table Mountain sunsets, penguins at Boulders Beach, wine country day trips.'],
    [2, 'NBO', 'Nairobi Safari', 'Kenya',        890,  8, 'Big five game drives in the Maasai Mara with local guides.'],
    [3, 'MRS', 'Marrakesh',      'Morocco',      410, 15, 'Medina souks, rooftop tagine dinners, Atlas Mountains sunrise hike.'],
    [4, 'ZAN', 'Zanzibar',       'Tanzania',     620, 10, 'White-sand beaches, Spice Tour, dhow sunset cruise.'],
  ];
  db.exec('BEGIN');
  try {
    for (const row of seed) insert.run(...row);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = db;
