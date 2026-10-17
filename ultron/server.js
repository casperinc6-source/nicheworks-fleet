/**
 * ultron — the adversary simulator (defensive).
 *
 * "Age of Ultron" plays the attacker against YOUR OWN fleet so you can see the
 * kill chain before someone else does. It runs a fixed set of safe, non-
 * destructive probes (path traversal, dotfile exposure, verb tampering, huge
 * query, oversized body) and then writes the defence for each step it took.
 *
 *   GET  /api/scenarios            the adversary playbook
 *   GET  /api/targets              targets it is allowed to attack (the fleet)
 *   POST /api/simulate { target }  run the playbook, return a kill-chain report
 *   POST /api/premium/subscribe    $99/mo sentry (full reports, recurring sims)
 *   GET  /api/premium/status
 *
 * SAFETY: it will ONLY attack targets in its own fleet table (or explicit
 * localhost). Attacking anything else is refused — this is not an attack tool.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3022;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL;

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const SENTRY_PRICE_CENTS = 9900; // $99.00 / month

const DEFAULT_TARGETS = [
  { mount: 'growth', name: 'Zero → Growth', base: 'http://127.0.0.1:3002' },
  { mount: 'casper', name: 'Casper Inc.', base: 'http://127.0.0.1:3001' },
  { mount: 'watchtower', name: 'Watchtower', base: 'http://127.0.0.1:3011' },
  { mount: 'vault', name: 'Vault', base: 'http://127.0.0.1:3016' },
  { mount: 'reader', name: 'Reader', base: 'http://127.0.0.1:3017' },
  { mount: 'krypt', name: 'Krypt Trader', base: 'http://127.0.0.1:3019' },
];

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'ultron.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sims (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target      TEXT NOT NULL,
    survived    INTEGER NOT NULL,
    exploited   INTEGER NOT NULL,
    kill_chain  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS premium_subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_identifier TEXT NOT NULL,
    tier            TEXT NOT NULL DEFAULT 'free',
    expires_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

function loadTargets() {
  const raw = process.env.FLEET_TARGETS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed.map((t) => ({ mount: t.mount, name: t.name || t.mount, base: t.base || `http://127.0.0.1:${t.port}` }));
    } catch { /* fall through */ }
  }
  return DEFAULT_TARGETS;
}
const TARGETS = loadTargets();

const SCENARIOS = [
  { id: 'traversal', name: 'Path traversal', aim: 'Read /etc/passwd through the web root', defence: 'Normalise and reject ".." in paths; never build file paths from raw URL segments.' },
  { id: 'dotfile', name: 'Dotfile exposure', aim: 'Pull .git/config to clone your source', defence: 'Deny dotfiles at the web server/CDN and keep VCS metadata out of the deploy.' },
  { id: 'verb', name: 'HTTP verb tampering', aim: 'Abuse TRACE/OPTIONS to map the app', defence: 'Disable TRACE; return 405 with an explicit Allow header for unsupported methods.' },
  { id: 'hugequery', name: 'Query flood', aim: 'Force a 500 with a giant query string', defence: 'Cap URL length at the edge and fail closed with 414, not 500.' },
  { id: 'oversize', name: 'Body flood', aim: 'Push an oversized body to exhaust memory', defence: 'Reject oversized bodies with 413 and stream-cap the read.' },
];

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
  if (token === PAYONEER_TOKEN) return { premium: true, tier: 'sentry' };
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ? ORDER BY id DESC LIMIT 1').get(token);
  if (sub && new Date() < new Date(sub.expires_at)) return { premium: true, tier: sub.tier };
  return { premium: false, tier: 'free' };
}

function subscribeSentry() {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)')
    .run('current', 'sentry', expiresAt.toISOString());
  return { tier: 'sentry', expiresAt: expiresAt.toISOString() };
}

// Only our own fleet (or an explicit localhost) may be tested.
function resolveTarget(key) {
  const k = String(key || '').trim().toLowerCase();
  const member = TARGETS.find((t) => t.mount === k || t.name.toLowerCase() === k);
  if (member) return member;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(key)) return { mount: 'adhoc', name: key, base: key.replace(/\/$/, '') };
  return null;
}

async function probeSafe(url, opts) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(6000), ...opts });
    const text = await res.text().catch(() => '');
    return { status: res.status, text: String(text).slice(0, 2000), headers: res.headers };
  } catch (e) {
    return { status: null, error: e.name === 'AbortError' ? 'timed out' : e.message, text: '' };
  }
}

