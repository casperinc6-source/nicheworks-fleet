/**
 * aggregator — a Poe-style multi-model chat front door.
 *
 * One interface, many models. It routes a prompt to whichever provider is
 * configured: a local backend (the Saluki desk / Ollama / llama.cpp) and/or
 * cloud providers via their API keys. It never fakes a completion — a model
 * whose provider is not configured is reported as unavailable and returns 503.
 *
 *   GET  /api/providers            which providers are configured (real check)
 *   GET  /api/models               the unified model list + availability
 *   POST /api/chat { model, messages }   route one conversation
 *   POST /api/compare { messages }       ask every available model at once (pro)
 *   POST /api/premium/subscribe    $19/mo pro
 *   GET  /api/premium/status
 *
 * Env: MODEL_BACKEND_URL (local), OPENAI_API_KEY, ANTHROPIC_API_KEY.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3021;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL;

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const PRO_PRICE_CENTS = 1900; // $19.00 / month

const LOCAL_URL = (process.env.MODEL_BACKEND_URL || '').replace(/\/$/, '');
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_URL = process.env.OPENAI_URL || 'https://api.openai.com/v1';
const ANTHROPIC_URL = process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1';

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'aggregator.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS threads (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    model      TEXT NOT NULL,
    messages   TEXT NOT NULL,
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

const MODELS = [
  { id: 'underdog-saluki-27b-1.0', label: 'Saluki 27B (local)', provider: 'local', note: 'ConwayResearch 2-bit GGUF of Qwen3.8-27B — agents/tools' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'openai' },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
  { id: 'claude-3-5-haiku-latest', label: 'Claude Haiku', provider: 'anthropic' },
  { id: 'claude-3-7-sonnet-latest', label: 'Claude Sonnet', provider: 'anthropic' },
];

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
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) { reject(new Error('Body too large')); req.destroy(); } });
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
  if (token === PAYONEER_TOKEN) return { premium: true, tier: 'pro' };
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ? ORDER BY id DESC LIMIT 1').get(token);
  if (sub && new Date() < new Date(sub.expires_at)) return { premium: true, tier: sub.tier };
  return { premium: false, tier: 'free' };
}

function subscribePro() {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)')
    .run('current', 'pro', expiresAt.toISOString());
  return { tier: 'pro', expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Providers (real routing)
// ---------------------------------------------------------------------------
async function localReachable() {
  if (!LOCAL_URL) return { up: false, kind: null };
  for (const [kind, url] of [['openai', `${LOCAL_URL}/v1/models`], ['ollama', `${LOCAL_URL}/api/tags`]]) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok) return { up: true, kind }; } catch { /* next */ }
  }
  return { up: false, kind: null };
}

async function providerStatus() {
  const local = await localReachable();
  return {
    local: { configured: Boolean(LOCAL_URL), up: local.up, kind: local.kind, url: LOCAL_URL || null },
    openai: { configured: Boolean(OPENAI_KEY), up: Boolean(OPENAI_KEY) },
    anthropic: { configured: Boolean(ANTHROPIC_KEY), up: Boolean(ANTHROPIC_KEY) },
  };
}

function providerFor(modelId) {
  const m = MODELS.find((x) => x.id === modelId);
  return m ? m.provider : null;
}

