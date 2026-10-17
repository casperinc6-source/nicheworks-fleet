const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { listClaims, createClaim, updateStatus, deleteClaim } = require('./db');
const STATES = require('./sources').STATES;
const NAUPA = require('./sources').NAUPA;
const AUCTIONS = require('./sources').AUCTIONS;
const MISSINGMONEY = require('./sources').MISSINGMONEY;

const PORT = process.env.PORT || 3007;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(__dirname, 'claims.db'));

db.exec(`PRAGMA journal_mode = WAL;
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

  CREATE INDEX IF NOT EXISTS idx_claims_email ON claims(state);
`);

function send(res, status, data) {
  const isStr = typeof data === 'string';
  res.writeHead(status, {
    'Content-Type': isStr ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
  });
  res.end(isStr ? data : JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, '<h1>404</h1>');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Premium tier configuration
const PREMIUM_PRICE_CENTS = 5000; // $50.00 / year for premium claims access
const PREMIUM_TIER_MONTHLY = 30; // 30 claims/month for premium
const PREMIUM_FEATURES = [
  'all_states',
  'priority_processing',
  'unlimited_claims',
  'export_results'
];

// ---------------------------------------------------------------------------
// API router
// ---------------------------------------------------------------------------
const routes = [
  // Get all states
  {
    method: 'GET',
    pattern: /^\/api\/states$/,
    handler: (req, res) => {
      const states = STATES.map(([code, name, url]) => ({
        code,
        name,
        url,
        fallback: NAUPA,
        source: 'official state program (free to search & claim)',
      }));
      return send(res, 200, { count: states.length, states, auctions: AUCTIONS, missingmoney: MISSINGMONEY });
    },
  },

  // Get all claims
  {
    method: 'GET',
    pattern: /^\/api\/claims$/,
    handler: (req, res) => send(res, 200, listClaims()),
  },

  // Create a new claim (free tier: 3/year limit)
  {
    method: 'POST',
    pattern: /^\/api\/claims$/,
    handler: async (req, res) => {
      try {
        const b = await readBody(req);
        const item = String(b.item || '').trim();
        const stateInput = String(b.state || '').trim();
        const value = Math.round(Number(b.value) * 100); // dollars -> cents
        const status = STATUSES.includes(b.status) ? b.status : 'researching';
        const notes = String(b.notes || '').trim().slice(0, 2000);

        if (item.length < 2) return send(res, 400, { error: 'item required (2+ chars)' });
        if (stateInput.length > 40) return send(res, 400, { error: 'state too long' });
        if (!Number.isFinite(value) || value < 0) return send(res, 400, { error: 'value must be >= 0' });
        if (!/^https?:\/\//.test(String(b.url || ''))) return send(res, 400, { error: 'url must start with http(s)://' });

        // Check free tier limit
        const claimsUsed = db.prepare('SELECT COUNT(*) AS n FROM claims').get().n;
        if (claimsUsed >= 3 && !isPremium()) {
          return send(res, 402, {
            error: 'Monthly claim limit reached',
            remaining: 0,
            limit: 3,
            message: 'Free tier - 3 claims/year limit. Subscribe to premium for 30 claims/year.',
          });
        }

        const row = createClaim({ item, state: stateInput, url: String(b.url), value_cents: value, status, notes });
        return send(res, 201, row);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    },
  },

  // Update claim status
  {
    method: 'PATCH',
    pattern: /^\/api\/claims\/(\d+)$/,
    handler: async (req, res, m) => {
      try {
        const b = await readBody(req);
        if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'bad status' });
        const row = updateStatus(Number(m[1]), b.status);
        if (!row) return send(res, 404, { error: 'Claim not found' });
        return send(res, 200, row);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    },
  },

  // Delete a claim
  {
    method: 'DELETE',
    pattern: /^\/api\/claims\/(\d+)$/,
    handler: (req, res, m) => {
      const changes = deleteClaim(Number(m[1]));
      if (!changes) return send(res, 404, { error: 'Claim not found' });
      return send(res, 200, { deleted: Number(m[1]) });
    },
  },

  // Premium subscription routes
  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      try {
        const { userId = 'anonymous' } = req.body || {};
        const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year
        const result = db.prepare(
          'INSERT INTO premium_subscriptions (user_identifier, tier, expires_at, monthly_claims) VALUES (?, ?, ?, ?)'
        ).run(userId, 'premium', expiresAt.toISOString(), 0);
        send(res, 201, {
          success: true,
          tier: 'premium',
          expiresAt: expiresAt.toISOString(),
          monthlyClaimsRemaining: 30, // premium gets 30 claims/year
          message: 'Subscribed to premium tier for $50.00/year',
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
        // Check for premium access
        if (token) {
          const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ?').get('current');
          if (sub && new Date() < new Date(sub.expires_at)) {
            const claimsUsed = db.prepare('SELECT COUNT(*) AS n FROM claims WHERE created_at >= ?').all(new Date().toISOString().slice(0, 10));
            send(res, 200, {
              premium: true,
              tier: 'premium',
              monthlyClaimsRemaining: Math.max(0, 30 - (claimsUsed?.n || 0)),
              message: 'Premium active - 30 claims/year',
            });
          } else {
            // Create a default subscription
            const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
            db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at, monthly_claims) VALUES (?, ?, ?, ?)').run('current', 'premium', expiresAt.toISOString(), 0);
            send(res, 200, {
              premium: true,
              tier: 'premium',
              monthlyClaimsRemaining: 30,
              message: 'Premium active - 30 claims/year',
            });
          }
        } else {
          // Free tier status
          const claimsUsed = db.prepare('SELECT COUNT(*) AS n FROM claims WHERE created_at >= ?').all(new Date().toISOString().slice(0, 10));
          send(res, 200, {
            premium: false,
            tier: 'free',
            monthlyClaimsRemaining: Math.max(0, 3 - (claimsUsed?.n || 0)),
            message: 'Free tier - 3 claims/year limit',
          });
        }
      } catch (e) { send(res, 500, { error: e.message }); }
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
  console.log(`claim-finder serving on http://localhost:${PORT}`);
});