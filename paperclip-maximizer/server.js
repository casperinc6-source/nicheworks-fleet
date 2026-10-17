const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getState, saveState, clearState } = require('./db');

const PORT = process.env.PORT || 3005;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' });
  res.end(body);
}

// Coerce an incoming state blob to safe, finite numbers (client is untrusted).
function sanitize(s) {
  if (!s || typeof s !== 'object') return null;
  const num = (v, min, max, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  // Check premium status for clip limits
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  // For demo: Payoneer token = premium access
  const isPremiumToken = token === 'B504755D8A834FC0A0DD5E50F302270A';
  const premiumStatus = isPremiumToken
    ? { premium: true, monthlyLimit: 1000, features: ['unlimited_clips', 'extended_history', 'priority_processing', 'export_data', 'premium_support'] }
    : { premium: false, monthlyLimit: 100, features: [] };

  return {
    clips: num(s.clips, 0, premiumStatus.premium ? 1e12 : 100, 0),
    inv: num(s.inv, 0, 1e9, 0),
    wire: num(s.wire, 0, 1e9, 10),
    funds: num(s.funds, 0, 1e9, 0),
    price: num(s.price, 0.5, 50, 5),
    autos: num(s.autos, 0, 1e6, 0),
    reach: num(s.reach, 1, 1e6, 1),
    // achievement unlock ids (whitelisted strings, capped)
    achv: Array.isArray(s.achv)
      ? s.achv.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 40).slice(0, 100)
      : [],
    // Premium metadata
    premium: premiumStatus.premium,
    monthlyLimit: premiumStatus.monthlyLimit,
    features: premiumStatus.features
  };
}

const server = http.createServer((req, res) => {
  const urlPath = new URL(req.url, 'http://x').pathname;

  // ---- persistence API -----------------------------------------------------
  if (urlPath === '/api/state' && req.method === 'GET') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    const isPremiumToken = token === 'B504755D8A834FC0A0DD5E50F302270A';
    const premiumStatus = isPremiumToken
      ? { premium: true, monthlyLimit: 1000, features: ['unlimited_clips', 'extended_history', 'priority_processing', 'export_data', 'premium_support'] }
      : { premium: false, monthlyLimit: 100, features: [] };
    return send(res, 200, { ...getState(), premium: premiumStatus.premium, monthlyLimit: premiumStatus.monthlyLimit });
  }
  if (urlPath === '/api/state' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try { return send(res, 200, { savedAt: saveState(sanitize(JSON.parse(raw || '{}'))) }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    });
    return;
  }
  if (urlPath === '/api/state' && req.method === 'DELETE') {
    clearState();
    return send(res, 200, { reset: true });
  }

  // ---- static files ----------------------------------------------------------
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<h1>404</h1>'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`paperclip-maximizer folding on http://localhost:${PORT}`);
});