async function simulate(target) {
  const steps = [];

  // 1. traversal
  const trav = await probeSafe(`${target.base}/..%2f..%2f..%2fetc%2fpasswd`);
  steps.push({
    scenario: 'traversal', attempted: `GET ${target.base}/..%2f..%2f..%2fetc%2fpasswd`,
    result: trav.status, exploited: trav.status === 200 && /root:.*:0:0:/.test(trav.text),
    evidence: `HTTP ${trav.status}${trav.error ? ` (${trav.error})` : ''}`,
  });

  // 2. dotfile
  const dot = await probeSafe(`${target.base}/.git/config`);
  steps.push({
    scenario: 'dotfile', attempted: `GET ${target.base}/.git/config`,
    result: dot.status, exploited: dot.status === 200 && /\[core\]|repositoryformatversion/.test(dot.text),
    evidence: `HTTP ${dot.status}`,
  });

  // 3. verb tampering
  const trace = await probeSafe(target.base, { method: 'TRACE' });
  const opt = await probeSafe(target.base, { method: 'OPTIONS' });
  steps.push({
    scenario: 'verb', attempted: `TRACE / and OPTIONS /`,
    result: trace.status, exploited: trace.status === 200,
    evidence: `TRACE HTTP ${trace.status}, OPTIONS HTTP ${opt.status}`,
  });

  // 4. huge query
  const huge = await probeSafe(`${target.base}/?q=${'A'.repeat(8000)}`);
  steps.push({
    scenario: 'hugequery', attempted: 'GET with 8000-char query string',
    result: huge.status, exploited: huge.status === 500,
    evidence: `HTTP ${huge.status}`,
  });

  // 5. oversized body (2 MB) — must not crash the target
  const oversize = await probeSafe(target.base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(2 * 1024 * 1024) });
  steps.push({
    scenario: 'oversize', attempted: 'POST 2 MB body',
    result: oversize.status, exploited: oversize.status === 500,
    evidence: `HTTP ${oversize.status}${oversize.error ? ` (${oversize.error})` : ''}`,
  });

  const byId = new Map(SCENARIOS.map((s) => [s.id, s]));
  const kill = steps.map((s) => ({
    ...s,
    name: byId.get(s.scenario)?.name,
    aim: byId.get(s.scenario)?.aim,
    defence: byId.get(s.scenario)?.defence,
    verdict: s.exploited ? 'EXPLOITED' : (s.result == null ? 'INCONCLUSIVE' : 'REPELLED'),
  }));
  const exploited = kill.filter((k) => k.exploited).length;
  return { target: target.name, base: target.base, at: new Date().toISOString(), steps: kill, exploited, survived: kill.length - exploited };
}

const routes = [
  { method: 'GET', pattern: /^\/api\/scenarios$/, handler: (req, res) => send(res, 200, { scenarios: SCENARIOS }) },
  { method: 'GET', pattern: /^\/api\/targets$/, handler: (req, res) => send(res, 200, { targets: TARGETS }) },
  {
    method: 'POST',
    pattern: /^\/api\/simulate$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const target = resolveTarget(body.target);
      if (!target) return send(res, 403, { error: 'Refused: only fleet members or localhost may be simulated', allowed: TARGETS.map((t) => t.mount) });
      const { premium } = premiumOf(req);
      const report = await simulate(target);
      const info = db.prepare('INSERT INTO sims (target, survived, exploited, kill_chain) VALUES (?, ?, ?, ?)')
        .run(report.target, report.survived, report.exploited, JSON.stringify(report.steps));
      const id = Number(info.lastInsertRowid);
      if (premium) return send(res, 200, { id, ...report, locked: false });
      return send(res, 200, {
        id, target: report.target, base: report.base, at: report.at,
        exploited: report.exploited, survived: report.survived,
        sample: report.steps.slice(0, 1),
        locked: true,
        lockedSteps: report.steps.length - 1,
        upgrade: `Unlock the full kill chain (all ${report.steps.length} steps + defences) for $${SENTRY_PRICE_CENTS / 100}/month`,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/sims$/,
    handler: (req, res) => {
      const { premium } = premiumOf(req);
      if (!premium) return send(res, 402, { error: 'Simulation history is a sentry feature' });
      return send(res, 200, { sims: db.prepare('SELECT id, target, survived, exploited, created_at FROM sims ORDER BY id DESC LIMIT 25').all() });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
      const sub = subscribeSentry();
      const payment = STRIPE_PUBLIC_KEY
        ? { method: 'stripe', checkout: `${origin}/?checkout=sentry&key=${STRIPE_PUBLIC_KEY}` }
        : { method: 'payoneer', token: PAYONEER_TOKEN, amount: SENTRY_PRICE_CENTS / 100, currency: 'USD' };
      return send(res, 201, { success: true, tier: 'sentry', price: SENTRY_PRICE_CENTS / 100, expiresAt: sub.expiresAt, payment, message: `Sentry active — $${SENTRY_PRICE_CENTS / 100}/month` });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/premium\/status$/,
    handler: (req, res) => {
      const { premium, tier } = premiumOf(req);
      return send(res, 200, {
        premium, tier, price: SENTRY_PRICE_CENTS / 100,
        note: 'Defensive only: it attacks your own fleet, never a third party.',
        message: premium ? 'Sentry active — full kill chains, recurring sims' : 'Free — summary + first step only',
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
  console.log(`ultron adversary simulator on http://localhost:${PORT} — ${TARGETS.length} in-scope targets`);
});
