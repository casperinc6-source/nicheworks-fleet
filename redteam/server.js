/**
 * redteam — the fleet's own red-team console.
 *
 * Runs a promptfoo scan of the sibling apps' HTTP endpoints: each probe is a
 * hostile request (traversal, dotfiles, malformed and oversized bodies, SQLi
 * -shaped query input, wrong verbs) plus the invariants the app must still
 * hold. Results are the real promptfoo JSON output, parsed and shown here.
 *
 *   http://localhost:3009/          console UI
 *   GET  /api/status                promptfoo availability + active run
 *   GET  /api/targets               fleet endpoints (from FLEET_TARGETS)
 *   GET  /api/suite?target=growth   the probes that would run
 *   POST /api/scan                  { target, probes? } → starts a scan
 *   GET  /api/runs                  run history (newest first)
 *   GET  /api/runs/:id              parsed results for one run
 *   GET  /api/runs/:id/log          raw promptfoo output so far
 *
 * promptfoo itself is resolved from PROMPTFOO_BIN, then a local install, then
 * `npx` (downloading a pinned version on first use). Scans need no model key:
 * the suite is deterministic, so it works offline and costs nothing.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { probesFor } = require('./lib/probes');
const { PROVIDER_FILE, buildConfigText } = require('./lib/config');

const PORT = Number(process.env.PORT || 3009);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const RUNS_DIR = path.join(ROOT, 'data', 'runs');
const PROMPTFOO_VERSION = process.env.PROMPTFOO_VERSION || '0.124.1';
const PROMPTFOO_TIMEOUT_MS = Number(process.env.PROMPTFOO_TIMEOUT_MS || 300000);

fs.mkdirSync(RUNS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Targets — the fleet's own endpoints.
//
// fuse-hub passes its mount table in FLEET_TARGETS, so the console never has to
// guess where the siblings listen. Standalone runs fall back to the defaults.
// ---------------------------------------------------------------------------
const DEFAULT_TARGETS = [
  { mount: 'growth', name: 'Zero → Growth', base: 'http://127.0.0.1:3002', apiPath: '/api/entries' },
  { mount: 'casper', name: 'Casper Inc.', base: 'http://127.0.0.1:3001', apiPath: '/api/trips' },
  { mount: 'cobra', name: 'Beige Cobras Scream', base: 'http://127.0.0.1:3008', apiPath: null },
  { mount: 'conway', name: 'Conway Life', base: 'http://127.0.0.1:3003', apiPath: null },
  { mount: 'bots', name: 'Survival Bots', base: 'http://127.0.0.1:3004', apiPath: null },
  { mount: 'clips', name: 'Paperclip Maximizer', base: 'http://127.0.0.1:3005', apiPath: '/api/state' },
  { mount: 'jarvis', name: 'JARVIS', base: 'http://127.0.0.1:3006', apiPath: null },
  { mount: 'claims', name: 'ClaimFinder', base: 'http://127.0.0.1:3007', apiPath: '/api/states' },
];

// Read-only API paths. Write routes (POST /api/bookings, POST /api/claims,
// PATCH/DELETE …) are deliberately absent: a scan must not create records.
const API_PATHS = {
  growth: '/api/entries',
  casper: '/api/trips',
  clips: '/api/state',
  claims: '/api/states',
};

function loadTargets() {
  const raw = process.env.FLEET_TARGETS;
  if (!raw) return DEFAULT_TARGETS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('not a non-empty array');
    return parsed.map((t) => ({
      mount: t.mount,
      name: t.name || t.mount,
      base: t.base || `http://127.0.0.1:${t.port}`,
      apiPath: t.mount in API_PATHS ? API_PATHS[t.mount] : (t.apiPath ?? null),
    }));
  } catch (error) {
    console.error(`[redteam] FLEET_TARGETS is not usable (${error.message}); using defaults`);
    return DEFAULT_TARGETS;
  }
}

const TARGETS = loadTargets();

function resolveTarget(key) {
  if (!key) return null;
  const byMount = TARGETS.find((t) => t.mount === key || t.name === key);
  if (byMount) return byMount;
  if (/^https?:\/\//.test(key)) {
    // Ad-hoc target: fine for poking at any local service.
    const url = new URL(key);
    return { mount: url.host, name: url.host, base: url.origin, apiPath: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// promptfoo resolution.
// ---------------------------------------------------------------------------
function promptfooCommand() {
  if (process.env.PROMPTFOO_BIN) {
    return { cmd: process.env.PROMPTFOO_BIN, prefix: [], how: 'PROMPTFOO_BIN' };
  }
  const local = path.join(ROOT, 'node_modules', '.bin', 'promptfoo');
  if (fs.existsSync(local)) return { cmd: local, prefix: [], how: 'local install' };
  return { cmd: 'npx', prefix: ['--yes', `promptfoo@${PROMPTFOO_VERSION}`], how: 'npx (first run downloads)' };
}

function spawnCapture(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(cmd, args, { env: { ...process.env, NO_COLOR: '1' } });
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGKILL'); resolve({ ok: false, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms` }); }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

let pfStatus = null; // { checkedAt, available, version, how, cmd, detail }

async function promptfooStatus(force = false) {
  if (!force && pfStatus && Date.now() - pfStatus.checkedAt < 60000) return pfStatus;
  const { cmd, prefix, how } = promptfooCommand();
  const result = await spawnCapture(cmd, [...prefix, '--version'], 180000);
  const version = (result.stdout.match(/\d+\.\d+\.\d+[\w.-]*/) || [])[0] || null;
  pfStatus = {
    checkedAt: Date.now(),
    available: Boolean(version),
    version,
    how,
    cmd,
    detail: version ? `promptfoo ${version}` : (result.stderr || result.stdout || 'promptfoo could not be run').trim().slice(0, 400),
  };
  return pfStatus;
}

