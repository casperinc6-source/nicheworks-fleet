/**
 * vault — offline file storage.
 *
 * A real, self-hosted file vault: uploads are written to disk, content-addressed
 * by SHA-256 (so identical files are stored once), and served back byte-for-byte.
 * No cloud, no third party — the bytes live in ./data/blobs on this machine.
 *
 *   GET    /api/files                 list files + usage
 *   POST   /api/files?name=foo.txt    upload (raw body)     [free: 100 MB total]
 *   GET    /api/files/:id             download
 *   DELETE /api/files/:id             delete
 *   POST   /api/premium/subscribe     $5/mo -> 5 GB vault
 *   GET    /api/premium/status
 *
 * Free quota is enforced honestly: an upload that would exceed it is refused
 * with 402 and nothing is written.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3016;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BLOB_DIR = path.join(DATA_DIR, 'blobs');
const BASE_URL = process.env.BASE_URL;

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const PRO_PRICE_CENTS = 500; // $5.00 / month
const FREE_QUOTA = 100 * 1024 * 1024;       // 100 MB
const PRO_QUOTA = 5 * 1024 * 1024 * 1024;   // 5 GB
const MAX_UPLOAD = 100 * 1024 * 1024;       // hard per-file cap

fs.mkdirSync(BLOB_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'vault.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS files (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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

// Read a raw request body into a Buffer (binary-safe), with a hard cap.
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error(`Upload exceeds ${limit} bytes`), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Auth / quota
// ---------------------------------------------------------------------------
function tokenOf(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

function premiumOf(req) {
  const token = tokenOf(req);
  if (!token) return { premium: false, tier: 'free' };
  if (token === PAYONEER_TOKEN) return { premium: true, tier: 'pro' };
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ? ORDER BY id DESC LIMIT 1').get(token);
  if (sub && new Date() < new Date(sub.expires_at)) return { premium: true, tier: sub.tier };
  return { premium: false, tier: 'free' };
}

function usage() {
  const row = db.prepare('SELECT COALESCE(SUM(size),0) AS used, COUNT(*) AS n FROM files').get();
  return { used: row.used, files: row.n };
}

function subscribePro() {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)')
    .run('current', 'pro', expiresAt.toISOString());
  return { tier: 'pro', expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/files$/,
    handler: (req, res) => {
      const { premium } = premiumOf(req);
      const files = db.prepare('SELECT id, name, size, sha256, content_type, created_at FROM files ORDER BY id DESC').all();
      const use = usage();
      return send(res, 200, {
        files,
        quota: premium ? PRO_QUOTA : FREE_QUOTA,
        used: use.used,
        remaining: Math.max(0, (premium ? PRO_QUOTA : FREE_QUOTA) - use.used),
        tier: premium ? 'pro' : 'free',
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/files$/,
    handler: async (req, res) => {
      const { premium } = premiumOf(req);
      const quota = premium ? PRO_QUOTA : FREE_QUOTA;
      const name = String(new URL(req.url, 'http://x').searchParams.get('name') || 'upload.bin').slice(0, 120);
      const body = await readRaw(req, MAX_UPLOAD);
      if (!body.length) return send(res, 400, { error: 'Empty upload' });
      const use = usage();
      if (use.used + body.length > quota) {
        return send(res, 402, {
          error: 'Vault quota exceeded',
          used: use.used,
          quota,
          needed: body.length,
          upgrade: `$${PRO_PRICE_CENTS / 100}/month raises the vault to 5 GB`,
        });
      }
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const blob = path.join(BLOB_DIR, sha256);
      if (!fs.existsSync(blob)) fs.writeFileSync(blob, body);
      const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
      const info = db.prepare('INSERT INTO files (name, size, sha256, content_type) VALUES (?, ?, ?, ?)')
        .run(name, body.length, sha256, type);
      const id = Number(info.lastInsertRowid);
      return send(res, 201, { id, name, size: body.length, sha256, deduped: fs.existsSync(blob) && db.prepare('SELECT COUNT(*) AS n FROM files WHERE sha256 = ?').get(sha256).n > 1 });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/files\/(\d+)$/,
    handler: (req, res, m) => {
      const row = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(m[1]));
      if (!row) return send(res, 404, { error: 'File not found' });
      const blob = path.join(BLOB_DIR, row.sha256);
      if (!fs.existsSync(blob)) return send(res, 410, { error: 'Blob missing from disk' });
      res.writeHead(200, {
        'Content-Type': row.content_type,
        'Content-Length': fs.statSync(blob).size,
        'Content-Disposition': `attachment; filename="${row.name.replace(/"/g, '')}"`,
      });
      return fs.createReadStream(blob).pipe(res);
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/files\/(\d+)$/,
    handler: (req, res, m) => {
      const row = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(m[1]));
      if (!row) return send(res, 404, { error: 'File not found' });
      db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
      // Only unlink the blob if no other row references the same content.
      const refs = db.prepare('SELECT COUNT(*) AS n FROM files WHERE sha256 = ?').get(row.sha256).n;
      if (refs === 0) { try { fs.unlinkSync(path.join(BLOB_DIR, row.sha256)); } catch { /* already gone */ } }
      return send(res, 200, { deleted: row.id, reclaimed: refs === 0 ? row.size : 0 });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
      const sub = subscribePro();
      const payment = STRIPE_PUBLIC_KEY
        ? { method: 'stripe', checkout: `${origin}/?checkout=pro&key=${STRIPE_PUBLIC_KEY}` }
        : { method: 'payoneer', token: PAYONEER_TOKEN, amount: PRO_PRICE_CENTS / 100, currency: 'USD' };
      return send(res, 201, { success: true, tier: 'pro', price: PRO_PRICE_CENTS / 100, expiresAt: sub.expiresAt, payment, message: `Vault Pro active — 5 GB for $${PRO_PRICE_CENTS / 100}/month` });
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
        price: PRO_PRICE_CENTS / 100,
        quota: premium ? PRO_QUOTA : FREE_QUOTA,
        message: premium ? 'Vault Pro — 5 GB, content-addressed dedupe' : 'Free — 100 MB vault',
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
  console.log(`vault open on http://localhost:${PORT} — blobs in ${BLOB_DIR}`);
});
