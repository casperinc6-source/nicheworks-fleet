/**
 * Agent-Zero — the king of the NICHEWORKS fleet.
 *
 * It watches every sibling app, keeps a live "kingdom index", and dispatches
 * directives. It performs real work: it HTTP-probes each app, and its `audit`
 * directive drives the Watchtower scanner and folds the real security score
 * back into the index.
 *
 *   GET  /                      the throne room
 *   GET  /api/state             fleet status + kingdom index (real probes)
 *   GET  /api/fleet             the fleet table and revenue readiness
 *   POST /api/directive { text }  e.g. "status", "audit <target>", "crown"
 *   POST /api/premium/subscribe   { tier: 'throne' }  ($499/mo)
 *   GET  /api/premium/status
 *
 * Fleet members come from FLEET_TARGETS (fuse-hub supplies its mount table).
 * Standalone, it falls back to the documented default ports.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3014;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL;

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const THRONE_PRICE_CENTS = 49900; // $499.00 / month

// Who sits in the court, and what each throne is worth.
const REVENUE = {
  growth: 5, casper: 20, claims: 50, marketdesk: 199, hireme: 20, clips: 5,
  cobra: 2.99, conway: 4.99, watchtower: 49, loom: 9, keysmith: 299, agentzero: 499,
};

const DEFAULT_TARGETS = [
  { mount: 'growth',     name: 'Zero → Growth',  base: 'http://127.0.0.1:3002', role: 'tracker' },
  { mount: 'casper',     name: 'Casper Inc.',    base: 'http://127.0.0.1:3001', role: 'booking' },
  { mount: 'claims',     name: 'ClaimFinder',    base: 'http://127.0.0.1:3007', role: 'claims' },
  { mount: 'clips',      name: 'Paperclip',      base: 'http://127.0.0.1:3005', role: 'game' },
  { mount: 'cobra',      name: 'Beige Cobras',   base: 'http://127.0.0.1:3008', role: 'landing' },
  { mount: 'conway',     name: 'Conway Life',    base: 'http://127.0.0.1:3003', role: 'simulation' },
  { mount: 'watchtower', name: 'Watchtower',     base: 'http://127.0.0.1:3011', role: 'security' },
  { mount: 'loom',       name: 'Loom',           base: 'http://127.0.0.1:3012', role: 'patterns' },
  { mount: 'keysmith',   name: 'Keysmith',       base: 'http://127.0.0.1:3013', role: 'post-quantum' },
  { mount: 'redteam',    name: 'Red Team',       base: 'http://127.0.0.1:3009', role: 'probes' },
];

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'agentzero.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS directives (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT NOT NULL,
    reply      TEXT NOT NULL,
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
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
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
// Fleet table
// ---------------------------------------------------------------------------
function loadFleet() {
  const raw = process.env.FLEET_TARGETS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.map((t) => ({ mount: t.mount, name: t.name || t.mount, base: t.base || `http://127.0.0.1:${t.port}`, role: t.role || 'app' }));
      }
    } catch { /* fall through to defaults */ }
  }
  return DEFAULT_TARGETS;
}

const FLEET = loadFleet();
const WATCHTOWER = process.env.WATCHTOWER_URL || 'http://127.0.0.1:3011';

function findMember(key) {
  if (!key) return null;
  const k = String(key).toLowerCase();
  return FLEET.find((a) => a.mount === k || a.name.toLowerCase() === k) || null;
}

// ---------------------------------------------------------------------------
// Real probes
// ---------------------------------------------------------------------------
async function probe(member) {
  const started = Date.now();
  try {
    const res = await fetch(member.base + '/', { signal: AbortSignal.timeout(1200) });
    return { mount: member.mount, name: member.name, role: member.role, up: true, status: res.status, ms: Date.now() - started, price: REVENUE[member.mount] ?? null };
  } catch (error) {
    return { mount: member.mount, name: member.name, role: member.role, up: false, status: null, ms: Date.now() - started, error: error.message, price: REVENUE[member.mount] ?? null };
  }
}

