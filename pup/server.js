/**
 * pup — the little dog that lives on the hub and does what you say.
 *
 * A browser app with a server-side brain: it reads the sibling apps through the
 * hub (read-only, GET only), can hand a target to the red-team console for a
 * scan, and watches the fleet's health on its own, barking when something goes
 * down. No model, no API key — the command engine is rules in lib/brain.js, so
 * it works offline and its behaviour is testable.
 *
 *   GET  /                      the dog, its kennels and its command box
 *   GET  /api/state             dog state + fleet health + what it noticed
 *   GET  /api/fleet             fleet table with live health
 *   POST /api/command           { text } → what the dog says and does
 *   GET  /api/log               recent commands
 *   GET  /healthz               liveness
 *
 * Reads only: the proxy in /api/fleet/<mount>/<path> refuses anything but GET,
 * refuses paths that climb out of the app, and refuses unknown mounts, so the
 * dog cannot write to, or poke holes in, its siblings.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { think, HELP } = require('./lib/brain');

const PORT = Number(process.env.PORT || 3010);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'pup.json');
const REDTEAM_URL = process.env.REDTEAM_URL || null;
const TICK_MS = Number(process.env.PUP_TICK_MS || 15000);

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// The house: every sibling app, as handed over by fuse-hub.
// ---------------------------------------------------------------------------
const DEFAULT_TARGETS = [
  { mount: 'growth', name: 'Zero → Growth', base: 'http://127.0.0.1:3002' },
  { mount: 'casper', name: 'Casper Inc.', base: 'http://127.0.0.1:3001' },
  { mount: 'cobra', name: 'Beige Cobras Scream', base: 'http://127.0.0.1:3008' },
  { mount: 'conway', name: 'Conway Life', base: 'http://127.0.0.1:3003' },
  { mount: 'bots', name: 'Survival Bots', base: 'http://127.0.0.1:3004' },
  { mount: 'clips', name: 'Paperclip Maximizer', base: 'http://127.0.0.1:3005' },
  { mount: 'jarvis', name: 'JARVIS', base: 'http://127.0.0.1:3006' },
  { mount: 'claims', name: 'ClaimFinder', base: 'http://127.0.0.1:3007' },
  { mount: 'redteam', name: 'AI Red Team', base: 'http://127.0.0.1:3009' },
];

function loadTargets() {
  const raw = process.env.FLEET_TARGETS;
  if (!raw) return DEFAULT_TARGETS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('not a non-empty array');
    return parsed
      .filter((t) => t.mount !== 'pup')
      .map((t) => ({ mount: t.mount, name: t.name || t.mount, base: t.base || `http://127.0.0.1:${t.port}` }));
  } catch (error) {
    console.error(`[pup] FLEET_TARGETS is not usable (${error.message}); using defaults`);
    return DEFAULT_TARGETS;
  }
}

const FLEET = loadTargets();

// ---------------------------------------------------------------------------
// State: bones, mood, and what the dog noticed while you were away.
// ---------------------------------------------------------------------------
const DEFAULT_STATE = { name: 'Biscuit', bones: 0, mood: 'happy', noticed: [], log: [] };

function readState() {
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_STATE, noticed: [], log: [] };
  }
}

let state = readState();

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* state is a nice-to-have */ }
}

// ---------------------------------------------------------------------------
// Fleet access — reads only.
// ---------------------------------------------------------------------------
const health = new Map(); // mount -> { up, status, checkedAt }

async function probe(target) {
  const started = Date.now();
  try {
    const res = await fetch(`${target.base}/`, { signal: AbortSignal.timeout(1500) });
    return { up: res.status < 500, status: res.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { up: false, status: null, latencyMs: Date.now() - started, error: error.message };
  }
}

async function refreshHealth() {
  const results = await Promise.all(FLEET.map(async (t) => [t.mount, await probe(t)]));
  const now = Date.now();
  for (const [mount, result] of results) health.set(mount, { ...result, checkedAt: now });
  return fleetState();
}

function fleetState() {
  return FLEET.map((t) => ({ ...t, health: health.get(t.mount) || { up: false, status: null, checkedAt: null } }));
}

/** Read one path from one app. GET only, no climbing out of the app. */
async function get(mount, subPath) {
  const target = FLEET.find((t) => t.mount === mount);
  if (!target) return { ok: false, status: null, refused: true, error: `unknown app "${mount}"` };

  const cleaned = String(subPath || '').replace(/^\/+/, '');
  if (!cleaned) return { ok: false, status: null, error: 'no path given' };

  // Refuse traversal here rather than relaying it: a percent-encoded "%2e%2e%2f"
  // is harmless-looking in the raw path but resolves once the target decodes it.
  let decoded = cleaned;
  try { decoded = decodeURIComponent(cleaned); } catch {
    return { ok: false, status: null, refused: true, error: 'malformed escape in path' };
  }
  for (const candidate of [cleaned, decoded]) {
    if (candidate.includes('..') || candidate.includes('//') || candidate.includes('\\')) {
      return { ok: false, status: null, refused: true, error: 'refusing to leave the app' };
    }
  }

  try {
    const res = await fetch(`${target.base}/${cleaned}`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* html pages are fine too */ }
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: null, error: error.message };
  }
}

