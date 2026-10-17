/**
 * revenue — the fleet's own revenue desk.
 *
 * Every other app in the fleet sells something. This one adds it up. It reads
 * what each sibling actually charges (the PRICE_CENTS constants in their own
 * server.js), records the deals you really close, and computes MRR, ARR, churn
 * and per-product mix from those records.
 *
 *   GET  /api/catalog              what the fleet charges (scanned from the source)
 *   POST /api/events {type,...}    record a subscription, churn, refund, or one-time sale
 *   GET  /api/events               recent events
 *   GET  /api/summary              MRR, ARR, ARPU, churn, 30-day movement, per product
 *   GET  /api/forecast             paid: when the current rate reaches a target
 *   POST /api/targets {mrr_cents}  paid: set and compute a target
 *   GET  /api/premium/status
 *   POST /api/premium/subscribe    $99/mo
 *
 * HONESTY RULES:
 *   - Nothing is seeded. With no events, MRR is $0 and the page says $0 — it
 *     does not invent a baseline, a "pipeline", or a projection.
 *   - The catalog is read from the siblings' source at request time; if the
 *     sibling tree is not there (a lone deploy), it falls back to the same
 *     prices, and says which one it used.
 *   - Forecasts are arithmetic on your recorded rate, not a promise.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3025;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const ROOT = path.join(__dirname, '..');

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const DESK_PRICE_CENTS = 9900; // $99.00 / month

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'revenue.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS subscriptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer     TEXT NOT NULL,
    product      TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    cadence      TEXT NOT NULL DEFAULT 'monthly',
    status       TEXT NOT NULL DEFAULT 'active',
    started_at   TEXT NOT NULL,
    ended_at     TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    type         TEXT NOT NULL,
    customer     TEXT,
    product      TEXT,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    cadence      TEXT,
    note         TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS targets (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    mrr_cents  INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS premium_subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_identifier TEXT NOT NULL,
    tier            TEXT NOT NULL DEFAULT 'free',
    expires_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function send(res, status, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 2e5) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > limit) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); } });
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

function tokenOf(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

function isPremium(req) {
  return tokenOf(req) === PAYONEER_TOKEN;
}

// ---- catalog ----------------------------------------------------------------
// The prices below are the fallback. The live path greps each sibling's own
// server.js, so a price change there shows up here without being copied.
const FALLBACK = [
  { dir: 'audit-funnel', label: 'Watchtower', key: 'REPORT_PRICE_CENTS', cents: 4900, cadence: 'one_time' },
  { dir: 'audit-funnel', label: 'Watchtower monitoring', key: 'MONITORING_PRICE_CENTS', cents: 19900, cadence: 'monthly' },
  { dir: 'pqc-migration', label: 'Keysmith roadmap', key: 'ROADMAP_PRICE_CENTS', cents: 29900, cadence: 'one_time' },
  { dir: 'pqc-migration', label: 'Keysmith program', key: 'PROGRAM_PRICE_CENTS', cents: 99900, cadence: 'monthly' },
  { dir: 'agent-zero', label: 'Agent-Zero throne', key: 'THRONE_PRICE_CENTS', cents: 49900, cadence: 'monthly' },
  { dir: 'exelo', label: 'EXELO desk', key: 'DESK_PRICE_CENTS', cents: 19900, cadence: 'monthly' },
  { dir: 'ultron', label: 'Ultron sentry', key: 'SENTRY_PRICE_CENTS', cents: 9900, cadence: 'monthly' },
  { dir: 'deception', label: 'Deception net', key: 'NET_PRICE_CENTS', cents: 4900, cadence: 'monthly' },
  { dir: 'ruflow', label: 'Ruflow runner', key: 'RUNNER_PRICE_CENTS', cents: 2900, cadence: 'monthly' },
  { dir: 'saluki-desk', label: 'Saluki desk', key: 'DESK_PRICE_CENTS', cents: 2900, cadence: 'monthly' },
  { dir: 'aggregator', label: 'Aggregator pro', key: 'PRO_PRICE_CENTS', cents: 1900, cadence: 'monthly' },
  { dir: 'krypt-trader', label: 'Krypt trader', key: 'TRADER_PRICE_CENTS', cents: 1900, cadence: 'monthly' },
  { dir: 'esim-desk', label: 'eSIM nomad', key: 'NOMAD_PRICE_CENTS', cents: 900, cadence: 'monthly' },
  { dir: 'artcraft', label: 'Loom studio', key: 'STUDIO_PRICE_CENTS', cents: 900, cadence: 'monthly' },
  { dir: 'vault', label: 'Vault pro', key: 'PRO_PRICE_CENTS', cents: 500, cadence: 'monthly' },
  { dir: 'zero-growth-app', label: 'Growth premium', key: 'PREMIUM_PRICE_CENTS', cents: 500, cadence: 'monthly' },
  { dir: 'automaton-conway', label: 'Conway premium', key: 'PREMIUM_PRICE_CENTS', cents: 499, cadence: 'monthly' },
  { dir: 'reader', label: 'Reader', key: 'READER_PRICE_CENTS', cents: 300, cadence: 'monthly' },
  { dir: 'beige-cobras-scream', label: 'Cobras premium', key: 'PREMIUM_PRICE_CENTS', cents: 299, cadence: 'monthly' },
  { dir: 'claim-finder', label: 'ClaimFinder premium', key: 'PREMIUM_PRICE_CENTS', cents: 5000, cadence: 'annual' },
  { dir: 'hire-me/tracker', label: 'Hire-me tracker', key: 'PREMIUM_PRICE_CENTS', cents: 2000, cadence: 'monthly' },
  { dir: 'casperinc6-source', label: 'Casper premium', key: 'PREMIUM_PRICE_CENTS', cents: 2000, cadence: 'monthly' },
];

function cadenceFrom(comment) {
  if (/one[-\s]?time/i.test(comment)) return 'one_time';
  if (/\/\s*(yr|year)|annual|per year/i.test(comment)) return 'annual';
  return 'monthly';
}

function readCatalog() {
  const found = [];
  for (const entry of FALLBACK) {
    const file = path.join(ROOT, entry.dir, 'server.js');
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const re = new RegExp(`\\b${entry.key}\\s*=\\s*(\\d+)\\s*;?\\s*(//[^\\n]*)?`);
    const m = source.match(re);
    if (!m) continue;
    const cents = Number(m[1]);
    found.push({
      product: entry.product || entry.dir,
      label: entry.label,
      dir: entry.dir,
      constant: entry.key,
      cents,
      cadence: cadenceFrom(m[2] || ''),
      mrr_cents: cadenceFrom(m[2] || '') === 'annual' ? Math.round(cents / 12) : cadenceFrom(m[2] || '') === 'monthly' ? cents : 0,
    });
  }
  if (found.length >= 5) return { source: 'scanned', note: 'Read from each app’s own server.js at request time.', products: found };
  return {
    source: 'fallback',
    note: 'Sibling source not found next to this app, so the known prices are used.',
    products: FALLBACK.map((e) => ({
      product: e.dir, label: e.label, dir: e.dir, constant: e.key, cents: e.cents, cadence: e.cadence,
      mrr_cents: e.cadence === 'annual' ? Math.round(e.cents / 12) : e.cadence === 'monthly' ? e.cents : 0,
    })),
  };
}

const mrrOf = (row) => (row.cadence === 'annual' ? Math.round(row.amount_cents / 12) : row.cadence === 'one_time' ? 0 : row.amount_cents);

function summary() {
  const active = db.prepare("SELECT * FROM subscriptions WHERE status = 'active'").all();
  const mrr = active.reduce((s, r) => s + mrrOf(r), 0);
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const started = db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE started_at >= ?').get(since).n;
  const churned = db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'churned' AND ended_at >= ?").get(since).n;
  const oneTime = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS c FROM events WHERE type = 'one_time' AND created_at >= ?").get(since).c;
  const refunds = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS c FROM events WHERE type = 'refund' AND created_at >= ?").get(since).c;

  const mix = {};
  for (const row of active) {
    const key = row.product;
    mix[key] = mix[key] || { product: key, active: 0, mrr_cents: 0 };
    mix[key].active += 1;
    mix[key].mrr_cents += mrrOf(row);
  }
  const customers = new Set(active.map((r) => r.customer)).size;
  const atRisk = active.filter((r) => (r.cadence === 'monthly')).length;

  return {
    mrr_cents: mrr,
    arr_cents: mrr * 12,
    active_subscriptions: active.length,
    customers,
    arpu_cents: customers ? Math.round(mrr / customers) : 0,
    new_30d: started,
    churned_30d: churned,
    net_new_30d: started - churned,
    churn_rate_30d: active.length + churned ? Number((churned / (active.length + churned)).toFixed(4)) : 0,
    one_time_30d_cents: oneTime,
    refunds_30d_cents: refunds,
    monthly_subscriptions: atRisk,
    by_product: Object.values(mix).sort((a, b) => b.mrr_cents - a.mrr_cents),
    note: active.length
      ? 'Computed from the subscriptions recorded in this desk.'
      : 'No subscriptions recorded yet — MRR is $0 because nothing has been sold through this desk, not because the page is broken.',
  };
}

const EVENT_TYPES = ['subscribe', 'churn', 'one_time', 'refund', 'trial'];

// ---- HTTP -------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = new URL(req.url, 'http://x').pathname; }
  catch { return send(res, 400, { error: 'Bad request URL' }); }
  const premium = isPremium(req);

  try {
    if (urlPath === '/api/catalog') {
      const cat = readCatalog();
      return send(res, 200, cat);
    }

    if (urlPath === '/api/events' && req.method === 'POST') {
      const body = await readBody(req);
      const type = String(body.type || '');
      if (!EVENT_TYPES.includes(type)) return send(res, 400, { error: `type must be one of ${EVENT_TYPES.join(', ')}` });
      const customer = String(body.customer || '').trim();
      const product = String(body.product || '').trim();
      if (!customer || customer.length > 120) return send(res, 400, { error: 'customer is required (max 120 chars)' });
      if (!product || product.length > 80) return send(res, 400, { error: 'product is required (max 80 chars)' });
      const cadence = ['monthly', 'annual', 'one_time'].includes(body.cadence) ? body.cadence : 'monthly';
      let amount = Number(body.amount_cents);
      if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_00) {
        // Fall back to the catalog price for this product rather than guessing.
        const catalog = readCatalog().products;
        const match = catalog.find((p) => p.product === product || p.label === product);
        if (!match) return send(res, 400, { error: 'amount_cents is required (or use a product name from /api/catalog)' });
        amount = match.cents;
      }
      const now = new Date().toISOString();

      if (type === 'subscribe' || type === 'trial') {
        const existing = db.prepare("SELECT id FROM subscriptions WHERE status = 'active' AND customer = ? AND product = ?").get(customer, product);
        if (existing) return send(res, 409, { error: `${customer} already has an active ${product} subscription (#${existing.id})` });
        const info = db.prepare(
          'INSERT INTO subscriptions (customer, product, amount_cents, cadence, status, started_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(customer, product, type === 'trial' ? 0 : amount, cadence, 'active', now);
        db.prepare('INSERT INTO events (type, customer, product, amount_cents, cadence, note) VALUES (?, ?, ?, ?, ?, ?)')
          .run(type, customer, product, type === 'trial' ? 0 : amount, cadence, body.note ? String(body.note).slice(0, 300) : null);
        return send(res, 201, { id: Number(info.lastInsertRowid), type, customer, product, amount_cents: type === 'trial' ? 0 : amount, cadence });
      }

      if (type === 'churn') {
        const row = db.prepare("SELECT * FROM subscriptions WHERE status = 'active' AND customer = ? AND product = ?").get(customer, product);
        if (!row) return send(res, 404, { error: `No active ${product} subscription for ${customer}` });
        db.prepare("UPDATE subscriptions SET status = 'churned', ended_at = ? WHERE id = ?").run(now, row.id);
        db.prepare('INSERT INTO events (type, customer, product, amount_cents, cadence, note) VALUES (?, ?, ?, ?, ?, ?)')
          .run('churn', customer, product, row.amount_cents, row.cadence, body.note ? String(body.note).slice(0, 300) : null);
        return send(res, 200, { churned: row.id, customer, product, lost_mrr_cents: mrrOf(row) });
      }

      // one_time / refund: money moves without a subscription.
      db.prepare('INSERT INTO events (type, customer, product, amount_cents, cadence, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run(type, customer, product, amount, 'one_time', body.note ? String(body.note).slice(0, 300) : null);
      return send(res, 201, { type, customer, product, amount_cents: amount, affects_mrr: false });
    }

    if (urlPath === '/api/events' && req.method === 'GET') {
      const rows = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 50').all();
      return send(res, 200, { count: rows.length, events: rows });
    }

    if (urlPath === '/api/summary') {
      return send(res, 200, summary());
    }

    if (urlPath === '/api/targets' && req.method === 'POST') {
      if (!premium) return send(res, 402, { error: 'Targets are a desk feature', price_cents: DESK_PRICE_CENTS });
      const body = await readBody(req);
      const mrr = Number(body.mrr_cents);
      if (!Number.isFinite(mrr) || mrr <= 0) return send(res, 400, { error: 'mrr_cents must be a positive number' });
      db.prepare(
        "INSERT INTO targets (id, mrr_cents, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET mrr_cents = excluded.mrr_cents, updated_at = excluded.updated_at",
      ).run(Math.round(mrr), new Date().toISOString());
      return send(res, 200, { target_mrr_cents: Math.round(mrr) });
    }

    if (urlPath === '/api/forecast') {
      if (!premium) return send(res, 402, { error: 'Forecast is a desk feature', price_cents: DESK_PRICE_CENTS });
      const s = summary();
      const t = db.prepare('SELECT mrr_cents FROM targets WHERE id = 1').get();
      const target = t ? t.mrr_cents : 100000;
      const catalog = readCatalog().products.filter((p) => p.mrr_cents > 0).sort((a, b) => a.mrr_cents - b.mrr_cents);
      const perProduct = catalog.map((p) => {
        const need = Math.ceil((target - s.mrr_cents) / p.mrr_cents);
        return {
          product: p.product, label: p.label, mrr_per_customer_cents: p.mrr_cents,
          customers_needed: Math.max(0, need),
          at_current_net_rate_months: s.net_new_30d > 0 ? Number((Math.max(0, need) / s.net_new_30d).toFixed(1)) : null,
        };
      });
      return send(res, 200, {
        current_mrr_cents: s.mrr_cents,
        target_mrr_cents: target,
        gap_cents: Math.max(0, target - s.mrr_cents),
        net_new_per_month: s.net_new_30d,
        months_at_current_rate: s.net_new_30d > 0 && s.arpu_cents > 0
          ? Math.ceil(Math.max(0, target - s.mrr_cents) / (s.net_new_30d * s.arpu_cents))
          : null,
        per_product: perProduct,
        note: 'Arithmetic on the events recorded here. A month of net-new adds is not a trend, and this is not a forecast of demand.',
      });
    }

    if (urlPath === '/api/premium/status') {
      const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ?').get('current');
      const active = Boolean(sub && new Date() < new Date(sub.expires_at));
      return send(res, 200, {
        premium: premium && active,
        tier: premium && active ? 'desk' : 'free',
        price_cents: DESK_PRICE_CENTS,
        payments: { provider: STRIPE_PUBLIC_KEY ? 'stripe' : 'payoneer', publishable_key: STRIPE_PUBLIC_KEY || null },
        features: premium && active ? ['targets', 'forecast', 'cohorts'] : [],
      });
    }

    if (urlPath === '/api/premium/subscribe' && req.method === 'POST') {
      if (!premium) return send(res, 402, { error: 'A desk token is required', hint: 'Authorization: Bearer <token>' });
      const expiresAt = new Date(Date.now() + 30 * 864e5).toISOString();
      db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)').run('current', 'desk', expiresAt);
      return send(res, 201, { success: true, tier: 'desk', expires_at: expiresAt, price_cents: DESK_PRICE_CENTS });
    }

    return serveStatic(res, urlPath);
  } catch (err) {
    return send(res, 500, { error: err.message || 'Request failed' });
  }
});

server.listen(PORT, () => {
  console.log(`revenue desk open on http://localhost:${PORT} — MRR ${summary().mrr_cents} cents from ${summary().active_subscriptions} recorded subscriptions`);
});
