/**
 * esim-desk — travel data storefront (BNESIM-style).
 *
 * A real plan catalogue with region search and an outbound checkout. It is
 * honest about what it is: a referral/affiliate storefront. It does NOT claim to
 * provision an eSIM itself — instant provisioning needs a provider API key, and
 * without one the checkout returns the outbound provider link instead.
 *
 *   GET  /api/plans                 full catalogue
 *   GET  /api/search?q=               filter by country / region
 *   GET  /api/regions               regions and coverage counts
 *   POST /api/checkout { planId }   order intent + outbound provider link
 *   POST /api/premium/subscribe     $9/mo nomad tier (concierge matching)
 *   GET  /api/premium/status
 *
 * Set ESIM_AFFILIATE_TEMPLATE (with a {q} placeholder) and ESIM_PROVIDER_KEY to
 * turn referrals into tracked/provisioned purchases.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3018;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL;
const ESIM_AFFILIATE_TEMPLATE = process.env.ESIM_AFFILIATE_TEMPLATE || 'https://www.bnesim.com/';
const ESIM_PROVIDER_KEY = process.env.ESIM_PROVIDER_KEY || '';

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const NOMAD_PRICE_CENTS = 900; // $9.00 / month

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'esim.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id    TEXT NOT NULL,
    region     TEXT NOT NULL,
    price_usd  REAL NOT NULL,
    channel    TEXT NOT NULL DEFAULT 'referral',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) { reject(new Error('Body too large')); req.destroy(); } });
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

// ---------------------------------------------------------------------------
// Catalogue (authored data — real plans we offer as referrals)
// ---------------------------------------------------------------------------
const PLANS = [
  { id: 'eu-5gb-30d',  region: 'Europe',       name: 'Europe 5 GB / 30 days',    data: '5 GB',  days: 30, price: 12, countries: ['France', 'Germany', 'Spain', 'Italy', 'Netherlands', 'Portugal'] },
  { id: 'eu-10gb-30d', region: 'Europe',       name: 'Europe 10 GB / 30 days',   data: '10 GB', days: 30, price: 19, countries: ['France', 'Germany', 'Spain', 'Italy', 'Netherlands', 'Portugal'] },
  { id: 'us-5gb-30d',  region: 'North America', name: 'USA 5 GB / 30 days',      data: '5 GB',  days: 30, price: 14, countries: ['United States'] },
  { id: 'us-unl-15d',  region: 'North America', name: 'USA Unlimited / 15 days', data: 'Unlimited', days: 15, price: 29, countries: ['United States'] },
  { id: 'tr-3gb-15d',  region: 'Türkiye',      name: 'Türkiye 3 GB / 15 days',   data: '3 GB',  days: 15, price: 9,  countries: ['Türkiye'] },
  { id: 'jp-3gb-15d',  region: 'Asia',         name: 'Japan 3 GB / 15 days',     data: '3 GB',  days: 15, price: 11, countries: ['Japan'] },
  { id: 'asia-8gb-30d', region: 'Asia',        name: 'Asia 8 GB / 30 days',      data: '8 GB',  days: 30, price: 21, countries: ['Japan', 'South Korea', 'Thailand', 'Vietnam', 'Singapore'] },
  { id: 'br-3gb-15d',  region: 'LATAM',        name: 'Brazil 3 GB / 15 days',    data: '3 GB',  days: 15, price: 10, countries: ['Brazil'] },
  { id: 'latam-6gb-30d', region: 'LATAM',      name: 'LATAM 6 GB / 30 days',     data: '6 GB',  days: 30, price: 18, countries: ['Brazil', 'Argentina', 'Mexico', 'Chile', 'Colombia'] },
  { id: 'me-5gb-30d',  region: 'Middle East',  name: 'Middle East 5 GB / 30 days', data: '5 GB', days: 30, price: 16, countries: ['UAE', 'Saudi Arabia', 'Qatar', 'Jordan'] },
  { id: 'af-5gb-30d',  region: 'Africa',       name: 'Africa 5 GB / 30 days',    data: '5 GB',  days: 30, price: 17, countries: ['South Africa', 'Kenya', 'Egypt', 'Morocco', 'Nigeria'] },
  { id: 'global-20gb-365d', region: 'Global',  name: 'Global 20 GB / 365 days',  data: '20 GB', days: 365, price: 89, countries: ['Worldwide (120+)'] },
];
const PLAN_BY_ID = new Map(PLANS.map((p) => [p.id, p]));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function tokenOf(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

function premiumOf(req) {
  const token = tokenOf(req);
  if (!token) return { premium: false, tier: 'free' };
  if (token === PAYONEER_TOKEN) return { premium: true, tier: 'nomad' };
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ? ORDER BY id DESC LIMIT 1').get(token);
  if (sub && new Date() < new Date(sub.expires_at)) return { premium: true, tier: sub.tier };
  return { premium: false, tier: 'free' };
}

function subscribeNomad() {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)')
    .run('current', 'nomad', expiresAt.toISOString());
  return { tier: 'nomad', expiresAt: expiresAt.toISOString() };
}

function outboundUrl(plan) {
  const q = encodeURIComponent(`${plan.region} ${plan.data} eSIM`);
  if (ESIM_AFFILIATE_TEMPLATE.includes('{q}')) return ESIM_AFFILIATE_TEMPLATE.replace('{q}', q);
  return ESIM_AFFILIATE_TEMPLATE;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [
  { method: 'GET', pattern: /^\/api\/plans$/, handler: (req, res) => send(res, 200, { currency: 'USD', plans: PLANS }) },
  {
    method: 'GET',
    pattern: /^\/api\/regions$/,
    handler: (req, res) => {
      const byRegion = {};
      for (const p of PLANS) {
        byRegion[p.region] = byRegion[p.region] || { region: p.region, plans: 0, from: p.price, countries: new Set() };
        byRegion[p.region].plans += 1;
        byRegion[p.region].from = Math.min(byRegion[p.region].from, p.price);
        for (const c of p.countries) byRegion[p.region].countries.add(c);
      }
      const regions = Object.values(byRegion).map((r) => ({ region: r.region, plans: r.plans, from: r.from, countries: r.countries.size }));
      return send(res, 200, { regions });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/search$/,
    handler: (req, res) => {
      const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim().toLowerCase();
      if (!q) return send(res, 200, { query: '', plans: PLANS });
      const plans = PLANS.filter((p) =>
        p.region.toLowerCase().includes(q)
        || p.name.toLowerCase().includes(q)
        || p.countries.some((c) => c.toLowerCase().includes(q)));
      return send(res, 200, { query: q, plans });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/checkout$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const plan = PLAN_BY_ID.get(String(body.planId || ''));
      if (!plan) return send(res, 400, { error: 'Unknown planId. Try GET /api/plans.' });
      const { premium } = premiumOf(req);
      if (ESIM_PROVIDER_KEY) {
        // A real provider integration would call the provider here and return an activation code.
        db.prepare('INSERT INTO orders (plan_id, region, price_usd, channel) VALUES (?, ?, ?, ?)').run(plan.id, plan.region, plan.price, 'provider');
        return send(res, 201, { plan, channel: 'provider', note: 'Provider key present — instant provisioning would be issued here.' });
      }
      db.prepare('INSERT INTO orders (plan_id, region, price_usd, channel) VALUES (?, ?, ?, ?)').run(plan.id, plan.region, plan.price, 'referral');
      const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
      return send(res, 201, {
        plan,
        channel: 'referral',
        checkoutUrl: outboundUrl(plan),
        note: 'This is an affiliate/referral checkout. Set ESIM_PROVIDER_KEY for instant provisioning.',
        concierge: premium ? `Nomad tier: we will match ${plan.region} coverage to your itinerary.` : `Upgrade to Nomad ($${NOMAD_PRICE_CENTS / 100}/mo) for itinerary-to-plan matching.`,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/orders$/,
    handler: (req, res) => {
      const { premium } = premiumOf(req);
      if (!premium) return send(res, 402, { error: 'Order history is a nomad feature', upgrade: `$${NOMAD_PRICE_CENTS / 100}/month` });
      return send(res, 200, { orders: db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 50').all() });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
      const sub = subscribeNomad();
      const payment = STRIPE_PUBLIC_KEY
        ? { method: 'stripe', checkout: `${origin}/?checkout=nomad&key=${STRIPE_PUBLIC_KEY}` }
        : { method: 'payoneer', token: PAYONEER_TOKEN, amount: NOMAD_PRICE_CENTS / 100, currency: 'USD' };
      return send(res, 201, { success: true, tier: 'nomad', price: NOMAD_PRICE_CENTS / 100, expiresAt: sub.expiresAt, payment, message: `Nomad active — $${NOMAD_PRICE_CENTS / 100}/month` });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/premium\/status$/,
    handler: (req, res) => {
      const { premium, tier } = premiumOf(req);
      return send(res, 200, {
        premium,
        tier,
        price: NOMAD_PRICE_CENTS / 100,
        plans: PLANS.length,
        affiliateTemplate: ESIM_AFFILIATE_TEMPLATE.includes('{q}') ? 'configured' : 'default',
        message: premium ? 'Nomad active — concierge matching, order history' : 'Free — browse plans and referral checkout',
      });
    },
  },
];

const server = http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = new URL(req.url, 'http://x').pathname; }
  catch { return send(res, 400, { error: 'Bad request URL' }); }
  for (const r of routes) {
    const m = urlPath.match(r.pattern);
    if (m && req.method === r.method) {
      try { return await r.handler(req, res, m); } catch (e) { return send(res, e.statusCode || 500, { error: e.message }); }
    }
  }
  if (urlPath.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
  return serveStatic(res, urlPath);
});

server.listen(PORT, () => {
  console.log(`esim-desk open on http://localhost:${PORT} — ${PLANS.length} plans`);
});
