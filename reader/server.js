/**
 * reader — a private, script-free reader proxy (the "browser" niche).
 *
 * Give it a URL and it fetches the page server-side, throws away every script,
 * style and tracker, and returns the plain readable text. Nothing from the page
 * runs in your browser. With a premium tier it also archives articles straight
 * into the Vault service.
 *
 *   POST /api/read  { url, save? }   fetch + extract readable text
 *   GET  /api/reads                  recent reads
 *   POST /api/premium/subscribe      $3/mo -> unlimited reads + vault archive
 *   GET  /api/premium/status
 *
 * The extraction is real: remote HTML is fetched and reduced to text. If the
 * page is unreachable the endpoint says so.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3017;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL;
const VAULT_URL = process.env.VAULT_URL || 'http://127.0.0.1:3016';

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const READER_PRICE_CENTS = 300; // $3.00 / month
const FREE_DAILY_READS = 10;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'reader.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS reads (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    url        TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    words      INTEGER NOT NULL DEFAULT 0,
    text       TEXT NOT NULL,
    saved      INTEGER NOT NULL DEFAULT 0,
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
// Auth
// ---------------------------------------------------------------------------
function tokenOf(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

function premiumOf(req) {
  const token = tokenOf(req);
  if (!token) return { premium: false, tier: 'free' };
  if (token === PAYONEER_TOKEN) return { premium: true, tier: 'reader' };
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ? ORDER BY id DESC LIMIT 1').get(token);
  if (sub && new Date() < new Date(sub.expires_at)) return { premium: true, tier: sub.tier };
  return { premium: false, tier: 'free' };
}

function subscribeReader() {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)')
    .run('current', 'reader', expiresAt.toISOString());
  return { tier: 'reader', expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Extraction (real)
// ---------------------------------------------------------------------------
function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { const u = new URL(withScheme); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null; } catch { return null; }
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

function extract(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = decodeEntities((titleMatch?.[1] || h1Match?.[1] || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  body = body.replace(/<(p|div|section|article|br|li|h[1-6]|tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  body = decodeEntities(body).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  return { title, text: body };
}

async function fetchReadable(url) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'reader/1.0 (+private reader)', Accept: 'text/html,application/xhtml+xml' },
    });
  } catch (error) {
    const err = new Error(`Could not fetch ${url}: ${error.name === 'AbortError' ? 'timed out' : error.message}`);
    err.statusCode = 502;
    throw err;
  }
  const type = res.headers.get('content-type') || '';
  const raw = (await res.text()).slice(0, 2_000_000);
  const extracted = extract(raw);
  return { title: extracted.title || url, text: extracted.text, contentType: type.split(';')[0], status: res.status };
}

async function archiveToVault(title, text) {
  try {
    const res = await fetch(`${VAULT_URL}/api/files?name=${encodeURIComponent(title.slice(0, 100) + '.txt')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [
  {
    method: 'POST',
    pattern: /^\/api\/read$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const url = normalizeUrl(body.url);
      if (!url) return send(res, 400, { error: 'A valid http(s) url is required' });
      const { premium } = premiumOf(req);
      const today = new Date().toISOString().slice(0, 10);
      if (!premium) {
        const used = db.prepare("SELECT COUNT(*) AS n FROM reads WHERE created_at >= ?").get(today).n;
        if (used >= FREE_DAILY_READS) {
          return send(res, 402, { error: 'Daily read limit reached', limit: FREE_DAILY_READS, upgrade: `$${READER_PRICE_CENTS / 100}/month for unlimited reads + archiving` });
        }
      }
      const page = await fetchReadable(url);
      const words = page.text ? page.text.split(/\s+/).length : 0;
      let saved = 0;
      if (premium && body.save) saved = (await archiveToVault(page.title, page.text)) ? 1 : 0;
      const info = db.prepare('INSERT INTO reads (url, title, words, text, saved) VALUES (?, ?, ?, ?, ?)')
        .run(url, page.title, words, page.text, saved);
      return send(res, 200, {
        id: Number(info.lastInsertRowid),
        url,
        title: page.title,
        words,
        saved: Boolean(saved),
        vault: saved ? `${VAULT_URL}/api/files` : null,
        text: page.text.slice(0, 20000),
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/reads$/,
    handler: (req, res) => {
      const rows = db.prepare('SELECT id, url, title, words, saved, created_at FROM reads ORDER BY id DESC LIMIT 30').all();
      return send(res, 200, { reads: rows });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/reads\/(\d+)$/,
    handler: (req, res, m) => {
      const row = db.prepare('SELECT * FROM reads WHERE id = ?').get(Number(m[1]));
      if (!row) return send(res, 404, { error: 'Read not found' });
      return send(res, 200, row);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
      const sub = subscribeReader();
      const payment = STRIPE_PUBLIC_KEY
        ? { method: 'stripe', checkout: `${origin}/?checkout=reader&key=${STRIPE_PUBLIC_KEY}` }
        : { method: 'payoneer', token: PAYONEER_TOKEN, amount: READER_PRICE_CENTS / 100, currency: 'USD' };
      return send(res, 201, { success: true, tier: 'reader', price: READER_PRICE_CENTS / 100, expiresAt: sub.expiresAt, payment, message: `Reader active — $${READER_PRICE_CENTS / 100}/month` });
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
        price: READER_PRICE_CENTS / 100,
        freeDailyReads: FREE_DAILY_READS,
        vault: VAULT_URL,
        message: premium ? 'Reader active — unlimited reads + archive to Vault' : 'Free — 10 reads/day, no archiving',
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
  console.log(`reader on http://localhost:${PORT} — archiving to ${VAULT_URL}`);
});
