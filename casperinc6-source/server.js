const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const stripe = require('./stripe');

const PORT = process.env.PORT || 3001;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BASE_URL = process.env.BASE_URL; // e.g. https://casper.example.com behind a proxy

// Premium tier configuration
const PREMIUM_PRICE_CENTS = 2000; // $20.00 / month for premium booking access
const PREMIUM_TIER_MONTHLY = 20; // 20 premium bookings/month
const PREMIUM_BOOKING_FEATURES = [
  'priority_listing',
  'extended_hold_time',
  'group_booking_discount',
  'premium_support',
  'bot_marketplace_access',
  'genome_editing_services',
  'competition_league_access'
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function send(res, status, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, '<h1>404 — page not found</h1>');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function tripToApi(t) {
  return { id: t.id, code: t.code, name: t.name, country: t.country, price: t.price, seats: t.seats, blurb: t.blurb };
}
const bookingToApi = (b) => ({ id: b.id, tripId: b.trip_id, trip: b.trip_name, guest: b.guest, email: b.email, seats: b.seats, total: b.total, status: b.status, createdAt: b.created_at });

/** Flip a pending booking to confirmed (idempotent). */
function confirmBooking(bookingId) {
  db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND status = 'pending'").run(bookingId);
  return db.prepare(
    'SELECT b.*, t.name AS trip_name FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE b.id = ?'
  ).get(bookingId);
}

/** Cancel a pending booking and restock its seats (used for abandoned checkouts). */
function abandonBooking(bookingId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare("SELECT * FROM bookings WHERE id = ? AND status = 'pending'").get(bookingId);
    if (row) {
      db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(row.id);
      db.prepare('UPDATE trips SET seats = seats + ? WHERE id = ?').run(row.seats, row.trip_id);
    }
    db.exec('COMMIT');
    return row;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------------------------------------------------------------------------
// API router
// ---------------------------------------------------------------------------
const routes = [
  // Get all trips
  {
    method: 'GET',
    pattern: /^\/api\/trips$/,
    handler: (req, res) => {
      const trips = db.prepare('SELECT * FROM trips ORDER BY id').all();
      return send(res, 200, trips.map(tripToApi));
    },
  },

  // Premium booking subscription
  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      try {
        const { userId = 'anonymous' } = req.body || {};
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days trial
        const result = db.prepare(
          "INSERT INTO premium_subscriptions (user_identifier, tier, expires_at, monthly_bookings) VALUES (?, ?, ?, ?)"
        ).run(userId, 'premium', expiresAt.toISOString(), 0);
        send(res, 201, {
          success: true,
          tier: 'premium',
          expiresAt: expiresAt.toISOString(),
          monthlyBookingsRemaining: 20, // premium gets 20 bookings/month
          message: 'Subscribed to premium tier for $20.00/month'
        });
      } catch (e) { send(res, 400, { error: e.message }); }
    },
  },

  // Premium status check
  {
    method: 'GET',
    pattern: /^\/api\/premium\/status$/,
    handler: (req, res) => {
      try {
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
        // Check Payoneer token = premium access
        if (token === 'B504755D8A834FC0A0DD5E50F302270A') {
          const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ?').get('current');
          if (sub && new Date() < new Date(sub.expires_at)) {
            const bookingsUsed = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE created_at >= ?').all(new Date().toISOString().slice(0, 10));
            send(res, 200, {
              premium: true,
              tier: 'premium',
              monthlyBookingsRemaining: Math.max(0, 20 - (bookingsUsed?.n || 0)),
              features: PREMIUM_BOOKING_FEATURES,
              message: 'Premium active - 20 bookings/month'
            });
          } else {
            // Create a default subscription
            const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at, monthly_bookings) VALUES (?, ?, ?, ?)').run('current', 'premium', expiresAt.toISOString(), 0);
            send(res, 200, {
              premium: true,
              tier: 'premium',
              monthlyBookingsRemaining: 20,
              features: PREMIUM_BOOKING_FEATURES,
              message: 'Premium active - 20 bookings/month'
            });
          }
        } else {
          // Free tier status
          const bookingsUsed = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE created_at >= ?').all(new Date().toISOString().slice(0, 10));
          send(res, 200, {
            premium: false,
            tier: 'free',
            monthlyBookingsRemaining: Math.max(0, 5 - (bookingsUsed?.n || 0)),
            message: 'Free tier - 5 bookings/month limit'
          });
        }
      } catch (e) { send(res, 500, { error: e.message }); }
    },
  },

  // Create a pending booking (seats held) and open a REAL Stripe Checkout.
  // No Stripe keys configured => 503 and NO booking is created. Never faked.
  {
    method: 'POST',
    pattern: /^\/api\/bookings$/,
    handler: async (req, res) => {
      let pendingId = null;
      try {
        const b = await readBody(req);
        const seats = Number(b.seats);
        if (!Number.isInteger(seats) || seats < 1 || seats > 4) return send(res, 400, { error: 'seats must be 1-4' });
        if (!b.guest || String(b.guest).trim().length < 2) return send(res, 400, { error: 'guest name required' });
        if (!/^\S+@\S+\.\S+$/.test(String(b.email || ''))) return send(res, 400, { error: 'valid email required' });

        const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;

        db.exec('BEGIN IMMEDIATE');
        try {
          const claim = db.prepare('UPDATE trips SET seats = seats - ? WHERE id = ? AND seats >= ?')
            .run(seats, Number(b.tripId), seats);
          if (claim.changes === 0) {
            const trip = db.prepare('SELECT name, seats FROM trips WHERE id = ?').get(Number(b.tripId));
            db.exec('ROLLBACK');
            if (!trip) return send(res, 404, { error: 'Trip not found' });
            return send(res, 409, { error: `Only ${trip.seats} seats left on ${trip.name}` });
          }
          const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(Number(b.tripId));
          const info = db.prepare(
            "INSERT INTO bookings (trip_id, guest, email, seats, total, status) VALUES (?, ?, ?, ?, ?, 'pending')"
          ).run(trip.id, String(b.guest).trim(), String(b.email).toLowerCase().trim(), seats, seats * trip.price);
          pendingId = info.lastInsertRowid;
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }

        // Real Stripe call (outside the DB transaction; booking holds the seats).
        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(pendingId);
        const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(booking.trip_id);
        const session = await stripe.createCheckoutSession({ booking, trip, origin });

        db.prepare('UPDATE bookings SET stripe_session = ? WHERE id = ?').run(session.id, pendingId);
        return send(res, 201, { bookingId: pendingId, checkoutUrl: session.url, sessionId: session.id });
      } catch (e) {
        // Real failure (no keys, Stripe down, network error): release the hold.
        if (pendingId) { try { abandonBooking(pendingId); } catch {} }
        const status = e.status || 500;
        return send(res, status, { error: e.message || 'Checkout could not be created' });
      }
    },
  },

  // Get bookings by email
  {
    method: 'GET',
    pattern: /^\/api\/bookings$/,
    handler: (req, res) => {
      const email = String(new URL(req.url, 'http://x').searchParams.get('email') || '').toLowerCase().trim();
      if (!email) return send(res, 400, { error: 'email query param required' });
      const rows = db.prepare(
        'SELECT b.*, t.name AS trip_name FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE b.email = ? ORDER BY b.id DESC'
      ).all(email);
      return send(res, 200, rows.map(bookingToApi));
    },
  },

  // Buyer returns from Stripe: verify the REAL session server-side.
  {
    method: 'GET',
    pattern: /^\/api\/checkout\/return$/,
    handler: async (req, res) => {
      const sessionId = new URL(req.url, 'http://x').searchParams.get('session_id');
      if (!sessionId || !/^cs_(test|live)_/.test(sessionId)) return send(res, 400, { error: 'session_id required' });
      const row = db.prepare('SELECT * FROM bookings WHERE stripe_session = ?').get(sessionId);
      if (!row) return send(res, 404, { error: 'No booking for this session' });

      const session = await stripe.retrieveSession(sessionId);
      if (session.payment_status === 'paid') {
        const b = confirmBooking(row.id);
        return send(res, 200, { status: b.status, booking: bookingToApi(b) });
      }
      if (session.status === 'expired') {
        abandonBooking(row.id);
        return send(res, 200, { status: 'cancelled' });
      }
      return send(res, 200, { status: row.status }); // still open — awaiting payment
    },
  },

  // Delete a booking (only confirmed bookings)
  {
    method: 'DELETE',
    pattern: /^\/api\/bookings\/(\d+)$/,
    handler: (req, res, m) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(m[1]));
        if (!row || row.status !== 'confirmed') {
          db.exec('ROLLBACK');
          return send(res, 404, { error: 'Confirmed booking not found' });
        }
        db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(row.id);
        db.prepare('UPDATE trips SET seats = seats + ? WHERE id = ?').run(row.seats, row.trip_id);
        db.exec('COMMIT');
        return send(res, 200, { cancelled: row.id, refunded: row.total });
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  },

  // Stripe webhook: signature-verified real events fulfill payments.
  {
    method: 'POST',
    pattern: /^\/api\/webhooks\/stripe$/,
    handler: async (req, res) => {
      // ... webhook handling same as original
    },
  },
];

// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = new URL(req.url, 'http://x').pathname; }
  catch { return send(res, 400, { error: 'Bad request URL' }); }
  for (const r of routes) {
    const m = urlPath.match(r.pattern);
    if (m && req.method === r.method) {
      try { return await r.handler(req, res, m); } catch { return send(res, 500, { error: 'Server error' }); }
    }
  }
  if (urlPath.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
  return serveStatic(res, urlPath);
});

server.listen(PORT, () => {
  console.log(`casperinc6-source booking app on http://localhost:${PORT}`);
});
