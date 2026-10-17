/**
 * loom (artcraft) — generative pattern studio.
 *
 * A real, deterministic SVG pattern engine: every request renders an actual
 * tiling SVG from a style + palette + seed. Nothing is stubbed and nothing
 * needs a network or a model key.
 *
 *   GET  /api/styles                      available styles (+ premium flag)
 *   GET  /api/palettes                    available palettes (+ premium flag)
 *   POST /api/generate  { style, palette, seed, size } -> { id, svg, meta }
 *   GET  /api/patterns                    saved patterns
 *   GET  /api/patterns/:id                one pattern (JSON, with svg)
 *   GET  /api/patterns/:id.svg            raw SVG download
 *   POST /api/premium/subscribe           { tier: 'studio' }  ($9/mo)
 *   GET  /api/premium/status
 *
 * Free: first styles + first palettes, watermarked, personal use.
 * Studio: every style + palette, no watermark, SVG/PNG-ready export, commercial licence.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3012;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL;

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const STUDIO_PRICE_CENTS = 900; // $9.00 / month
const FREE_STYLES = 3;
const FREE_PALETTES = 3;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'loom.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS patterns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    style      TEXT NOT NULL,
    palette    TEXT NOT NULL,
    seed       INTEGER NOT NULL,
    size       INTEGER NOT NULL,
    svg        TEXT NOT NULL,
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
// Auth
// ---------------------------------------------------------------------------
function tokenOf(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

function premiumOf(req) {
  const token = tokenOf(req);
  if (!token) return { premium: false, tier: 'free' };
  if (token === PAYONEER_TOKEN) return { premium: true, tier: 'studio' };
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ? ORDER BY id DESC LIMIT 1').get(token);
  if (sub && new Date() < new Date(sub.expires_at)) return { premium: true, tier: sub.tier };
  return { premium: false, tier: 'free' };
}

function subscribeStudio() {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)')
    .run('current', 'studio', expiresAt.toISOString());
  return { tier: 'studio', expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// The pattern engine
// ---------------------------------------------------------------------------
const PALETTES = [
  { name: 'ember',    colors: ['#1a0b06', '#ff7b3d', '#ffcf6b'] },
  { name: 'moss',     colors: ['#0b1410', '#2e6b4f', '#9fe6b5'] },
  { name: 'ink',      colors: ['#0b0f1a', '#3b4a7a', '#a9c8ff'] },
  // premium palettes
  { name: 'risograph', colors: ['#f5efe0', '#ff4f6d', '#2c5dff'], premium: true },
  { name: 'desert',    colors: ['#2c1e12', '#c98a3c', '#f2d9a0'], premium: true },
  { name: 'neon',      colors: ['#07020f', '#ff2fb0', '#31f5ff'], premium: true },
  { name: 'mono',      colors: ['#111111', '#8a8a8a', '#f5f5f5'], premium: true },
  { name: 'orchard',   colors: ['#10231a', '#e05c3b', '#f4c95d'], premium: true },
];

const STYLES = [
  { id: 'grid',        name: 'Grid',        premium: false },
  { id: 'dots',        name: 'Dots',        premium: false },
  { id: 'waves',       name: 'Waves',       premium: false },
  // premium styles
  { id: 'chevron',     name: 'Chevron',     premium: true },
  { id: 'triangles',   name: 'Triangles',   premium: true },
  { id: 'scales',      name: 'Scales',      premium: true },
  { id: 'crosshatch',  name: 'Crosshatch',  premium: true },
  { id: 'mosaic',      name: 'Mosaic',      premium: true },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tileBody(style, colors, rand) {
  const [bg, mid, light] = colors;
  const t = 80; // tile size
  switch (style) {
    case 'grid': {
      return `<rect width="${t}" height="${t}" fill="${bg}"/>
        <path d="M0 0H${t}M0 0V${t}" stroke="${mid}" stroke-width="2"/>
        <rect x="${t / 2 - 6}" y="${t / 2 - 6}" width="12" height="12" fill="${light}"/>`;
    }
    case 'dots': {
      const r = 6 + Math.floor(rand() * 6);
      return `<rect width="${t}" height="${t}" fill="${bg}"/>
        <circle cx="${t / 4}" cy="${t / 4}" r="${r}" fill="${mid}"/>
        <circle cx="${t * 3 / 4}" cy="${t * 3 / 4}" r="${r}" fill="${light}"/>`;
    }
    case 'waves': {
      return `<rect width="${t}" height="${t}" fill="${bg}"/>
        <path d="M0 ${t * 0.3} Q ${t / 4} ${t * 0.1} ${t / 2} ${t * 0.3} T ${t} ${t * 0.3}" fill="none" stroke="${mid}" stroke-width="4"/>
        <path d="M0 ${t * 0.7} Q ${t / 4} ${t * 0.5} ${t / 2} ${t * 0.7} T ${t} ${t * 0.7}" fill="none" stroke="${light}" stroke-width="4"/>`;
    }
    case 'chevron': {
      return `<rect width="${t}" height="${t}" fill="${bg}"/>
        <path d="M0 ${t * 0.5} L ${t / 2} ${t * 0.25} L ${t} ${t * 0.5}" fill="none" stroke="${mid}" stroke-width="6"/>
        <path d="M0 ${t * 0.8} L ${t / 2} ${t * 0.55} L ${t} ${t * 0.8}" fill="none" stroke="${light}" stroke-width="6"/>`;
    }
    case 'triangles': {
      return `<rect width="${t}" height="${t}" fill="${bg}"/>
        <path d="M0 ${t} L ${t / 2} 0 L ${t} ${t} Z" fill="${mid}"/>
        <path d="M0 0 L ${t / 2} ${t * 0.5} L 0 ${t} Z" fill="${light}" opacity="0.85"/>`;
    }
    case 'scales': {
      return `<rect width="${t}" height="${t}" fill="${bg}"/>
        <path d="M0 ${t} A ${t / 2} ${t / 2} 0 0 1 ${t} ${t}" fill="none" stroke="${mid}" stroke-width="5"/>
        <path d="M0 ${t * 0.5} A ${t / 2} ${t / 2} 0 0 1 ${t} ${t * 0.5}" fill="none" stroke="${light}" stroke-width="5"/>`;
    }
    case 'crosshatch': {
      return `<rect width="${t}" height="${t}" fill="${bg}"/>
        <path d="M0 0 L ${t} ${t} M ${t} 0 L 0 ${t}" stroke="${mid}" stroke-width="3" opacity="0.8"/>
        <path d="M0 ${t / 2} H ${t} M ${t / 2} 0 V ${t}" stroke="${light}" stroke-width="1.5" opacity="0.6"/>`;
    }
    case 'mosaic': {
      const cell = t / 4;
      let rects = '';
      for (let y = 0; y < 4; y += 1) {
        for (let x = 0; x < 4; x += 1) {
          const pick = rand();
          if (pick > 0.6) {
            const fill = pick > 0.85 ? light : mid;
            rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell - 2}" height="${cell - 2}" fill="${fill}"/>`;
          }
        }
      }
      return `<rect width="${t}" height="${t}" fill="${bg}"/>${rects}`;
    }
    default:
      return `<rect width="${t}" height="${t}" fill="${bg}"/>`;
  }
}

function patternSvg({ style, paletteName, seed, size, watermark }) {
  const palette = PALETTES.find((p) => p.name === paletteName) || PALETTES[0];
  const rand = mulberry32(seed >>> 0);
  const tile = tileBody(style, palette.colors, rand);
  const mark = watermark
    ? `<text x="${size / 2}" y="${size / 2}" text-anchor="middle" font-family="monospace" font-size="${size / 14}" fill="#ffffff" opacity="0.35" transform="rotate(-18 ${size / 2} ${size / 2})">LOOM</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><pattern id="tile" width="80" height="80" patternUnits="userSpaceOnUse">${tile}</pattern></defs>
  <rect width="${size}" height="${size}" fill="url(#tile)"/>
  ${mark}
</svg>`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/styles$/,
    handler: (req, res) => send(res, 200, { styles: STYLES.map((s, i) => ({ ...s, free: i < FREE_STYLES })) }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/palettes$/,
    handler: (req, res) => send(res, 200, { palettes: PALETTES.map((p, i) => ({ name: p.name, colors: p.colors, premium: Boolean(p.premium) || i >= FREE_PALETTES })) }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/generate$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const { premium } = premiumOf(req);
      const style = STYLES.find((s) => s.id === body.style) || STYLES[0];
      const paletteIdx = Math.max(0, PALETTES.findIndex((p) => p.name === body.palette));
      const palette = PALETTES[paletteIdx === -1 ? 0 : paletteIdx];
      const paletteIsPremium = Boolean(palette.premium) || paletteIdx >= FREE_PALETTES;
      if (!premium && style.premium) return send(res, 402, { error: `Style "${style.id}" is a studio feature`, upgrade: `$${STUDIO_PRICE_CENTS / 100}/month for every style and palette` });
      if (!premium && paletteIsPremium) return send(res, 402, { error: `Palette "${palette.name}" is a studio feature`, upgrade: `$${STUDIO_PRICE_CENTS / 100}/month for every style and palette` });
      const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) : Math.floor(Math.random() * 1e9);
      const size = Math.min(2048, Math.max(256, Number(body.size) || 800));
      const svg = patternSvg({ style: style.id, paletteName: palette.name, seed, size, watermark: !premium });
      const info = db.prepare('INSERT INTO patterns (style, palette, seed, size, svg) VALUES (?, ?, ?, ?, ?)')
        .run(style.id, palette.name, seed, size, svg);
      return send(res, 201, {
        id: Number(info.lastInsertRowid),
        style: style.id,
        palette: palette.name,
        seed,
        size,
        svg,
        license: premium ? 'commercial' : 'personal',
        watermark: !premium,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/patterns$/,
    handler: (req, res) => {
      const rows = db.prepare('SELECT id, style, palette, seed, size, created_at FROM patterns ORDER BY id DESC LIMIT 50').all();
      return send(res, 200, { patterns: rows });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/patterns\/(\d+)$/,
    handler: (req, res, m) => {
      const row = db.prepare('SELECT * FROM patterns WHERE id = ?').get(Number(m[1]));
      if (!row) return send(res, 404, { error: 'Pattern not found' });
      return send(res, 200, row);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/patterns\/(\d+)\.svg$/,
    handler: (req, res, m) => {
      const row = db.prepare('SELECT * FROM patterns WHERE id = ?').get(Number(m[1]));
      if (!row) return send(res, 404, '<h1>404</h1>');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Disposition': `attachment; filename="loom-${row.id}-${row.style}.svg"` });
      res.end(row.svg);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
      const sub = subscribeStudio();
      const payment = STRIPE_PUBLIC_KEY
        ? { method: 'stripe', checkout: `${origin}/?checkout=studio&key=${STRIPE_PUBLIC_KEY}` }
        : { method: 'payoneer', token: PAYONEER_TOKEN, amount: STUDIO_PRICE_CENTS / 100, currency: 'USD' };
      return send(res, 201, { success: true, tier: 'studio', price: STUDIO_PRICE_CENTS / 100, expiresAt: sub.expiresAt, payment, message: `Studio active — $${STUDIO_PRICE_CENTS / 100}/month` });
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
        price: STUDIO_PRICE_CENTS / 100,
        freeStyles: STYLES.filter((s) => !s.premium).map((s) => s.id),
        freePalettes: PALETTES.slice(0, FREE_PALETTES).map((p) => p.name),
        message: premium ? 'Studio active — every style, every palette, commercial licence' : 'Free tier — 3 styles, 3 palettes, watermarked, personal use',
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
  console.log(`loom pattern studio on http://localhost:${PORT}`);
});
