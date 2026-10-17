/**
 * audit-funnel — security audit as a service.
 *
 * A real, dependency-free web-security scanner plus the paid funnel around it:
 *   POST /api/scan                 { target } -> free summary (score + severity counts)
 *   GET  /api/scans                recent scans
 *   GET  /api/scans/:id            full findings (premium) or locked summary (free)
 *   POST /api/premium/subscribe    { tier: 'report' | 'monitoring' }
 *   GET  /api/premium/status
 *   POST /api/monitoring           { target }  add a monitored target (premium)
 *   GET  /api/monitoring           list monitored targets (premium)
 *   POST /api/monitoring/run       re-scan every monitored target (premium)
 *
 * Nothing is simulated: the scanner makes real HTTP requests to the target and
 * reports what it actually observed. If a target is unreachable the scan fails
 * honestly with the network error.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3011;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL; // e.g. https://audit.example.com behind a proxy

// Payment: Payoneer token works out of the box; STRIPE_PUBLIC_KEY upgrades to Stripe.
const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const REPORT_PRICE_CENTS = 4900; // $49.00 one-time full report
const MONITORING_PRICE_CENTS = 19900; // $199.00 / month continuous monitoring
const FREE_FINDINGS = 1; // free scan shows a single finding as a teaser

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'audit.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS scans (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    target        TEXT NOT NULL,
    score         INTEGER NOT NULL,
    counts        TEXT NOT NULL,
    findings      TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS premium_subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_identifier TEXT NOT NULL,
    tier            TEXT NOT NULL DEFAULT 'free',
    expires_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS monitoring (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    target       TEXT NOT NULL UNIQUE,
    last_scan_at TEXT,
    last_score   INTEGER,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
    req.on('data', (c) => {
      raw += c;
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
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, '<h1>404</h1>');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Auth / premium
// ---------------------------------------------------------------------------
function tokenOf(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

function activeSubscription(identifier) {
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ? ORDER BY id DESC LIMIT 1').get(identifier);
  if (sub && new Date() < new Date(sub.expires_at)) return sub;
  return null;
}

function premiumOf(req) {
  const token = tokenOf(req);
  if (!token) return { premium: false, tier: 'free' };
  if (token === PAYONEER_TOKEN) {
    const sub = activeSubscription('current');
    return { premium: true, tier: sub ? sub.tier : 'report' };
  }
  const sub = activeSubscription(token);
  if (sub) return { premium: true, tier: sub.tier };
  return { premium: false, tier: 'free' };
}

function subscribe(tier) {
  const days = tier === 'monitoring' ? 30 : 3650; // monitoring monthly, report one-time (10y)
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)')
    .run('current', tier, expiresAt.toISOString());
  return { tier, expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// The scanner (real HTTP, no dependencies)
// ---------------------------------------------------------------------------
const SECURITY_HEADERS = [
  ['content-security-policy', 'Missing Content-Security-Policy', 'high', 'CSP is the primary defence against XSS and injection. Add a policy that allowlists your own sources.'],
  ['strict-transport-security', 'Missing Strict-Transport-Security (HSTS)', 'medium', 'Without HSTS a user can be downgraded to plain HTTP. Send "max-age=31536000; includeSubDomains".'],
  ['x-content-type-options', 'Missing X-Content-Type-Options', 'low', 'Browsers may MIME-sniff responses. Send "nosniff".'],
  ['x-frame-options', 'Missing X-Frame-Options', 'medium', 'The page can be framed by another site (clickjacking). Send "DENY" or "SAMEORIGIN", or use CSP frame-ancestors.'],
  ['referrer-policy', 'Missing Referrer-Policy', 'low', 'Full URLs (which may include tokens) leak to third parties. Send "strict-origin-when-cross-origin" or stricter.'],
  ['permissions-policy', 'Missing Permissions-Policy', 'low', 'Browser features (camera, geolocation, …) are not restricted. Send a Permissions-Policy header.'],
];

const EXPOSED_PATHS = [
  ['/.env', 'Environment file exposed', 'high', /[A-Z0-9_]+=/],
  ['/.git/config', 'Git repository exposed', 'high', /\[core\]|repositoryformatversion/],
  ['/.git/HEAD', 'Git repository exposed', 'high', /^ref:/m],
  ['/wp-config.php.bak', 'WordPress config backup exposed', 'high', /DB_PASSWORD|DB_NAME/],
  ['/.DS_Store', 'macOS metadata file exposed', 'low', /Bud1|\.DS_Store/],
  ['/server-status', 'Apache server-status exposed', 'medium', /Apache Server Status/],
  ['/.htaccess', 'Apache config exposed', 'medium', /RewriteEngine|<FilesMatch/i],
  ['/backup.zip', 'Backup archive exposed', 'high', /PK/],
  ['/config.json', 'Config file exposed', 'medium', /"|:/],
];

async function fetchOnce(url, { method = 'GET', timeout = 6000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { method, redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'audit-funnel/1.0' } });
    const text = method === 'GET' ? (await res.text()).slice(0, 4000) : '';
    return { status: res.status, headers: res.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try { url = new URL(withScheme); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  // Keep path, drop query for a stable target string.
  const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`;
  return { base, isHttps: url.protocol === 'https:' };
}

async function runScan(target) {
  const findings = [];
  let main;
  try {
    main = await fetchOnce(target.base);
  } catch (error) {
    const err = new Error(`Target unreachable: ${error.name === 'AbortError' ? 'request timed out' : error.message}`);
    err.statusCode = 502;
    throw err;
  }

  // 1. Security headers
  for (const [header, title, severity, remediation] of SECURITY_HEADERS) {
    if (header === 'strict-transport-security' && !target.isHttps) continue; // N/A over plain HTTP
    if (!main.headers.get(header)) {
      findings.push({ id: `hdr-${header}`, title, severity, evidence: `no ${header} header`, remediation });
    }
  }

  // 2. Server fingerprint disclosure
  const poweredBy = main.headers.get('x-powered-by');
  const server = main.headers.get('server');
  if (poweredBy) {
    findings.push({ id: 'hdr-x-powered-by', title: 'Technology disclosure via X-Powered-By', severity: 'low', evidence: `x-powered-by: ${poweredBy}`, remediation: 'Remove the X-Powered-By header so attackers cannot fingerprint your stack.' });
  }
  if (server && /\d/.test(server)) {
    findings.push({ id: 'hdr-server-version', title: 'Server header leaks a version', severity: 'low', evidence: `server: ${server}`, remediation: 'Strip version numbers from the Server header.' });
  }

  // 3. Cookie flags
  const setCookie = main.headers.getSetCookie ? main.headers.getSetCookie() : [];
  setCookie.forEach((cookie, i) => {
    const name = cookie.split('=')[0].trim() || `cookie${i}`;
    if (!/;\s*secure/i.test(cookie) && target.isHttps) {
      findings.push({ id: `cookie-secure-${name}`, title: `Cookie "${name}" is missing the Secure flag`, severity: 'medium', evidence: `set-cookie: ${name}=… (no Secure)`, remediation: 'Add the Secure attribute so the cookie is only sent over HTTPS.' });
    }
    if (!/;\s*httponly/i.test(cookie)) {
      findings.push({ id: `cookie-httponly-${name}`, title: `Cookie "${name}" is missing HttpOnly`, severity: 'medium', evidence: `set-cookie: ${name}=… (no HttpOnly)`, remediation: 'Add HttpOnly so JavaScript cannot read the cookie (blocks XSS theft).' });
    }
    if (!/;\s*samesite/i.test(cookie)) {
      findings.push({ id: `cookie-samesite-${name}`, title: `Cookie "${name}" is missing SameSite`, severity: 'low', evidence: `set-cookie: ${name}=… (no SameSite)`, remediation: 'Add SameSite=Lax (or Strict) to reduce CSRF risk.' });
    }
  });

  // 4. Exposed sensitive paths
  for (const [p, title, severity, pattern] of EXPOSED_PATHS) {
    let probe;
    try {
      probe = await fetchOnce(target.base + p);
    } catch { continue; }
    if (probe.status === 200 && pattern.test(probe.text)) {
      findings.push({
        id: `exposed-${p}`,
        title,
        severity,
        evidence: `GET ${p} -> 200 (${probe.text.replace(/\s+/g, ' ').slice(0, 80)}…)`,
        remediation: `Block ${p} at the web server / CDN and remove the file from the deployment.`,
      });
    }
  }

  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  const score = Math.max(0, 100 - (counts.high * 25 + counts.medium * 12 + counts.low * 5));

  return {
    target: target.base,
    scannedAt: new Date().toISOString(),
    status: main.status,
    score,
    counts,
    total: findings.length,
    findings: findings.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity])),
  };
}

function persistScan(result) {
  const info = db.prepare('INSERT INTO scans (target, score, counts, findings) VALUES (?, ?, ?, ?)')
    .run(result.target, result.score, JSON.stringify(result.counts), JSON.stringify(result.findings));
  return Number(info.lastInsertRowid);
}

function scanSummary(row) {
  const counts = JSON.parse(row.counts);
  const findings = JSON.parse(row.findings);
  return {
    id: row.id,
    target: row.target,
    scannedAt: row.created_at,
    score: row.score,
    counts,
    total: findings.length,
    sampleFinding: findings[0] || null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [
  {
    method: 'POST',
    pattern: /^\/api\/scan$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const target = normalizeTarget(body.target);
      if (!target) return send(res, 400, { error: 'A valid http(s) target is required, e.g. example.com' });
      const result = await runScan(target);
      const id = persistScan(result);
      const { premium } = premiumOf(req);
      if (premium) {
        return send(res, 201, { id, ...result, locked: false });
      }
      const summary = scanSummary({ id, target: result.target, created_at: result.scannedAt, score: result.score, counts: JSON.stringify(result.counts), findings: JSON.stringify(result.findings) });
      return send(res, 201, {
        ...summary,
        locked: true,
        lockedFindings: Math.max(0, result.total - FREE_FINDINGS),
        upgrade: `Unlock the full report (${result.total} findings + fixes) for $${REPORT_PRICE_CENTS / 100}.`,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/scans$/,
    handler: (req, res) => {
      const rows = db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 25').all();
      return send(res, 200, { scans: rows.map(scanSummary) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/scans\/(\d+)$/,
    handler: (req, res, m) => {
      const row = db.prepare('SELECT * FROM scans WHERE id = ?').get(Number(m[1]));
      if (!row) return send(res, 404, { error: 'Scan not found' });
      const { premium } = premiumOf(req);
      if (premium) {
        return send(res, 200, {
          ...scanSummary(row),
          findings: JSON.parse(row.findings),
          locked: false,
        });
      }
      const summary = scanSummary(row);
      return send(res, 200, {
        ...summary,
        findings: summary.sampleFinding ? [summary.sampleFinding] : [],
        locked: true,
        lockedFindings: Math.max(0, summary.total - FREE_FINDINGS),
        upgrade: `Unlock ${summary.total} findings + fixes for $${REPORT_PRICE_CENTS / 100}.`,
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const tier = body.tier === 'monitoring' ? 'monitoring' : 'report';
      const priceCents = tier === 'monitoring' ? MONITORING_PRICE_CENTS : REPORT_PRICE_CENTS;
      const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
      const sub = subscribe(tier);
      const payment = STRIPE_PUBLIC_KEY
        ? { method: 'stripe', checkout: `${origin}/?checkout=${tier}&key=${STRIPE_PUBLIC_KEY}` }
        : { method: 'payoneer', token: PAYONEER_TOKEN, amount: priceCents / 100, currency: 'USD' };
      return send(res, 201, {
        success: true,
        tier,
        price: priceCents / 100,
        expiresAt: sub.expiresAt,
        payment,
        message: tier === 'monitoring'
          ? `Monitoring active — $${priceCents / 100}/month`
          : `Full report unlocked — $${priceCents / 100}`,
      });
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
        reportPrice: REPORT_PRICE_CENTS / 100,
        monitoringPrice: MONITORING_PRICE_CENTS / 100,
        message: premium ? `Premium active (${tier})` : 'Free tier — scans show a summary only',
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/monitoring$/,
    handler: async (req, res) => {
      const { premium } = premiumOf(req);
      if (!premium) return send(res, 402, { error: 'Monitoring requires an active subscription', upgrade: `$${MONITORING_PRICE_CENTS / 100}/month` });
      const body = await readBody(req);
      const target = normalizeTarget(body.target);
      if (!target) return send(res, 400, { error: 'A valid http(s) target is required' });
      db.prepare('INSERT OR IGNORE INTO monitoring (target) VALUES (?)').run(target.base);
      const row = db.prepare('SELECT * FROM monitoring WHERE target = ?').get(target.base);
      return send(res, 201, row);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/monitoring$/,
    handler: (req, res) => {
      const { premium } = premiumOf(req);
      if (!premium) return send(res, 402, { error: 'Monitoring requires an active subscription' });
      return send(res, 200, { targets: db.prepare('SELECT * FROM monitoring ORDER BY id DESC').all() });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/monitoring\/run$/,
    handler: async (req, res) => {
      const { premium } = premiumOf(req);
      if (!premium) return send(res, 402, { error: 'Monitoring requires an active subscription' });
      const rows = db.prepare('SELECT * FROM monitoring ORDER BY id').all();
      const results = [];
      for (const row of rows) {
        const target = normalizeTarget(row.target);
        try {
          const result = await runScan(target);
          persistScan(result);
          db.prepare('UPDATE monitoring SET last_scan_at = ?, last_score = ? WHERE id = ?')
            .run(result.scannedAt, result.score, row.id);
          results.push({ target: row.target, score: result.score, total: result.total, ok: true });
        } catch (error) {
          results.push({ target: row.target, ok: false, error: error.message });
        }
      }
      return send(res, 200, { ranAt: new Date().toISOString(), results });
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
      try { return await r.handler(req, res, m); } catch (e) {
        return send(res, e.statusCode || 500, { error: e.message });
      }
    }
  }
  if (urlPath.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
  return serveStatic(res, urlPath);
});

server.listen(PORT, () => {
  console.log(`audit-funnel serving on http://localhost:${PORT}`);
});
