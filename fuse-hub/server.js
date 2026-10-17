/**
 * fuse-hub — one command, every sibling app.
 *
 * Launches each app named in APPS below as a child process, then
 * reverse-proxies HTTP to them by path prefix. Zero dependencies.
 *
 *   http://localhost:4000/               → hub landing page (app index)
 *   http://localhost:4000/growth/        → zero-growth-app        :3002
 *   http://localhost:4000/casper/        → casperinc6-source      :3001
 *   http://localhost:4000/cobra/         → beige-cobras-scream    :3008
 *   http://localhost:4000/conway/        → automaton-conway       :3003
 *   http://localhost:4000/bots/          → conway-automoton-survivalbots :3004
 *   http://localhost:4000/clips/         → paperclip-maximizer    :3005
 *   http://localhost:4000/jarvis/        → jarvis-landing         :3006
 *   http://localhost:4000/claims/        → claim-finder           :3007
 *   http://localhost:4000/redteam/       → redteam                :3009
 *   http://localhost:4000/pup/           → pup                    :3010
 *   http://localhost:4000/watchtower/   → audit-funnel           :3011
 *   http://localhost:4000/loom/         → artcraft               :3012
 *   http://localhost:4000/keysmith/     → pqc-migration          :3013
 *   http://localhost:4000/agentzero/    → agent-zero             :3014
 *   http://localhost:4000/deception/    → deception              :3015
 *   http://localhost:4000/vault/        → vault                  :3016
 *   http://localhost:4000/reader/       → reader                 :3017
 *   http://localhost:4000/esim/         → esim-desk              :3018
 *   http://localhost:4000/krypt/        → krypt-trader           :3019
 *   http://localhost:4000/saluki/       → saluki-desk            :3020
 *   http://localhost:4000/poe/          → aggregator             :3021
 *   http://localhost:4000/ultron/       → ultron                 :3022
 *   http://localhost:4000/ruflow/       → ruflow                 :3023
 *   http://localhost:4000/exelo/        → exelo                  :3024
 *   http://localhost:4000/revenue/      → revenue                :3025
 *
 * Child ports are defaults: override any with PORT_<MOUNT> (e.g. PORT_CLIPS).
 */
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = process.env.PORT || 4000;
const ROOT = path.join(__dirname, '..');