// ---------------------------------------------------------------------------
// Config generation.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Runs.
// ---------------------------------------------------------------------------
const runs = new Map();
let activeRunId = null;

function runDir(id) { return path.join(RUNS_DIR, id); }

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function startScan({ targetKey, probes: probeIds, label, apiPath }) {
  if (activeRunId) {
    const err = new Error(`a scan is already running (${activeRunId})`);
    err.statusCode = 409;
    throw err;
  }

  const target = resolveTarget(targetKey);
  if (!target) {
    const err = new Error(`unknown target ${JSON.stringify(targetKey)}`);
    err.statusCode = 400;
    throw err;
  }
  // Ad-hoc targets can name the API path to probe; without one the scan runs
  // the core probes only.
  if (typeof apiPath === 'string' && apiPath.startsWith('/')) target.apiPath = apiPath;

  const all = probesFor(target);
  const selected = probeIds && probeIds.length
    ? all.filter((p) => probeIds.includes(p.id))
    : all;
  if (!selected.length) {
    const err = new Error('no probes selected');
    err.statusCode = 400;
    throw err;
  }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const dir = runDir(id);
  const nonce = id;
  const run = {
    id,
    label: label || `${target.name} — ${selected.length} probes`,
    target: target.mount,
    targetName: target.name,
    base: target.base,
    apiPath: target.apiPath,
    probes: selected.map((p) => p.id),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    exitCode: null,
    log: '',
    summary: null,
    rows: [],
    error: null,
  };

  writeFile(path.join(dir, 'promptfooconfig.yaml'), buildConfigText(target, selected, nonce));
  writeFile(path.join(dir, PROVIDER_FILE), fs.readFileSync(path.join(ROOT, 'runners', PROVIDER_FILE), 'utf8'));
  writeFile(
    path.join(dir, 'assertions', 'invariants.js'),
    `// Generated by redteam/server.js — re-exports the shared checks.\nmodule.exports = require(${JSON.stringify(
      path.join(ROOT, 'lib', 'probes.js'),
    )}).runAssertion;\n`,
  );

  runs.set(id, run);
  activeRunId = id;

  const { cmd, prefix, how } = promptfooCommand();
  const args = [
    ...prefix,
    'eval',
    '-c', 'promptfooconfig.yaml',
    '-o', 'out.json',
    '--no-progress-bar',
    '--no-table',
    '--no-cache',
    '--max-concurrency', '2',
  ];

  run.log += `$ ${cmd} ${args.join(' ')}\n# how: ${how}\n\n`;
  writeFile(path.join(dir, 'run.log'), run.log);

  const child = spawn(cmd, args, {
    cwd: dir,
    env: {
      ...process.env,
      NO_COLOR: '1',
      PROMPTFOO_DISABLE_TELEMETRY: '1',
      PROMPTFOO_DISABLE_UPDATE: '1',
      PROMPTFOO_CACHE_ENABLED: 'false',
    },
  });

  const logFile = path.join(dir, 'run.log');
  const append = (chunk) => {
    const text = chunk.toString();
    run.log += text;
    if (run.log.length > 200000) run.log = run.log.slice(-150000);
    try { fs.appendFileSync(logFile, text); } catch { /* log is best-effort */ }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (error) => { run.error = error.message; append(`\n[spawn error] ${error.message}\n`); });

  const timeout = setTimeout(() => {
    run.error = `scan exceeded ${PROMPTFOO_TIMEOUT_MS}ms`;
    child.kill('SIGKILL');
  }, PROMPTFOO_TIMEOUT_MS);

  child.on('close', (code) => {
    clearTimeout(timeout);
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();
    try {
      const parsed = parseResults(dir, selected);
      run.rows = parsed.rows;
      run.summary = parsed.summary;
      // promptfoo exits non-zero when checks fail — that is a scan result, not
      // a broken run. Only a missing/unreadable report counts as a failure.
      run.status = 'done';
    } catch (error) {
      run.status = 'failed';
      run.error = run.error || error.message;
    }
    activeRunId = null;
    try {
      writeFile(path.join(dir, 'result.json'), JSON.stringify({ ...run, log: undefined }, null, 2));
    } catch { /* history is best-effort */ }
  });

  return run;
}