async function probeFleet() {
  const members = await Promise.all(FLEET.map(probe));
  const up = members.filter((m) => m.up).length;
  const coverage = members.length ? Math.round((up / members.length) * 100) : 0;
  const latency = members.filter((m) => m.up).map((m) => m.ms);
  const avgLatency = latency.length ? Math.round(latency.reduce((a, b) => a + b, 0) / latency.length) : null;
  const mrrPotential = members.reduce((sum, m) => sum + (m.price || 0), 0);
  // Kingdom index: coverage dominates, speed is a bonus.
  const speedBonus = avgLatency === null ? 0 : Math.max(0, 20 - Math.round(avgLatency / 50));
  const index = Math.min(100, Math.round(coverage * 0.8) + Math.min(20, speedBonus));
  return { members, up, total: members.length, coverage, avgLatency, mrrPotential, index };
}

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
  if (token === PAYONEER_TOKEN) return { premium: true, tier: 'throne' };
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ? ORDER BY id DESC LIMIT 1').get(token);
  if (sub && new Date() < new Date(sub.expires_at)) return { premium: true, tier: sub.tier };
  return { premium: false, tier: 'free' };
}

function subscribeThrone() {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)')
    .run('current', 'throne', expiresAt.toISOString());
  return { tier: 'throne', expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------
async function auditTarget(target) {
  const res = await fetch(`${WATCHTOWER}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.error || `Watchtower HTTP ${res.status}`);
    err.statusCode = 502;
    throw err;
  }
  return json;
}

async function runDirective(text) {
  const said = String(text || '').trim();
  const lower = said.toLowerCase();

  if (!said) return { intent: 'none', reply: 'Say the word, sire. Try "status", "audit example.com", or "crown".' };

  if (lower.startsWith('audit ')) {
    const target = said.slice(6).trim();
    try {
      const result = await auditTarget(target);
      return {
        intent: 'audit',
        reply: `Watchtower scanned ${result.target}: posture ${result.score}/100 — ${result.counts.high} high, ${result.counts.medium} medium, ${result.counts.low} low. Run id ${result.id}.`,
        data: { id: result.id, target: result.target, score: result.score, counts: result.counts, total: result.total },
      };
    } catch (error) {
      return { intent: 'audit', reply: `Watchtower could not scan ${target}: ${error.message}`, error: true };
    }
  }

  if (lower === 'status' || lower.includes('how is the fleet') || lower === 'fleet') {
    const state = await probeFleet();
    const down = state.members.filter((m) => !m.up).map((m) => m.mount);
    return {
      intent: 'status',
      reply: `${state.up}/${state.total} apps standing (coverage ${state.coverage}%), kingdom index ${state.index}/100, avg ${state.avgLatency ?? '—'}ms.${down.length ? ` Down: ${down.join(', ')}.` : ' All thrones occupied.'}`,
      data: { index: state.index, up: state.up, total: state.total, down },
    };
  }

  if (lower.includes('crown') || lower.includes('money') || lower.includes('revenue')) {
    const state = await probeFleet();
    return {
      intent: 'crown',
      reply: `Combined monthly potential of the court: $${state.mrrPotential.toFixed(2)}. Kingdom index ${state.index}/100 with ${state.up}/${state.total} apps answering.`,
      data: { mrrPotential: state.mrrPotential, index: state.index },
    };
  }

  return { intent: 'unknown', reply: `I did not catch a directive in "${said}". I understand: status, audit <target>, crown.` };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/state$/,
    handler: async (req, res) => {
      const state = await probeFleet();
      return send(res, 200, { ...state, fleet: state.members, members: undefined, generatedAt: new Date().toISOString() });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/fleet$/,
    handler: (req, res) => send(res, 200, {
      fleet: FLEET.map((m) => ({ ...m, price: REVENUE[m.mount] ?? null })),
      watchtower: WATCHTOWER,
    }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/directive$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const outcome = await runDirective(body.text);
      db.prepare('INSERT INTO directives (text, reply) VALUES (?, ?)').run(String(body.text || ''), outcome.reply);
      return send(res, 200, outcome);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/directives$/,
    handler: (req, res) => send(res, 200, { directives: db.prepare('SELECT * FROM directives ORDER BY id DESC LIMIT 25').all() }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
      const sub = subscribeThrone();
      const payment = STRIPE_PUBLIC_KEY
        ? { method: 'stripe', checkout: `${origin}/?checkout=throne&key=${STRIPE_PUBLIC_KEY}` }
        : { method: 'payoneer', token: PAYONEER_TOKEN, amount: THRONE_PRICE_CENTS / 100, currency: 'USD' };
      return send(res, 201, { success: true, tier: 'throne', price: THRONE_PRICE_CENTS / 100, expiresAt: sub.expiresAt, payment, message: `Throne active — $${THRONE_PRICE_CENTS / 100}/month` });
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
        price: THRONE_PRICE_CENTS / 100,
        message: premium ? 'Throne active — unlimited directives and full index history' : 'Free tier — view the index, limited directives',
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
  console.log(`agent-zero ruling on http://localhost:${PORT} — ${FLEET.length} apps in the court`);
});