const APPS = [
  { mount: 'growth', dir: 'zero-growth-app',                port: 3002, portEnv: 'PORT_GROWTH', name: 'Zero → Growth',      desc: 'money growth tracker from $0' },
  { mount: 'casper', dir: 'casperinc6-source',              port: 3001, portEnv: 'PORT_CASPER', name: 'Casper Inc.',        desc: 'travel booking + real Stripe checkout' },
  // 3008, not the app's own 3000: something else on the host may already hold
  // 3000, and a child that cannot bind would proxy to the wrong process.
  { mount: 'cobra',  dir: 'beige-cobras-scream',            port: 3008, portEnv: 'PORT_COBRA',  name: 'Beige Cobras Scream', desc: 'app scaffold / landing' },
  { mount: 'conway', dir: 'automaton-conway',               port: 3003, portEnv: 'PORT_CONWAY', name: 'Conway Life',        desc: "Conway's Game of Life" },
  { mount: 'bots',   dir: 'conway-automoton-survivalbots',  port: 3004, portEnv: 'PORT_BOTS',   name: 'Survival Bots',      desc: 'automaton predator-prey ecology' },
  { mount: 'clips',  dir: 'paperclip-maximizer',            port: 3005, portEnv: 'PORT_CLIPS',  name: 'Paperclip Maximizer', desc: 'the idle game about putting everything into clips' },
  { mount: 'jarvis', dir: 'jarvis-landing',                port: 3006, portEnv: 'PORT_JARVIS', name: 'JARVIS',             desc: 'landing page for the voice OS assistant' },
  { mount: 'claims', dir: 'claim-finder',                  port: 3007, portEnv: 'PORT_CLAIMS', name: 'ClaimFinder',        desc: 'official unclaimed money directory + auctions + claim tracker' },
  { mount: 'redteam', dir: 'redteam',                      port: 3009, portEnv: 'PORT_REDTEAM', name: 'AI Red Team',       desc: 'promptfoo probe scans of the fleet\u2019s own endpoints' },
  { mount: 'pup',     dir: 'pup',                          port: 3010, portEnv: 'PORT_PUP',     name: 'Pup',                desc: 'the little dog that reads the fleet and does what you say' },
  { mount: 'watchtower', dir: 'audit-funnel',              port: 3011, portEnv: 'PORT_WATCHTOWER', name: 'Watchtower',     desc: 'security audit: real scans, paid report + monitoring' },
  { mount: 'loom',    dir: 'artcraft',                     port: 3012, portEnv: 'PORT_LOOM',    name: 'Loom',               desc: 'generative SVG pattern studio' },
  { mount: 'keysmith', dir: 'pqc-migration',               port: 3013, portEnv: 'PORT_KEYSMITH', name: 'Keysmith',          desc: 'post-quantum readiness analyser' },
  { mount: 'deception', dir: 'deception',                  port: 3015, portEnv: 'PORT_DECEPTION', name: 'Deception Grid',   desc: 'decoy endpoints + canary tokens' },
  { mount: 'agentzero', dir: 'agent-zero',                 port: 3014, portEnv: 'PORT_AGENTZERO', name: 'Agent-Zero',       desc: 'fleet orchestrator \u2014 the king' },
  { mount: 'vault',   dir: 'vault',                         port: 3016, portEnv: 'PORT_VAULT',   name: 'Vault',              desc: 'offline file storage (content-addressed)' },
  { mount: 'reader',  dir: 'reader',                        port: 3017, portEnv: 'PORT_READER',  name: 'Reader',             desc: 'private script-free reader proxy' },
  { mount: 'esim',    dir: 'esim-desk',                     port: 3018, portEnv: 'PORT_ESIM',    name: 'eSIM Desk',          desc: 'travel data storefront (referral)' },
  { mount: 'krypt',   dir: 'krypt-trader',                  port: 3019, portEnv: 'PORT_KRYPT',   name: 'Krypt Trader',       desc: 'live crypto market + portfolio analyser' },
  { mount: 'saluki',  dir: 'saluki-desk',                   port: 3020, portEnv: 'PORT_SALUKI',  name: 'Saluki Desk',        desc: 'local agent model desk (Underdog Saluki 27B)' },
  { mount: 'poe',     dir: 'aggregator',                     port: 3021, portEnv: 'PORT_POE',     name: 'Aggregator',         desc: 'multi-model chat front door (Poe-style)' },
  { mount: 'ultron',  dir: 'ultron',                         port: 3022, portEnv: 'PORT_ULTRON',  name: 'Ultron',             desc: 'adversary simulator (defensive, fleet-scoped)' },
  { mount: 'ruflow',  dir: 'ruflow',                         port: 3023, portEnv: 'PORT_RUFLOW',  name: 'Ruflow',             desc: 'repo of runnable flows across the fleet' },
  { mount: 'exelo',   dir: 'exelo',                          port: 3024, portEnv: 'PORT_EXELO',   name: 'EXELO',              desc: 'AI employee desk — scans local businesses, prices the leak, builds the receptionist' },
  { mount: 'revenue', dir: 'revenue',                        port: 3025, portEnv: 'PORT_REVENUE', name: 'Revenue',            desc: 'the fleet\u2019s own books \u2014 MRR from recorded deals, catalog read from the apps' },
];

// Apps that need to know where their siblings live get this hub's own mount
// table, built below once the PORT_* overrides are applied.
const FLEET_AWARE = ['redteam', 'pup'];

// Each child port can be overridden, so a second copy of the fleet (or a test
// run) can live beside a running one: PORT_GROWTH=13002 npm start.
for (const app of APPS) {
  const raw = process.env[app.portEnv];
  if (raw === undefined || raw === '') continue;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${app.portEnv} must be a TCP port (1-65535), got ${JSON.stringify(raw)}`);
  }
  app.port = port;
}

// The red-team console scans its siblings and the dog reads them, so both need
// to know where they listen. Resolved after the PORT_* overrides above, so an
// overridden fleet is scanned and sniffed, not the default ports.
for (const app of APPS) {
  if (!FLEET_AWARE.includes(app.mount)) continue;
  app.extraEnv = {
    FLEET_TARGETS: JSON.stringify(APPS.filter((a) => a !== app).map((a) => ({
      mount: a.mount,
      name: a.name,
      base: `http://127.0.0.1:${a.port}`,
    }))),
  };
}

// Agent-Zero dispatches audits, so it must know where Watchtower actually
// listens (which a PORT_* override may have moved).
const watchtowerApp = APPS.find((a) => a.mount === 'watchtower');
const agentZeroApp = APPS.find((a) => a.mount === 'agentzero');
if (watchtowerApp && agentZeroApp) {
  agentZeroApp.extraEnv = {
    ...(agentZeroApp.extraEnv || {}),
    WATCHTOWER_URL: `http://127.0.0.1:${watchtowerApp.port}`,
  };
}

// Reader archives articles into the Vault, so it needs the vault's real port.
const vaultApp = APPS.find((a) => a.mount === 'vault');
const readerApp = APPS.find((a) => a.mount === 'reader');
if (vaultApp && readerApp) {
  readerApp.extraEnv = {
    ...(readerApp.extraEnv || {}),
    VAULT_URL: `http://127.0.0.1:${vaultApp.port}`,
  };
}

const children = new Map();
const state = new Map(); // mount -> 'starting' | 'up' | 'down'