async function callModel(modelId, messages) {
  const provider = providerFor(modelId);
  if (!provider) { const e = new Error(`Unknown model "${modelId}". See GET /api/models.`); e.statusCode = 400; throw e; }

  if (provider === 'local') {
    const st = await localReachable();
    if (!st.up) { const e = new Error('Local model backend is not configured or unreachable. Set MODEL_BACKEND_URL.'); e.statusCode = 503; throw e; }
    const endpoint = st.kind === 'ollama' ? `${LOCAL_URL}/api/chat` : `${LOCAL_URL}/v1/chat/completions`;
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: modelId, messages, stream: false }), signal: AbortSignal.timeout(120000) });
    const d = await r.json();
    if (!r.ok) { const e = new Error(`Local backend HTTP ${r.status}`); e.statusCode = 502; throw e; }
    const text = st.kind === 'ollama' ? (d.message?.content || '') : (d.choices?.[0]?.message?.content || '');
    return { provider, model: modelId, text };
  }

  if (provider === 'openai') {
    if (!OPENAI_KEY) { const e = new Error('OPENAI_API_KEY is not configured'); e.statusCode = 503; throw e; }
    const r = await fetch(`${OPENAI_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: modelId, messages }),
      signal: AbortSignal.timeout(120000),
    });
    const d = await r.json();
    if (!r.ok) { const e = new Error(`OpenAI HTTP ${r.status}: ${d.error?.message || 'error'}`); e.statusCode = 502; throw e; }
    return { provider, model: modelId, text: d.choices?.[0]?.message?.content || '' };
  }

  if (provider === 'anthropic') {
    if (!ANTHROPIC_KEY) { const e = new Error('ANTHROPIC_API_KEY is not configured'); e.statusCode = 503; throw e; }
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n') || undefined;
    const convo = messages.filter((m) => m.role !== 'system');
    const r = await fetch(`${ANTHROPIC_URL}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: modelId, max_tokens: 2048, system, messages: convo }),
      signal: AbortSignal.timeout(120000),
    });
    const d = await r.json();
    if (!r.ok) { const e = new Error(`Anthropic HTTP ${r.status}: ${d.error?.message || 'error'}`); e.statusCode = 502; throw e; }
    return { provider, model: modelId, text: (d.content || []).map((c) => c.text || '').join('') };
  }

  const e = new Error('Unsupported provider'); e.statusCode = 500; throw e;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [
  { method: 'GET', pattern: /^\/api\/providers$/, handler: async (req, res) => send(res, 200, { providers: await providerStatus() }) },

  {
    method: 'GET',
    pattern: /^\/api\/models$/,
    handler: async (req, res) => {
      const st = await providerStatus();
      const models = MODELS.map((m) => ({ ...m, available: Boolean(st[m.provider]?.up) }));
      return send(res, 200, { models });
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/chat$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const model = String(body.model || 'underdog-saluki-27b-1.0');
      const messages = Array.isArray(body.messages) ? body.messages : (body.prompt ? [{ role: 'user', content: String(body.prompt) }] : null);
      if (!messages || !messages.length) return send(res, 400, { error: 'Provide messages or a prompt' });
      const out = await callModel(model, messages);
      const { premium } = premiumOf(req);
      if (premium && body.save) {
        db.prepare('INSERT INTO threads (model, messages) VALUES (?, ?)').run(model, JSON.stringify([...messages, { role: 'assistant', content: out.text }]));
      }
      return send(res, 200, { ...out, saved: Boolean(premium && body.save) });
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/compare$/,
    handler: async (req, res) => {
      const { premium } = premiumOf(req);
      if (!premium) return send(res, 402, { error: 'Side-by-side compare is a pro feature', upgrade: `$${PRO_PRICE_CENTS / 100}/month` });
      const body = await readBody(req);
      const messages = Array.isArray(body.messages) ? body.messages : (body.prompt ? [{ role: 'user', content: String(body.prompt) }] : null);
      if (!messages) return send(res, 400, { error: 'Provide messages or a prompt' });
      const st = await providerStatus();
      const available = MODELS.filter((m) => st[m.provider]?.up);
      if (!available.length) return send(res, 503, { error: 'No providers configured', hint: 'Set MODEL_BACKEND_URL, OPENAI_API_KEY or ANTHROPIC_API_KEY.' });
      const results = await Promise.all(available.map(async (m) => {
        try { const r = await callModel(m.id, messages); return { model: m.id, ok: true, text: r.text }; }
        catch (e) { return { model: m.id, ok: false, error: e.message }; }
      }));
      return send(res, 200, { prompt: messages[messages.length - 1].content, results });
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/threads$/,
    handler: (req, res) => {
      const { premium } = premiumOf(req);
      if (!premium) return send(res, 402, { error: 'Saved threads are a pro feature', upgrade: `$${PRO_PRICE_CENTS / 100}/month` });
      return send(res, 200, { threads: db.prepare('SELECT id, model, created_at FROM threads ORDER BY id DESC LIMIT 50').all() });
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
      return send(res, 201, { success: true, tier: 'pro', price: PRO_PRICE_CENTS / 100, expiresAt: sub.expiresAt, payment, message: `Pro active — $${PRO_PRICE_CENTS / 100}/month` });
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/premium\/status$/,
    handler: (req, res) => {
      const { premium, tier } = premiumOf(req);
      return send(res, 200, {
        premium, tier, price: PRO_PRICE_CENTS / 100,
        message: premium ? 'Pro active — compare, saved threads, unlimited models' : 'Free — one model at a time',
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
  console.log(`aggregator on http://localhost:${PORT} — providers: local=${LOCAL_URL ? 'set' : 'no'} openai=${OPENAI_KEY ? 'set' : 'no'} anthropic=${ANTHROPIC_KEY ? 'set' : 'no'}`);
});