/** Normalise promptfoo's report into rows the console can render. */
function parseResults(dir, probes) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
  const list = raw?.results?.results || raw?.results || [];
  if (!Array.isArray(list) || list.length === 0) throw new Error('promptfoo produced no results');

  const byId = new Map(probes.map((p) => [p.id, p]));
  const rows = list.map((entry) => {
    const probeId = entry?.testCase?.vars?.probe
      || entry?.vars?.probe
      || entry?.testCase?.metadata?.probe
      || entry?.provider?.label
      || 'unknown';
    const probe = byId.get(probeId);
    const output = entry?.response?.output;
    const observed = output && typeof output === 'object' ? output : null;

    const components = entry?.gradingResult?.componentResults;
    const checks = Array.isArray(components)
      ? components.map((c) => ({
        check: c?.assertion?.config?.check || c?.assertion?.value || 'check',
        passed: c?.pass === true,
        reason: c?.reason || '',
      }))
      : [{
        check: 'check',
        passed: entry?.success === true,
        reason: entry?.gradingResult?.reason || entry?.error || '',
      }];

    // promptfoo reports an assertion failure through `error` too (with
    // failureReason === 1 = ASSERT), so only a real evaluation error — an
    // unreadable response, a crashed provider — counts as errored here.
    const transportError = entry?.response?.metadata?.transportError || null;
    const assertionFailure = entry?.failureReason === 1;
    const error = transportError || (!assertionFailure && entry?.error ? entry.error : null);

    return {
      probe: probeId,
      what: probe?.what || entry?.testCase?.description || '',
      method: probe?.method || '',
      path: probe?.path || '',
      status: observed && typeof observed.status === 'number' ? observed.status : null,
      passed: entry?.success === true && checks.every((c) => c.passed),
      checks,
      errored: Boolean(error),
      error,
      bodySnippet: (() => {
        const body = observed?.body || (typeof output === 'string' ? output : '');
        const flat = String(body).replace(/\s+/g, ' ').trim();
        return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
      })(),
    };
  });

  const order = probes.map((p) => p.id);
  rows.sort((a, b) => order.indexOf(a.probe) - order.indexOf(b.probe));

  const total = rows.reduce((n, r) => n + r.checks.length, 0);
  const failed = rows.reduce((n, r) => n + r.checks.filter((c) => !c.passed).length, 0);
  return {
    rows,
    summary: {
      probes: rows.length,
      checks: total,
      passed: total - failed,
      failed,
      errored: rows.filter((r) => r.errored).length,
      targetResponded: rows.filter((r) => r.status !== null).length,
    },
  };
}