function startApp(app) {
  const entry = path.join(ROOT, app.dir, 'server.js');
  if (!fs.existsSync(entry)) { state.set(app.mount, 'down'); return; }
  const child = spawn(process.execPath, [entry], {
    cwd: path.join(ROOT, app.dir),
    env: { ...process.env, PORT: String(app.port), ...(app.extraEnv || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${app.mount}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${app.mount}] ${d}`));
  child.on('exit', (code) => {
    state.set(app.mount, 'down');
    children.delete(app.mount);
    if (!shuttingDown) { log(`↻ ${app.mount} exited (${code}) — restarting in 2s`); setTimeout(() => startApp(app), 2000); }
  });
  children.set(app.mount, child);
  state.set(app.mount, 'starting');
}

let shuttingDown = false;
function log(msg) { console.log(`[hub] ${msg}`); }

async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch { return false; }
}

/** Proxy a request to an app, stripping the mount prefix and rewriting Location headers. */
function proxy(req, res, app) {
  const prefix = '/' + app.mount;
  const rest = req.url.startsWith(prefix) ? req.url.slice(prefix.length) || '/' : req.url;
  const opts = { hostname: '127.0.0.1', port: app.port, path: rest, method: req.method, headers: { ...req.headers, 'x-forwarded-prefix': prefix } };
  const upstream = http.request(opts, (ur) => {
    const headers = { ...ur.headers };
    if (headers.location && headers.location.startsWith('/')) headers.location = `/${app.mount}${headers.location}`;
    res.writeHead(ur.statusCode, headers);
    ur.pipe(res);
  });
  upstream.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1 style="font-family:system-ui">/${app.mount} is not responding — still starting? <a href="/">retry</a></h1>`);
  });
  req.pipe(upstream);
}

// Keep the lights honest: an app that starts late (or dies) must not stay
// yellow/red forever on the landing page.
async function refreshHealth() {
  await Promise.all(APPS.map(async (app) => {
    if (!children.has(app.mount)) return; // startApp owns the down→starting transition
    const up = await probe(app.port);
    state.set(app.mount, up ? 'up' : 'starting');
  }));
}
setInterval(refreshHealth, 5000).unref();

function landing(res) {
  const rows = APPS.map((a) => {
    const s = state.get(a.mount) || 'down';
    const badge = s === 'up' ? '🟢' : s === 'starting' ? '🟡' : '🔴';
    return `<tr><td>${badge}</td><td><a href="/${a.mount}/">${a.name}</a></td><td>${a.desc}</td><td><code>/${a.mount}/</code></td></tr>`;
  }).join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>fuse-hub</title>
<style>body{font-family:system-ui,sans-serif;background:#0e1116;color:#e8edf2;max-width:760px;margin:3rem auto;padding:0 1rem}
h1 b{color:#7ee787}table{width:100%;border-collapse:collapse;margin-top:1.2rem}
td,th{padding:.6rem .7rem;border-bottom:1px solid #26303a;text-align:left;font-size:.95rem}
a{color:#79c0ff}code{background:#1b2330;padding:.1rem .4rem;border-radius:4px}
p{color:#8b98a5;font-size:.9rem}</style></head><body>
<h1>fuse-<b>hub</b> — ${APPS.length} apps, one command</h1>
<p>All apps run as child processes with auto-restart. Refresh to update health.</p>
<table><tr><th></th><th>App</th><th>What</th><th>Mount</th></tr>${rows}</table>
<p style="margin-top:1.5rem">Health probes: 🟢 up · 🟡 starting · 🔴 down</p>
</body></html>`);
}

process.on('uncaughtException', (err) => log('uncaught: ' + err.message));

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = new URL(req.url, 'http://x').pathname; }
  catch { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<h1 style="font-family:system-ui">400 — bad request URL</h1>'); }
  const seg = urlPath.split('/')[1] || '';
  const app = APPS.find((a) => a.mount === seg);
  if (app) {
    if (urlPath === `/${app.mount}`) { res.writeHead(301, { Location: `/${app.mount}/` }); return res.end(); }
    return proxy(req, res, app);
  }
  if (urlPath === '/' || urlPath === '/index.html') return landing(res);
  if (urlPath === '/healthz') {
    // `apps` is how many are configured; `ready` is how many are actually
    // listening. They are not the same number for the first seconds after
    // boot (and not after a child fails), and this endpoint must not imply
    // otherwise — it is the deploy health check.
    const counts = { up: 0, starting: 0, down: 0 };
    for (const app of APPS) counts[state.get(app.mount) || 'down'] += 1;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true,
      uptime_s: Math.round(process.uptime()),
      apps: APPS.length,
      ready: counts.up,
      starting: counts.starting,
      down: counts.down,
    }));
  }
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h1 style="font-family:system-ui">404 — unknown mount</h1>');
});

for (const app of APPS) startApp(app);

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down all children…');
  for (const c of children.values()) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  log(`fuse-hub on http://localhost:${PORT}`);
  log(APPS.map((a) => `/${a.mount} → :${a.port}`).join('  '));
});