/** Hand a target to the red-team console. The scan itself is read-only. */
async function scan(mount) {
  const redteam = REDTEAM_URL
    || (FLEET.find((t) => t.mount === 'redteam') || {}).base;
  if (!redteam) return { ok: false, error: 'no red-team console in the house' };

  try {
    const res = await fetch(`${redteam}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: mount }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || `console answered ${res.status}` };
    return { ok: true, runId: body.run?.id, probes: body.run?.probes?.length ?? 0 };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** The context the brain's intents run against. */
function contextFor(req) {
  const behindHub = Boolean(req.headers['x-forwarded-prefix']);
  return {
    fleet: fleetState().map((t) => ({
      ...t,
      url: behindHub ? `/${t.mount}/` : `${t.base}/`,
    })),
    get,
    scan,
    state,
    behindHub,
  };
}

// ---------------------------------------------------------------------------
// Autonomous behaviour: the dog watches the house whether or not you're there.
// ---------------------------------------------------------------------------
let tickCount = 0;

function notice(entry) {
  state.noticed.unshift({ at: new Date().toISOString(), ...entry });
  state.noticed = state.noticed.slice(0, 20);
  saveState();
}

async function tick() {
  tickCount += 1;
  const before = new Map([...health].map(([mount, h]) => [mount, h.up]));
  await refreshHealth();

  for (const target of FLEET) {
    const was = before.get(target.mount);
    const now = Boolean(health.get(target.mount)?.up);
    if (was === undefined) continue;
    if (was && !now) {
      state.mood = 'alert';
      notice({ kind: 'down', mount: target.mount, say: `${target.name} stopped answering. I'm on it.` });
    } else if (!was && now) {
      state.mood = 'happy';
      notice({ kind: 'up', mount: target.mount, say: `${target.name} is back up. Tail going.` });
    }
  }
  saveState();
}

const ticker = setInterval(tick, TICK_MS);
ticker.unref?.();

// ---------------------------------------------------------------------------
// HTTP.
// ---------------------------------------------------------------------------
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
  res.writeHead(status, {
    'Content-Type': typeof data === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e5) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (error, data) => {
    if (error) return send(res, 404, '<h1>404 — no such page</h1>');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://pup.local'); }
  catch { return send(res, 400, { error: 'Bad request URL' }); }
  const urlPath = url.pathname;

  try {
    if (urlPath === '/' || urlPath === '/index.html') return serveStatic(res, '/');

    if (urlPath === '/healthz') {
      return send(res, 200, { ok: true, uptime_s: Math.round(process.uptime()), apps: FLEET.length, mood: state.mood });
    }

    if (urlPath === '/api/fleet') return send(res, 200, { fleet: await refreshHealth() });

    if (urlPath === '/api/state') {
      const fleet = fleetState();
      return send(res, 200, {
        name: state.name,
        mood: state.mood,
        bones: state.bones,
        noticed: state.noticed.slice(0, 8),
        help: HELP,
        fleet,
        up: fleet.filter((t) => t.health.up).length,
      });
    }

    if (urlPath === '/api/log') return send(res, 200, { log: state.log.slice(0, 25) });

    const proxy = urlPath.match(/^\/api\/fleet\/([\w-]+)\/(.+)$/);
    if (proxy) {
      if (req.method !== 'GET') return send(res, 405, { error: 'The dog only reads.' });
      const result = await get(proxy[1], proxy[2]);
      if (result.refused) {
        const status = /^unknown app/.test(result.error) ? 404 : 400;
        return send(res, status, { error: result.error });
      }
      return send(res, result.ok ? 200 : (result.status || 502), result.ok ? result.data : { error: result.error });
    }

    if (urlPath === '/api/command') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      const body = await readBody(req);
      const context = contextFor(req);
      const outcome = await think(body.text, context);

      if (outcome.action === 'bark') state.mood = 'alert';
      if (outcome.action === 'wag' || outcome.action === 'jump') state.mood = 'happy';
      if (outcome.action === 'sleep') state.mood = 'sleepy';
      if (outcome.data?.bones !== undefined) state.bones = outcome.data.bones;

      state.log.unshift({ at: new Date().toISOString(), said: String(body.text || '').slice(0, 200), intent: outcome.intent, reply: outcome.say });
      state.log = state.log.slice(0, 25);
      saveState();

      return send(res, 200, { ...outcome, mood: state.mood, bones: state.bones });
    }

    if (urlPath === '/api/notice') {
      if (req.method === 'DELETE') {
        state.noticed = [];
        saveState();
        return send(res, 200, { cleared: true });
      }
      return send(res, 200, { noticed: state.noticed });
    }

    if (urlPath.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
    return serveStatic(res, urlPath);
  } catch (error) {
    return send(res, error.statusCode || 500, { error: error.message });
  }
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, async () => {
  console.log(`pup is awake on http://localhost:${PORT} — watching ${FLEET.length} apps`);
  await tick(); // know the house before anyone asks
});