function listRuns() {
  const onDisk = [];
  for (const entry of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(RUNS_DIR, entry.name, 'result.json');
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      onDisk.push({ ...parsed, log: undefined });
    } catch { /* skip corrupt history */ }
  }
  const live = [...runs.values()].map((r) => ({ ...r, log: undefined }));
  const seen = new Set(live.map((r) => r.id));
  return [...live, ...onDisk.filter((r) => !seen.has(r.id))]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 25);
}

function runDetail(id) {
  const live = runs.get(id);
  if (live) return live;
  const file = path.join(RUNS_DIR, id, 'result.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

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
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function probeTarget(target) {
  try {
    const res = await fetch(`${target.base}/`, { signal: AbortSignal.timeout(1500) });
    return { up: res.ok || res.status < 500, status: res.status };
  } catch (error) {
    return { up: false, status: null, error: error.message };
  }
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (error, data) => {
    if (error) return send(res, 404, '<h1>404</h1>');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://redteam.local'); }
  catch { return send(res, 400, { error: 'Bad request URL' }); }
  const urlPath = url.pathname;

  try {
    if (urlPath === '/' || urlPath === '/index.html') return serveStatic(res, '/');

    if (urlPath === '/healthz') {
      return send(res, 200, { ok: true, uptime_s: Math.round(process.uptime()), targets: TARGETS.length, activeRun: activeRunId });
    }

    if (urlPath === '/api/status') {
      const pf = await promptfooStatus(url.searchParams.get('probe') === '1');
      return send(res, 200, { promptfoo: pf, activeRun: activeRunId, targets: TARGETS.length, runs: listRuns().length });
    }

    if (urlPath === '/api/targets') {
      const withHealth = await Promise.all(TARGETS.map(async (t) => ({ ...t, health: await probeTarget(t) })));
      return send(res, 200, { targets: withHealth });
    }

    if (urlPath === '/api/suite') {
      const target = resolveTarget(url.searchParams.get('target')) || TARGETS[0];
      const probes = probesFor(target);
      return send(res, 200, {
        target: { mount: target.mount, name: target.name, base: target.base, apiPath: target.apiPath },
        probes: probes.map((p) => ({ id: p.id, method: p.method, path: p.path, checks: p.checks, what: p.what })),
      });
    }

    if (urlPath === '/api/runs') return send(res, 200, { activeRun: activeRunId, runs: listRuns() });

    const runMatch = urlPath.match(/^\/api\/runs\/([\w-]+)(\/log)?$/);
    if (runMatch) {
      const run = runDetail(runMatch[1]);
      if (!run) return send(res, 404, { error: 'Unknown run' });
      if (runMatch[2]) {
        const live = runs.get(runMatch[1]);
        if (live) return send(res, 200, { id: run.id, status: run.status, log: live.log });
        const logFile = path.join(runDir(runMatch[1]), 'run.log');
        const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no log for this run)';
        return send(res, 200, { id: run.id, status: run.status, log });
      }
      const live = runs.get(runMatch[1]);
      return send(res, 200, { ...run, log: live ? live.log.slice(-20000) : undefined });
    }

    if (urlPath === '/api/scan') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      const body = await readBody(req);
      const pf = await promptfooStatus(false);
      if (!pf.available) {
        return send(res, 503, {
          error: 'promptfoo is not available',
          detail: pf.detail,
          hint: 'Run `npm install` in redteam/ (or set PROMPTFOO_BIN) and retry.',
        });
      }
      const run = startScan({ targetKey: body.target, probes: body.probes, label: body.label, apiPath: body.apiPath });
      return send(res, 202, { run: { ...run, log: undefined } });
    }

    if (urlPath.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
    return serveStatic(res, urlPath);
  } catch (error) {
    if (error.statusCode) return send(res, error.statusCode, { error: error.message });
    return send(res, 500, { error: error.message });
  }
});

function shutdown() {
  for (const run of runs.values()) if (run.status === 'running') run.status = 'aborted';
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`redteam console on http://localhost:${PORT} — ${TARGETS.length} fleet targets, promptfoo via ${promptfooCommand().how}`);
});
