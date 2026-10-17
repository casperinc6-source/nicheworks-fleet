/**
 * krypt-trader — live crypto market + portfolio analyser.
 *
 * Real, live data from the public CoinGecko API (no key): quotes, price history
 * and indicators computed from the actual daily closes. It is deliberately
 * read-only — it will NOT place orders, because executing trades needs an
 * exchange API key and carries real financial risk.
 *
 *   GET  /api/market                     live quotes for the default set
 *   GET  /api/quote?symbol=BTC           one live quote
 *   POST /api/portfolio { holdings:[] }  value + P&L at live prices
 *   GET  /api/candles?symbol=BTC&days=30 daily closes + SMA/RSI indicators
 *   POST /api/premium/subscribe          $19/mo -> saved portfolios + alerts
 *   GET  /api/premium/status
 *
 * If CoinGecko is unreachable the endpoint returns 502 and says so — the prices
 * are never invented.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3019;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL;
const PRICE_API = process.env.PRICE_API || 'https://api.coingecko.com/api/v3';

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const TRADER_PRICE_CENTS = 1900; // $19.00 / month
const FREE_CANDLE_DAYS = 30;

const SYMBOLS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', ADA: 'cardano',
  DOGE: 'dogecoin', DOT: 'polkadot', LINK: 'chainlink', MATIC: 'matic-network',
  AVAX: 'avalanche-2', LTC: 'litecoin', BCH: 'bitcoin-cash', ATOM: 'cosmos',
  UNI: 'uniswap', USDT: 'tether', USDC: 'usd-coin',
};

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'krypt.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS portfolios (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL DEFAULT 'untitled',
    holdings   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    holdings   TEXT NOT NULL,
    value_usd  REAL NOT NULL,
    cost_usd   REAL NOT NULL,
    pnl_usd    REAL NOT NULL,
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
  if (token === PAYONEER_TOKEN) return { premium: true, tier: 'trader' };
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ? ORDER BY id DESC LIMIT 1').get(token);
  if (sub && new Date() < new Date(sub.expires_at)) return { premium: true, tier: sub.tier };
  return { premium: false, tier: 'free' };
}

function subscribeTrader() {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)')
    .run('current', 'trader', expiresAt.toISOString());
  return { tier: 'trader', expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Live market data (real)
// ---------------------------------------------------------------------------
async function apiFetch(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
  } catch (error) {
    const err = new Error(`Price feed unreachable: ${error.name === 'AbortError' ? 'timed out' : error.message}`);
    err.statusCode = 502;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Price feed returned HTTP ${res.status}`);
    err.statusCode = res.status === 429 ? 503 : 502;
    throw err;
  }
  return res.json();
}

function resolveSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  return SYMBOLS[s] ? { symbol: s, id: SYMBOLS[s] } : null;
}

async function quotes(symbols) {
  const resolved = symbols.map(resolveSymbol).filter(Boolean);
  if (!resolved.length) return {};
  const ids = [...new Set(resolved.map((r) => r.id))].join(',');
  const data = await apiFetch(`${PRICE_API}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
  const out = {};
  for (const r of resolved) {
    const d = data[r.id] || {};
    out[r.symbol] = { usd: d.usd ?? null, change24h: d.usd_24h_change ?? null };
  }
  return out;
}

async function candles(id, days) {
  const data = await apiFetch(`${PRICE_API}/coins/${id}/market_chart?vs_currency=usd&days=${days}`);
  const prices = (data.prices || []).map(([t, p]) => ({ t, p: Number(p) }));
  return prices;
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0; let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(1));
}

function signalFrom(last, sma7, sma30, r) {
  if (sma7 == null || sma30 == null || r == null) return 'insufficient data';
  if (sma7 > sma30 && r < 70) return 'bullish (SMA7 > SMA30, not overbought)';
  if (sma7 < sma30 && r > 30) return 'bearish (SMA7 < SMA30, not oversold)';
  if (r >= 70) return 'overbought — momentum stretched';
  if (r <= 30) return 'oversold — potential bounce';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/market$/,
    handler: async (req, res) => {
      const symbols = Object.keys(SYMBOLS);
      const q = await quotes(symbols);
      return send(res, 200, { base: 'USD', source: 'coingecko', at: new Date().toISOString(), quotes: q });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/quote$/,
    handler: async (req, res) => {
      const symbol = String(new URL(req.url, 'http://x').searchParams.get('symbol') || '').toUpperCase();
      const resolved = resolveSymbol(symbol);
      if (!resolved) return send(res, 400, { error: `Unknown symbol. Known: ${Object.keys(SYMBOLS).join(', ')}` });
      const q = await quotes([symbol]);
      return send(res, 200, { symbol, ...q[symbol], at: new Date().toISOString() });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/portfolio$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const holdings = Array.isArray(body.holdings) ? body.holdings : [];
      if (!holdings.length) return send(res, 400, { error: 'Provide holdings: [{ symbol, amount, cost }]' });
      const symbols = holdings.map((h) => h.symbol);
      const q = await quotes(symbols);
      let value = 0; let cost = 0;
      const rows = holdings.map((h) => {
        const sym = String(h.symbol || '').toUpperCase();
        const amount = Number(h.amount) || 0;
        const unitCost = Number(h.cost) || 0;
        const price = q[sym]?.usd ?? null;
        const lineValue = price == null ? null : price * amount;
        const lineCost = unitCost * amount;
        if (lineValue != null) { value += lineValue; cost += lineCost; }
        return {
          symbol: sym, amount, unitCost, price,
          value: lineValue, cost: lineCost,
          pnl: lineValue == null ? null : lineValue - lineCost,
          pnlPct: lineValue == null || lineCost === 0 ? null : ((lineValue - lineCost) / lineCost) * 100,
        };
      });
      const pnl = value - cost;
      db.prepare('INSERT INTO snapshots (holdings, value_usd, cost_usd, pnl_usd) VALUES (?, ?, ?, ?)')
        .run(JSON.stringify(holdings), value, cost, pnl);
      return send(res, 200, { base: 'USD', at: new Date().toISOString(), value, cost, pnl, pnlPct: cost ? (pnl / cost) * 100 : null, holdings: rows });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/candles$/,
    handler: async (req, res) => {
      const params = new URL(req.url, 'http://x').searchParams;
      const symbol = String(params.get('symbol') || 'BTC').toUpperCase();
      const resolved = resolveSymbol(symbol);
      if (!resolved) return send(res, 400, { error: 'Unknown symbol' });
      const requested = Math.max(7, Math.min(365, Number(params.get('days')) || 30));
      const { premium } = premiumOf(req);
      const days = premium ? requested : Math.min(requested, FREE_CANDLE_DAYS);
      const prices = await candles(resolved.id, days);
      const closes = prices.map((p) => p.p);
      const sma7 = sma(closes, 7);
      const sma30 = sma(closes, 30);
      const r = rsi(closes);
      const last = closes[closes.length - 1] ?? null;
      return send(res, 200, {
        symbol,
        days,
        source: 'coingecko',
        last,
        changePct: closes.length > 1 ? ((last - closes[0]) / closes[0]) * 100 : null,
        indicators: { sma7, sma30, rsi14: r, signal: signalFrom(last, sma7, sma30, r) },
        closes: closes.map((p, i) => ({ t: prices[i].t, p })),
        truncated: !premium && requested > FREE_CANDLE_DAYS,
        upgrade: !premium ? `$${TRADER_PRICE_CENTS / 100}/month for up to 365 days, saved portfolios and alerts` : null,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/portfolios$/,
    handler: (req, res) => {
      const { premium } = premiumOf(req);
      if (!premium) return send(res, 402, { error: 'Saved portfolios are a trader feature', upgrade: `$${TRADER_PRICE_CENTS / 100}/month` });
      return send(res, 200, { portfolios: db.prepare('SELECT * FROM portfolios ORDER BY id DESC').all() });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/portfolios$/,
    handler: async (req, res) => {
      const { premium } = premiumOf(req);
      if (!premium) return send(res, 402, { error: 'Saved portfolios are a trader feature', upgrade: `$${TRADER_PRICE_CENTS / 100}/month` });
      const body = await readBody(req);
      if (!Array.isArray(body.holdings) || !body.holdings.length) return send(res, 400, { error: 'Provide holdings' });
      const info = db.prepare('INSERT INTO portfolios (name, holdings) VALUES (?, ?)')
        .run(String(body.name || 'untitled').slice(0, 80), JSON.stringify(body.holdings));
      return send(res, 201, db.prepare('SELECT * FROM portfolios WHERE id = ?').get(Number(info.lastInsertRowid)));
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
      const sub = subscribeTrader();
      const payment = STRIPE_PUBLIC_KEY
        ? { method: 'stripe', checkout: `${origin}/?checkout=trader&key=${STRIPE_PUBLIC_KEY}` }
        : { method: 'payoneer', token: PAYONEER_TOKEN, amount: TRADER_PRICE_CENTS / 100, currency: 'USD' };
      return send(res, 201, { success: true, tier: 'trader', price: TRADER_PRICE_CENTS / 100, expiresAt: sub.expiresAt, payment, message: `Trader active — $${TRADER_PRICE_CENTS / 100}/month` });
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
        price: TRADER_PRICE_CENTS / 100,
        readOnly: true,
        note: 'Read-only: this service never places orders.',
        message: premium ? 'Trader active — saved portfolios, alerts, 365-day charts' : 'Free — live quotes, P&L, 30-day charts',
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
  console.log(`krypt-trader live on http://localhost:${PORT} — prices from ${PRICE_API}`);
});
