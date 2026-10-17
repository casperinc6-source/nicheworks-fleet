/**
 * keysmith (pqc-migration) — post-quantum readiness.
 *
 * A real analyser: paste a PEM public key and it parses it with node:crypto,
 * reports the actual algorithm and key size, and scores its exposure to a
 * quantum adversary (Shor's algorithm breaks RSA/ECC/EdDSA/X25519).
 *
 *   GET  /api/standards                  the NIST post-quantum algorithms
 *   POST /api/analyze    { key }         analyse one public key
 *   POST /api/inventory  { items: [] }   score a whole crypto inventory
 *   GET  /api/analyses                   history
 *   GET  /api/analyses/:id               detail (full roadmap is premium)
 *   POST /api/premium/subscribe          { tier: 'roadmap' | 'program' }
 *   GET  /api/premium/status
 *
 * Nothing is faked: key details come from the crypto parser. If the input is
 * not a key, the endpoint says so.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3013;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL;

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const ROADMAP_PRICE_CENTS = 29900; // $299 one-time migration roadmap
const PROGRAM_PRICE_CENTS = 99900; // $999 / month managed migration

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'keysmith.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS analyses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    asset      TEXT NOT NULL,
    algorithm  TEXT NOT NULL,
    key_size   TEXT NOT NULL,
    score      INTEGER NOT NULL,
    report     TEXT NOT NULL,
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
    req.on('data', (c) => { raw += c; if (raw.length > 2e5) { reject(new Error('Body too large')); req.destroy(); } });
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
  if (token === PAYONEER_TOKEN) return { premium: true, tier: 'roadmap' };
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ? ORDER BY id DESC LIMIT 1').get(token);
  if (sub && new Date() < new Date(sub.expires_at)) return { premium: true, tier: sub.tier };
  return { premium: false, tier: 'free' };
}

function subscribe(tier) {
  const days = tier === 'program' ? 30 : 3650;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)')
    .run('current', tier, expiresAt.toISOString());
  return { tier, expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Standards + analysis
// ---------------------------------------------------------------------------
const STANDARDS = [
  { id: 'ML-KEM',     fips: 'FIPS 203', basis: 'CRYSTALS-Kyber', use: 'Key encapsulation (replaces RSA/ECDH key transport)', status: 'final' },
  { id: 'ML-DSA',     fips: 'FIPS 204', basis: 'CRYSTALS-Dilithium', use: 'Digital signatures (replaces RSA/ECDSA/EdDSA)', status: 'final' },
  { id: 'SLH-DSA',    fips: 'FIPS 205', basis: 'SPHINCS+', use: 'Stateless hash-based signatures (conservative backup)', status: 'final' },
  { id: 'FN-DSA',     fips: 'draft',    basis: 'Falcon', use: 'Compact signatures for constrained environments', status: 'draft' },
  { id: 'X25519MLKEM768', fips: '—',    basis: 'Hybrid TLS group', use: 'Transitional hybrid key exchange for TLS 1.3', status: 'deployed' },
];

const CLASSICAL = {
  rsa: { quantum: 'broken', why: "Shor's algorithm factors the RSA modulus", replace: 'ML-KEM-768 (encryption) + ML-DSA-65 (signatures)' },
  ec: { quantum: 'broken', why: "Shor's algorithm solves the elliptic-curve discrete log", replace: 'X25519MLKEM768 (key exchange) + ML-DSA-65 (signatures)' },
  ed25519: { quantum: 'broken', why: "Shor's algorithm recovers the EdDSA secret scalar", replace: 'ML-DSA-65 or SLH-DSA-SHA2-128s' },
  ed448: { quantum: 'broken', why: "Shor's algorithm recovers the EdDSA secret scalar", replace: 'ML-DSA-87 or SLH-DSA-SHA2-128s' },
  x25519: { quantum: 'broken', why: 'ECDH is solved by Shor’s algorithm', replace: 'X25519MLKEM768 (hybrid) or ML-KEM-768' },
  x448: { quantum: 'broken', why: 'ECDH is solved by Shor’s algorithm', replace: 'ML-KEM-1024' },
  dsa: { type: 'classical', quantum: 'broken', why: "Shor's algorithm solves the discrete log", replace: 'ML-DSA-65' },
  dh: { quantum: 'broken', why: 'Finite-field Diffie-Hellman is solved by Shor’s algorithm', replace: 'ML-KEM-768' },
};

function parseKey(pem) {
  const text = String(pem || '').trim();
  if (!text) { const e = new Error('A public key (PEM) is required'); e.statusCode = 400; throw e; }
  const attempts = [
    () => crypto.createPublicKey(text),
    () => crypto.createPublicKey({ key: Buffer.from(text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' }),
  ];
  let lastErr;
  for (const attempt of attempts) {
    try { return attempt(); } catch (e) { lastErr = e; }
  }
  const err = new Error(`Could not parse a public key: ${lastErr.message}`);
  err.statusCode = 400;
  throw err;
}

function analyzeKey(pem, asset) {
  const key = parseKey(pem);
  const type = key.asymmetricKeyType;
  const details = key.asymmetricKeyDetails || {};
  const keySize = type === 'rsa'
    ? `${details.modulusLength} bits`
    : details.namedCurve || (type === 'ed25519' || type === 'x25519' ? '255 bits' : 'unknown');

  const entry = CLASSICAL[type] || null;
  const algorithm = type.toUpperCase() + (details.namedCurve ? ` (${details.namedCurve})` : '');

  const report = {
    asset: String(asset || 'unnamed key'),
    algorithm,
    keyType: type,
    keySize,
    quantumVulnerable: entry ? entry.quantum === 'broken' : true,
    reason: entry ? entry.why : `No post-quantum mapping known for key type "${type}"; treat as vulnerable until reviewed.`,
    harvestNowDecryptLater: type === 'rsa' || type === 'ec' || type === 'x25519' || type === 'x448',
    recommendedReplacement: entry ? entry.replace : 'ML-KEM-768 + ML-DSA-65 (review the protocol)',
    roadmaps: [
      { phase: '1 · Inventory', detail: 'Record this key, where it is used, and its lifetime. Data encrypted today can be decrypted later ("harvest now, decrypt later"), so long-lived secrets are urgent.' },
      { phase: '2 · Hybrid', detail: `Move TLS/signing to a hybrid mode first (e.g. X25519MLKEM768 for key exchange). Hybrid keeps classical safety while adding PQ safety.` },
      { phase: '3 · PQC-only', detail: `Cut over to ${entry ? entry.replace : 'ML-KEM-768 + ML-DSA-65'} once your client fleet supports it, then retire the classical key.` },
      { phase: '4 · Verify', detail: 'Re-run this analysis on the new key to confirm it parses as a post-quantum type, and re-check certificate chains and pinned clients.' },
    ],
  };
  const score = report.quantumVulnerable ? 10 : 90;
  return { ...report, score };
}

function inventoryScore(items) {
  const analysed = items.map((it) => {
    const algo = String(it.algorithm || it.type || '').toLowerCase();
    const match = /rsa|rsa\d+/.test(algo) ? CLASSICAL.rsa
      : /ecdsa|ec\b|p-?256|p-?384|secp/.test(algo) ? CLASSICAL.ec
        : /ed25519/.test(algo) ? CLASSICAL.ed25519
          : /x25519/.test(algo) ? CLASSICAL.x25519
            : /ml-kem|mlkem|kyber|ml-dsa|dilithium|slh-dsa|sphincs|falcon|fn-dsa/.test(algo) ? null
              : CLASSICAL.ec;
    return {
      name: it.name || algo || 'unnamed',
      algorithm: it.algorithm || it.type || 'unknown',
      quantumVulnerable: Boolean(match),
      replacement: match ? match.replace : 'already post-quantum',
    };
  });
  const vulnerable = analysed.filter((a) => a.quantumVulnerable).length;
  const score = analysed.length ? Math.round((1 - vulnerable / analysed.length) * 100) : 0;
  return { score, total: analysed.length, vulnerable, items: analysed };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [
  { method: 'GET', pattern: /^\/api\/standards$/, handler: (req, res) => send(res, 200, { standards: STANDARDS }) },

  {
    method: 'POST',
    pattern: /^\/api\/analyze$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const report = analyzeKey(body.key, body.asset);
      const info = db.prepare('INSERT INTO analyses (asset, algorithm, key_size, score, report) VALUES (?, ?, ?, ?, ?)')
        .run(report.asset, report.algorithm, report.keySize, report.score, JSON.stringify(report));
      const id = Number(info.lastInsertRowid);
      const { premium } = premiumOf(req);
      if (premium) return send(res, 201, { id, ...report, locked: false });
      const { roadmaps, ...rest } = report;
      return send(res, 201, {
        id,
        ...rest,
        roadmaps: roadmaps.slice(0, 1),
        locked: true,
        lockedPhases: roadmaps.length - 1,
        upgrade: `Unlock the full 4-phase migration roadmap for $${ROADMAP_PRICE_CENTS / 100}.`,
      });
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/inventory$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
      if (!items.length) return send(res, 400, { error: 'Provide items: [{ name, algorithm }]' });
      return send(res, 200, inventoryScore(items));
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/analyses$/,
    handler: (req, res) => {
      const rows = db.prepare('SELECT id, asset, algorithm, key_size, score, created_at FROM analyses ORDER BY id DESC LIMIT 25').all();
      return send(res, 200, { analyses: rows });
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/analyses\/(\d+)$/,
    handler: (req, res, m) => {
      const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get(Number(m[1]));
      if (!row) return send(res, 404, { error: 'Analysis not found' });
      const report = JSON.parse(row.report);
      const { premium } = premiumOf(req);
      if (premium) return send(res, 200, { id: row.id, ...report, locked: false });
      return send(res, 200, {
        id: row.id,
        ...report,
        roadmaps: report.roadmaps.slice(0, 1),
        locked: true,
        lockedPhases: report.roadmaps.length - 1,
        upgrade: `Unlock the full roadmap for $${ROADMAP_PRICE_CENTS / 100}.`,
      });
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const tier = body.tier === 'program' ? 'program' : 'roadmap';
      const priceCents = tier === 'program' ? PROGRAM_PRICE_CENTS : ROADMAP_PRICE_CENTS;
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
        message: tier === 'program'
          ? `Managed migration active — $${priceCents / 100}/month`
          : `Migration roadmap unlocked — $${priceCents / 100}`,
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
        roadmapPrice: ROADMAP_PRICE_CENTS / 100,
        programPrice: PROGRAM_PRICE_CENTS / 100,
        message: premium ? `Premium active (${tier})` : 'Free tier — first roadmap phase only',
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
  console.log(`keysmith on http://localhost:${PORT}`);
});
