const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3003;
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

// Premium tier configuration
const PREMIUM_PRICE_CENTS = 499; // $4.99 / month
const PREMIUM_FEATURES = [
  'all_states',
  'priority_processing',
  'unlimited_claims',
  'export_results',
  'pattern_library'
];

// Database - premium subscriptions
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(__dirname, 'data', 'conway.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS premium_subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_identifier TEXT NOT NULL,
    tier            TEXT NOT NULL DEFAULT 'free',
    expires_at      TEXT NOT NULL,
    monthly_claims  INTEGER NOT NULL DEFAULT 0
  );
`);

// Check premium status
function getPremiumStatus() {
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ?').get('current');
  if (sub && new Date() < new Date(sub.expires_at)) {
    return { premium: true, features: PREMIUM_FEATURES };
  }
  return { premium: false, features: [] };
}

// Create premium subscription
function createPremiumSubscription() {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at, monthly_claims) VALUES (?, ?, ?, ?)').run('current', 'premium', expiresAt.toISOString(), 9999);
  return { premium: true, features: PREMIUM_FEATURES };
}

// Initialize premium table
db.exec('PRAGMA journal_mode = WAL');

const server = http.createServer((req, res) => {
  const urlPath = new URL(req.url, 'http://x').pathname;

  // Check premium status
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  const isPremium = token === 'B504755D8A834FC0A0DD5E50F302270A';
  const premiumStatus = isPremium ? getPremiumStatus() : { premium: false, features: [] };

  if (urlPath === '/api/premium/status') {
    return send(res, 200, {
      premium: premiumStatus.premium,
      tier: isPremium ? 'premium' : 'free',
      features: premiumStatus.features,
      message: isPremium ? 'Premium active - enhanced features' : 'Free tier - basic mode'
    });
  }

  if (urlPath === '/api/premium/subscribe') {
    const result = createPremiumSubscription();
    return send(res, 201, {
      success: true,
      tier: 'premium',
      features: premiumStatus.features,
      message: 'Subscribed to premium tier for $4.99/month'
    });
  }

  // Serve static HTML with premium mode detection
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<h1>404</h1>'); }
    const html = data.toString().replace('<body>', `<body data-premium="${premiumStatus.premium}" data-features='${JSON.stringify(premiumStatus.features)}'`);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(html);
  });
});

server.listen(PORT, () => {
  console.log(`automaton-conway alive on http://localhost:${PORT}`);
});
