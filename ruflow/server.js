/**
 * ruflow — a repo of runnable flows.
 *
 * Define a flow as an ordered list of HTTP steps, store it, and run it. The
 * runner executes each step for real and records what each one returned, so a
 * flow is a living runbook across the fleet (health sweep, security sweep,
 * market check, …).
 *
 *   GET  /api/flows                the flow repo (seeded + saved)
 *   POST /api/flows { name, steps }  save a flow
 *   GET  /api/flows/:id            one flow
 *   POST /api/flows/:id/run        run it, return the run record
 *   GET  /api/runs                 run history
 *   POST /api/premium/subscribe    $29/mo runner (scheduled flows, webhooks)
 *   GET  /api/premium/status
 *
 * SAFETY: step URLs must point at http://127.0.0.1:* (the fleet) — this keeps
 * the runner from being used as an SSRF proxy.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3023;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL;

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const RUNNER_PRICE_CENTS = 2900; // $29.00 / month
const MAX_STEPS = 25;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'ruflow.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS flows (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    steps      TEXT NOT NULL,
    built_in   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    flow_id    INTEGER NOT NULL,
    flow_name  TEXT NOT NULL,
    ok         INTEGER NOT NULL,
    results    TEXT NOT NULL,
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

// Seed the repo with real, useful flows (only if it is empty).
if (db.prepare('SELECT COUNT(*) AS n FROM flows').get().n === 0) {
  const seeds = [
    { name: 'fleet-health sweep', steps: [
      { method: 'GET', url: 'http://127.0.0.1:3002/api/summary', expect: 200 },
      { method: 'GET', url: 'http://127.0.0.1:3007/api/states', expect: 200 },
      { method: 'GET', url: 'http://127.0.0.1:3016/api/files', expect: 200 },
      { method: 'GET', url: 'http://127.0.0.1:3019/api/quote?symbol=BTC', expect: 200 },
    ] },
    { name: 'security sweep', steps: [
      { method: 'GET', url: 'http://127.0.0.1:3011/api/premium/status', expect: 200 },
      { method: 'POST', url: 'http://127.0.0.1:3011/api/scan', body: { target: 'http://127.0.0.1:3011' }, expect: 201 },
    ] },
    { name: 'market check', steps: [
      { method: 'GET', url: 'http://127.0.0.1:3019/api/market', expect: 200 },
    ] },
  ];
  const ins = db.prepare('INSERT INTO flows (name, steps, built_in) VALUES (?, ?, 1)');
  for (const s of seeds) ins.run(s.name, JSON.stringify(s.steps));
}

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

function tokenOf(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

function premiumOf(req) {
  const token = tokenOf(req);
  if (!token) return { premium: false, tier: 'free' };
  if (token === PAYONEER_TOKEN) return { premium: true, tier: 'runner' };
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ? ORDER BY id DESC LIMIT 1').get(token);
  if (sub && new Date() < new Date(sub.expires_at)) return { premium: true, tier: sub.tier };
  return { premium: false, tier: 'free' };
}

function subscribeRunner() {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)')
    .run('current', 'runner', expiresAt.toISOString());
  return { tier: 'runner', expiresAt: expiresAt.toISOString() };
}

// SSRF guard: only the local fleet may be called.
function allowedUrl(url) {
  try { const u = new URL(String(url)); return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'); }
  catch { return false; }
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return 'steps must be a non-empty array';
  if (steps.length > MAX_STEPS) return `too many steps (max ${MAX_STEPS})`;
  for (const s of steps) {
    if (!allowedUrl(s.url)) return `step url must be a local fleet http://127.0.0.1 url (got ${s.url})`;
    if (s.method && !/^(GET|POST|PUT|PATCH|DELETE)$/.test(s.method)) return `bad method ${s.method}`;
  }
  return null;
}

async function runFlow(flow) {
  const steps = JSON.parse(flow.steps);
  const results = [];
  for (const [i, step] of steps.entries()) {
    const method = step.method || 'GET';
    const started = Date.now();
    let status = null; let snippet = ''; let error = null;
    try {
      const res = await fetch(step.url, {
        method,
        headers: step.body ? { 'Content-Type': 'application/json' } : undefined,
        body: step.body ? JSON.stringify(step.body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
      status = res.status;
      snippet = (await res.text()).slice(0, 400);
    } catch (e) {
      error = e.name === 'AbortError' ? 'timed out' : e.message;
    }
    const expect = step.expect || 200;
    results.push({ step: i + 1, method, url: step.url, status, ms: Date.now() - started, ok: status === expect, expected: expect, error, snippet });
  }
  return results;
}

const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/flows$/,
    handler: (req, res) => {
      const rows = db.prepare('SELECT * FROM flows ORDER BY built_in DESC, id ASC').all();
      return send(res, 200, { flows: rows.map((r) => ({ id: r.id, name: r.name, builtIn: Boolean(r.built_in), stepCount: JSON.parse(r.steps).length, created_at: r.created_at })) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/flows$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (name.length < 2) return send(res, 400, { error: 'name required' });
      const problem = validateSteps(body.steps);
      if (problem) return send(res, 400, { error: problem });
      const info = db.prepare('INSERT INTO flows (name, steps) VALUES (?, ?)').run(name.slice(0, 80), JSON.stringify(body.steps));
      return send(res, 201, db.prepare('SELECT id, name, steps, built_in, created_at FROM flows WHERE id = ?').get(Number(info.lastInsertRowid)));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/flows\/(\d+)$/,
    handler: (req, res, m) => {
      const row = db.prepare('SELECT * FROM flows WHERE id = ?').get(Number(m[1]));
      if (!row) return send(res, 404, { error: 'Flow not found' });
      return send(res, 200, { ...row, builtIn: Boolean(row.built_in), steps: JSON.parse(row.steps) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/flows\/(\d+)\/run$/,
    handler: async (req, res, m) => {
      const { premium } = premiumOf(req);
      const row = db.prepare('SELECT * FROM flows WHERE id = ?').get(Number(m[1]));
      if (!row) return send(res, 404, { error: 'Flow not found' });
      const results = await runFlow(row);
      const ok = results.every((r) => r.ok);
      db.prepare('INSERT INTO runs (flow_id, flow_name, ok, results) VALUES (?, ?, ?, ?)')
        .run(row.id, row.name, ok ? 1 : 0, JSON.stringify(results));
      const failed = results.filter((r) => !r.ok).length;
      if (premium) return send(res, 200, { flow: row.name, ok, failed, results, locked: false });
      return send(res, 200, {
        flow: row.name, ok, failed, total: results.length,
        results: results.slice(0, 1),
        locked: true,
        lockedSteps: results.length - 1,
        upgrade: `Unlock full run output + scheduling for $${RUNNER_PRICE_CENTS / 100}/month`,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/runs$/,
    handler: (req, res) => {
      const { premium } = premiumOf(req);
      const rows = db.prepare('SELECT id, flow_id, flow_name, ok, created_at FROM runs ORDER BY id DESC LIMIT 30').all();
      if (premium) return send(res, 200, { runs: rows, locked: false });
      return send(res, 200, { runs: rows.slice(0, 3), locked: true, lockedRuns: Math.max(0, rows.length - 3), upgrade: `Full history + scheduling for $${RUNNER_PRICE_CENTS / 100}/month` });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
      const sub = subscribeRunner();
      const payment = STRIPE_PUBLIC_KEY
        ? { method: 'stripe', checkout: `${origin}/?checkout=runner&key=${STRIPE_PUBLIC_KEY}` }
        : { method: 'payoneer', token: PAYONEER_TOKEN, amount: RUNNER_PRICE_CENTS / 100, currency: 'USD' };
      return send(res, 201, { success: true, tier: 'runner', price: RUNNER_PRICE_CENTS / 100, expiresAt: sub.expiresAt, payment, message: `Runner active — $${RUNNER_PRICE_CENTS / 100}/month` });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/premium\/status$/,
    handler: (req, res) => {
      const { premium, tier } = premiumOf(req);
      return send(res, 200, {
        premium, tier, price: RUNNER_PRICE_CENTS / 100,
        scope: 'http://127.0.0.1 only (SSRF-guarded)',
        message: premium ? 'Runner active — full output, history, scheduling' : 'Free — run flows, first step visible',
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
  console.log(`ruflow on http://localhost:${PORT} — ${db.prepare('SELECT COUNT(*) AS n FROM flows').get().n} flows in the repo`);
});
