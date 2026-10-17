const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3002;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'growth.db'));

// Premium tier configuration
const PREMIUM_PRICE_CENTS = 500; // $5.00 / month
const PREMIUM_TIER_MONTHLY = 5 * 100; // 5 entries/month for free, premium gets more
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS entries (
    id      INTEGER PRIMARY KEY,
    kind    TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
    label   TEXT NOT NULL,
    amount  INTEGER NOT NULL CHECK (amount > 0),
    day     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_entries_day ON entries(day);
  CREATE TABLE IF NOT EXISTS premium_subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_identifier TEXT NOT NULL,
    tier            TEXT NOT NULL DEFAULT 'free',
    expires_at      TEXT NOT NULL,
    monthly_entries INTEGER NOT NULL DEFAULT 0
  );
`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e5) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } });
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

// ---------------------------------------------------------------------------
const routes = [
  // Premium tier routes
  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      try {
        const { userId = 'anonymous' } = req.body || {};
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days for trial
        const result = db.prepare(
          "INSERT INTO premium_subscriptions (user_identifier, tier, expires_at, monthly_entries) VALUES (?, ?, ?, ?)"
        ).run(userId, 'premium', expiresAt.toISOString(), 0);
        send(res, 201, {
          success: true,
          tier: 'premium',
          expiresAt: expiresAt.toISOString(),
          monthlyEntriesRemaining: 50, // premium gets 50 entries/month
          message: 'Subscribed to premium tier for $5.00/month'
        });
      } catch (e) { send(res, 400, { error: e.message }); }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/premium\/status$/,
    handler: (req, res) => {
      try {
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
        // Check Payoneer token = premium
        if (token === PAYONEER_TOKEN) {
          const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ?').get('current');
          if (sub && new Date() < new Date(sub.expires_at)) {
            const entriesUsed = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE created_at >= ?').all(new Date().toISOString().slice(0, 10));
            send(res, 200, {
              premium: true,
              tier: 'premium',
              monthlyEntriesRemaining: Math.max(0, 50 - (entriesUsed?.n || 0)),
              message: 'Premium active - 50 entries/month'
            });
          } else {
            // Create a default subscription
            const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at, monthly_entries) VALUES (?, ?, ?, ?)').run('current', 'premium', expiresAt.toISOString(), 0);
            send(res, 200, {
              premium: true,
              tier: 'premium',
              monthlyEntriesRemaining: 50,
              message: 'Premium active - 50 entries/month'
            });
          }
        } else {
          // Free tier status
          const entriesUsed = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE created_at >= ?').all(new Date().toISOString().slice(0, 10));
          send(res, 200, {
            premium: false,
            tier: 'free',
            monthlyEntriesRemaining: Math.max(0, 5 - (entriesUsed?.n || 0)),
            message: 'Free tier - 5 entries/month limit'
          });
        }
      } catch (e) { send(res, 500, { error: e.message }); }
    },
  },
  {
    method: 'GET', pattern: /^\/api\/entries$/,
    handler: (req, res) => {
      try {
        // Check premium status for entry limits
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
        let monthlyLimit = 5; // free tier default
        let premium = false;
        
        if (token === PAYONEER_TOKEN) {
          premium = true;
          monthlyLimit = 50;
        }
        
        const rows = db.prepare('SELECT * FROM entries ORDER BY day DESC, id DESC LIMIT ?').all(monthlyLimit + 10);
        const rowsMap = rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, amount: r.amount, day: r.day }));
        
        // Check if user hit the limit
        const countSoFar = rowsMap.length;
        const hasMore = countSoFar > monthlyLimit;
        
        if (hasMore) {
          // Return only the limit number
          const limitedRows = rowsMap.slice(0, monthlyLimit);
          send(res, 200, { entries: limitedRows, hasMore, monthlyLimit, premium });
        } else {
          send(res, 200, { entries: rowsMap, hasMore: false, monthlyLimit, premium });
        }
      } catch (e) { send(res, 400, { error: e.message }); }
    },
  },
  {
    method: 'POST', pattern: /^\/api\/entries$/,
    handler: async (req, res) => {
      try {
        const b = await readBody(req);
        const kind = b.kind === 'income' || b.kind === 'expense' ? b.kind : null;
        const amount = Math.round(Number(b.amount) * 100); // dollars -> cents
        const label = String(b.label || '').trim();
        const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || '')) ? b.day : new Date().toISOString().slice(0, 10);
        
        // Check entry limits based on premium status
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
        let monthlyLimit = 5; // free tier default
        let premium = false;
        
        if (token === PAYONEER_TOKEN) {
          premium = true;
          monthlyLimit = 50;
        } else {
          // Check free tier limit
          const entriesUsed = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE created_at >= ?').all(new Date().toISOString().slice(0, 10));
          if (entriesUsed && entriesUsed.n >= 5) {
            return send(res, 402, {
              error: 'Monthly entry limit reached',
              remaining: 0,
              limit: 5
            });
          }
        }
        
        if (!kind) return send(res, 400, { error: "kind must be 'income' or 'expense'" });
        if (!Number.isFinite(amount) || amount <= 0) return send(res, 400, { error: 'amount must be > 0' });
        if (label.length < 2) return send(res, 400, { error: 'label required' });
        
        // Track premium subscription entry count
        if (premium) {
          db.prepare('UPDATE premium_subscriptions SET monthly_entries = monthly_entries + 1 WHERE user_identifier = ?').run('current');
        } else {
          db.prepare('UPDATE premium_subscriptions SET monthly_entries = monthly_entries + 1 WHERE user_identifier = ?').run('current');
        }
        
        const info = db.prepare('INSERT INTO entries (kind, label, amount, day) VALUES (?, ?, ?, ?)').run(kind, label, amount, day);
        send(res, 201, { id: info.lastInsertRowid, kind, label, amount, day });
      } catch (e) { send(res, 400, { error: e.message }); }
    },
  },
  {
    method: 'GET', pattern: /^\/api\/summary$/,
    handler: (req, res) => {
      try {
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
        let premium = false;
        let monthlyLimit = 5;
        
        if (token === PAYONEER_TOKEN) {
          premium = true;
          monthlyLimit = 50;
        }
        
        const totals = db.prepare(
          "SELECT SUM(CASE WHEN kind='income' THEN amount ELSE 0 END) AS income, SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END) AS expense, COUNT(*) AS n FROM entries"
        ).get();
        const net = (totals.income || 0) - (totals.expense || 0);
        const byDay = db.prepare(
          "SELECT day, SUM(CASE WHEN kind='income' THEN amount ELSE 0 END) - SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END) AS net FROM entries GROUP BY day ORDER BY day"
        ).all();
        let running = 0;
        const curve = byDay.map((d) => { running += d.net; return { day: d.day, net: running }; });
        
        // Premium gets enhanced summary with projections
        let projection = null;
        if (premium) {
          // Simple projection based on current growth rate
          const incomeTotals = db.prepare("SELECT SUM(CASE WHEN kind='income' THEN amount ELSE 0 END) AS income FROM entries").get();
          const expenseTotals = db.prepare("SELECT SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END) AS expense FROM entries").get();
          const currentNet = (incomeTotals?.income || 0) - (expenseTotals?.expense || 0);
          projection = {
            currentNet,
            projected30d: Math.round(currentNet * 1.2), // 20% growth projection
            projected90d: Math.round(currentNet * 1.5)
          };
        }
        
        send(res, 200, {
          income: (totals.income || 0) / 100,
          expense: (totals.expense || 0) / 100,
          net: net / 100,
          entries: totals.n,
          curve, // cumulative net growth by day, from zero
          premium,
          projection
        });
      } catch (e) { send(res, 500, { error: e.message }); }
    },
  },
];

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, 'http://x').pathname;
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
  console.log(`zero-growth-app tracking growth on http://localhost:${PORT}`);
});
