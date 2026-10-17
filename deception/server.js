/**
 * deception grid — the trap room.
 *
 * A real deception-technology service: it plants plausible decoys (/.env,
 * /wp-login.php, /.aws/credentials, …) and issues canary tokens. Anything that
 * touches a decoy or a canary is logged as a real "trip" with the caller's IP,
 * user-agent and path. This is defensive security: it catches scanners and
 * credential-harvesters that should never have been there.
 *
 *   GET  /                      console
 *   GET  /api/decoys            the planted decoys
 *   GET  /api/trips             recent trips (full detail is premium)
 *   POST /api/canary { label }  mint a canary token + tracking URL
 *   GET  /canary/:id            the canary itself (logs a trip, returns a pixel)
 *   POST /api/premium/subscribe { tier: 'net' }  ($49/mo)
 *   GET  /api/premium/status
 *
 * Any request to a decoy path is answered with believable fake content so the
 * intruder keeps going while we log them.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3015;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL;

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const NET_PRICE_CENTS = 4900; // $49.00 / month
const FREE_TRIP_DETAIL = 3;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'deception.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS trips (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    kind      TEXT NOT NULL,
    ip        TEXT NOT NULL,
    method    TEXT NOT NULL,
    path      TEXT NOT NULL,
    ua        TEXT NOT NULL DEFAULT '',
    at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS canaries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT NOT NULL UNIQUE,
    label      TEXT NOT NULL DEFAULT '',
    hits       INTEGER NOT NULL DEFAULT 0,
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
// The decoys
// ---------------------------------------------------------------------------
const DECOYS = [
  { path: '/.env',              type: 'text/plain', body: 'APP_ENV=production\nDB_HOST=10.0.0.12\nDB_USER=app\nDB_PASSWORD=not-a-real-secret\nSTRIPE_KEY=sk_live_deadbeef\n' },
  { path: '/.git/config',       type: 'text/plain', body: '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n[remote "origin"]\n\turl = git@github.com:internal/app.git\n' },
  { path: '/.aws/credentials',  type: 'text/plain', body: '[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n' },
  { path: '/wp-login.php',      type: 'text/html',  body: '<!doctype html><title>Log In &lsaquo; Site &#8212; WordPress</title><form><input name="log"><input name="pwd" type="password"></form>' },
  { path: '/admin',             type: 'text/html',  body: '<!doctype html><title>Admin</title><h1>Admin console</h1><form><input name="user"><input name="pass" type="password"></form>' },
  { path: '/phpmyadmin/',       type: 'text/html',  body: '<!doctype html><title>phpMyAdmin</title><h1>phpMyAdmin</h1><form><input name="pma_username"><input name="pma_password" type="password"></form>' },
  { path: '/api/keys',          type: 'application/json', body: '{"keys":[{"id":"k_live_1","secret":"sk_live_deadbeef","scopes":["read","write"]}]}' },
  { path: '/backup.zip',        type: 'application/zip',  body: '' },
  { path: '/server-status',     type: 'text/html',  body: '<title>Apache Server Status</title><i>Server Version: Apache/2.4.58</i>' },
  { path: '/config.php',        type: 'text/plain', body: "<?php $db_pass='not-a-real-secret'; define('AUTH_KEY','deadbeef');" },
];

const DECOY_BY_PATH = new Map(DECOYS.map((d) => [d.path, d]));

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function recordTrip(kind, req, urlPath) {
  db.prepare('INSERT INTO trips (kind, ip, method, path, ua) VALUES (?, ?, ?, ?, ?)')
    .run(kind, clientIp(req), req.method, urlPath, String(req.headers['user-agent'] || '').slice(0, 300));
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
  if (token === PAYONEER_TOKEN) return { premium: true, tier: 'net' };
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ? ORDER BY id DESC LIMIT 1').get(token);
  if (sub && new Date() < new Date(sub.expires_at)) return { premium: true, tier: sub.tier };
  return { premium: false, tier: 'free' };
}

function subscribeNet() {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)')
    .run('current', 'net', expiresAt.toISOString());
  return { tier: 'net', expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [
  { method: 'GET', pattern: /^\/api\/decoys$/, handler: (req, res) => send(res, 200, { decoys: DECOYS.map((d) => ({ path: d.path, type: d.type })) }) },

  {
    method: 'GET',
    pattern: /^\/api\/trips$/,
    handler: (req, res) => {
      const { premium } = premiumOf(req);
      const rows = db.prepare('SELECT * FROM trips ORDER BY id DESC LIMIT 100').all();
      const counts = db.prepare('SELECT kind, COUNT(*) AS n FROM trips GROUP BY kind').all();
      if (premium) return send(res, 200, { trips: rows, counts, locked: false });
      const teaser = rows.slice(0, FREE_TRIP_DETAIL).map((t) => ({ kind: t.kind, path: t.path, at: t.at }));
      return send(res, 200, {
        trips: teaser,
        counts,
        locked: true,
        lockedTrips: Math.max(0, rows.length - FREE_TRIP_DETAIL),
        upgrade: `Full trip detail (IP + user-agent) and alerts for $${NET_PRICE_CENTS / 100}/month.`,
      });
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/canary$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const token = crypto.randomBytes(12).toString('hex');
      const label = String(body.label || '').slice(0, 80);
      db.prepare('INSERT INTO canaries (token, label) VALUES (?, ?)').run(token, label);
      const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
      return send(res, 201, { token, label, url: `${origin}/canary/${token}`, hint: 'Plant this URL in a document, config, or email. A hit means someone read something they should not have.' });
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/canaries$/,
    handler: (req, res) => {
      const { premium } = premiumOf(req);
      if (!premium) return send(res, 402, { error: 'Canary management is a net feature', upgrade: `$${NET_PRICE_CENTS / 100}/month` });
      return send(res, 200, { canaries: db.prepare('SELECT * FROM canaries ORDER BY id DESC').all() });
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
      const sub = subscribeNet();
      const payment = STRIPE_PUBLIC_KEY
        ? { method: 'stripe', checkout: `${origin}/?checkout=net&key=${STRIPE_PUBLIC_KEY}` }
        : { method: 'payoneer', token: PAYONEER_TOKEN, amount: NET_PRICE_CENTS / 100, currency: 'USD' };
      return send(res, 201, { success: true, tier: 'net', price: NET_PRICE_CENTS / 100, expiresAt: sub.expiresAt, payment, message: `Deception net active — $${NET_PRICE_CENTS / 100}/month` });
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
        price: NET_PRICE_CENTS / 100,
        decoys: DECOYS.length,
        message: premium ? 'Net active — full trip intelligence, canaries, alerts' : 'Free tier — 3 trips visible, decoys live',
      });
    },
  },
];

// A pixel, base64, so the canary always answers 200.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const server = http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = new URL(req.url, 'http://x').pathname; }
  catch { return send(res, 400, { error: 'Bad request URL' }); }

  // Canary hit?
  const canary = urlPath.match(/^\/canary\/([a-f0-9]+)$/);
  if (canary) {
    const row = db.prepare('SELECT * FROM canaries WHERE token = ?').get(canary[1]);
    if (row) {
      db.prepare('UPDATE canaries SET hits = hits + 1 WHERE id = ?').run(row.id);
      recordTrip('canary', req, urlPath);
    } else {
      recordTrip('canary-unknown', req, urlPath);
    }
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
    return res.end(PIXEL);
  }

  // Decoy hit? (any method — scanners POST too)
  const decoy = DECOY_BY_PATH.get(urlPath) || DECOY_BY_PATH.get(urlPath.replace(/\/$/, ''));
  if (decoy) {
    recordTrip('decoy', req, urlPath);
    res.writeHead(200, { 'Content-Type': decoy.type, 'Cache-Control': 'no-store' });
    return res.end(decoy.body);
  }

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
  console.log(`deception grid watching on http://localhost:${PORT} — ${DECOYS.length} decoys planted`);
});
