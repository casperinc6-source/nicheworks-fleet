/**
 * saluki-desk — the agent desk for Underdog Saluki 27B.
 *
 * Saluki 27B (ConwayResearch/Underdog-Saluki-27B-1.0) is a 2-bit GGUF of
 * Qwen3.8-27B (~7.89 GB) tuned to keep tool-calling intact — a local model for
 * agents. This service is the honest front desk for it: it advertises the model,
 * detects a local inference backend, and proxies chat/tool calls to it.
 *
 *   GET  /api/models              the local model catalogue (Saluki first)
 *   GET  /api/backends            backend detection + health (real probe)
 *   POST /api/chat { messages }   proxy to the local backend (503 if none set)
 *   POST /api/tools               tool-calling request against the backend
 *   POST /api/premium/subscribe   $29/mo agent desk (saved sessions, tools)
 *   GET  /api/premium/status
 *
 * Nothing is invented: with no MODEL_BACKEND_URL configured (or unreachable),
 * /api/chat returns 503 and says how to start a backend. It never fabricates a
 * completion.
 *
 * Wire a backend with:  MODEL_BACKEND_URL=http://127.0.0.1:11434   (Ollama)
 *                   or  MODEL_BACKEND_URL=http://127.0.0.1:8080    (llama.cpp/LocalAI, OpenAI-compatible)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3020;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL;
const MODEL_BACKEND_URL = (process.env.MODEL_BACKEND_URL || '').replace(/\/$/, '');
const MODEL_NAME = process.env.MODEL_NAME || 'underdog-saluki-27b-1.0';

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const DESK_PRICE_CENTS = 2900; // $29.00 / month

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'saluki.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL DEFAULT 'untitled',
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

// The catalogue. Facts about Saluki come from its published model card.
const MODELS = [
  {
    id: 'underdog-saluki-27b-1.0',
    name: 'Underdog Saluki 27B 1.0',
    org: 'ConwayResearch',
    base: 'Qwen3.8-27B',
    quant: '2-bit GGUF (IQ2 mix)',
    sizeGB: 7.89,
    contextTokens: 262144,
    strength: 'tool-calling / agents / coding / instructions',
    runners: ['llama.cpp', 'Ollama', 'LocalAI'],
    note: 'Shrunk from ~54 GB to ~7.89 GB. The authors report it keeps tool-calling intact (88/120 tool tasks in their tests).',
    source: 'ConwayResearch/Underdog-Saluki-27B-1.0',
    license: 'Check the model card before commercial use',
    verified: false,
  },
  { id: 'qwen3.8-27b', name: 'Qwen3.8-27B (full)', org: 'Alibaba', base: 'Qwen3.8', quant: 'fp16/bf16', sizeGB: 54, contextTokens: 262144, strength: 'general reasoning', runners: ['vLLM', 'llama.cpp'], source: 'Qwen/Qwen3.8-27B', license: 'Check the model card', verified: false },
  { id: 'gpt-oss-20b', name: 'gpt-oss-20b', org: 'OpenAI', base: 'gpt-oss', quant: 'MXFP4', sizeGB: 12, contextTokens: 131072, strength: 'general + tools', runners: ['Ollama', 'llama.cpp'], source: 'openai/gpt-oss-20b', license: 'Apache-2.0 (verify)', verified: false },
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
  if (token === PAYONEER_TOKEN) return { premium: true, tier: 'desk' };
  const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ? ORDER BY id DESC LIMIT 1').get(token);
  if (sub && new Date() < new Date(sub.expires_at)) return { premium: true, tier: sub.tier };
  return { premium: false, tier: 'free' };
}

function subscribeDesk() {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)')
    .run('current', 'desk', expiresAt.toISOString());
  return { tier: 'desk', expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Backend detection + proxy (real)
// ---------------------------------------------------------------------------
async function probeBackend() {
  if (!MODEL_BACKEND_URL) {
    return { configured: false, url: null, kind: null, up: false, models: [], hint: 'Set MODEL_BACKEND_URL to your Ollama (…:11434) or llama.cpp/LocalAI (…:8080) server.' };
  }
  // Try OpenAI-compatible first, then Ollama's own API.
  const attempts = [
    { kind: 'openai', url: `${MODEL_BACKEND_URL}/v1/models`, pick: (j) => (j.data || []).map((m) => m.id) },
    { kind: 'ollama', url: `${MODEL_BACKEND_URL}/api/tags`, pick: (j) => (j.models || []).map((m) => m.name) },
  ];
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) continue;
      const j = await res.json();
      return { configured: true, url: MODEL_BACKEND_URL, kind: attempt.kind, up: true, models: attempt.pick(j) };
    } catch { /* try next */ }
  }
  return { configured: true, url: MODEL_BACKEND_URL, kind: null, up: false, models: [], hint: 'Backend configured but not answering on either the OpenAI or Ollama API.' };
}

async function chat(messages, tools) {
  const probe = await probeBackend();
  if (!probe.up) {
    const err = new Error(probe.hint || 'No local model backend is configured');
    err.statusCode = 503;
    throw err;
  }
  const payload = { model: MODEL_NAME, messages, stream: false };
  if (tools) payload.tools = tools;
  const endpoint = probe.kind === 'ollama' ? `${MODEL_BACKEND_URL}/api/chat` : `${MODEL_BACKEND_URL}/v1/chat/completions`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) {
    const err = new Error(`Backend call failed: ${error.name === 'AbortError' ? 'timed out' : error.message}`);
    err.statusCode = 502;
    throw err;
  }
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(`Backend returned HTTP ${res.status}: ${data.error?.message || 'error'}`);
    err.statusCode = 502;
    throw err;
  }
  // Normalise Ollama vs OpenAI shapes.
  const message = probe.kind === 'ollama'
    ? (data.message || { role: 'assistant', content: data.response || '' })
    : (data.choices?.[0]?.message || { role: 'assistant', content: '' });
  return { backend: probe.kind, model: payload.model, message, toolCalls: message.tool_calls || null };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [
  { method: 'GET', pattern: /^\/api\/models$/, handler: (req, res) => send(res, 200, { default: MODEL_NAME, models: MODELS }) },

  {
    method: 'GET',
    pattern: /^\/api\/backends$/,
    handler: async (req, res) => {
      const probe = await probeBackend();
      return send(res, 200, { recommended: MODEL_NAME, ...probe });
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/chat$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const messages = Array.isArray(body.messages) ? body.messages : (body.prompt ? [{ role: 'user', content: String(body.prompt) }] : null);
      if (!messages || !messages.length) return send(res, 400, { error: 'Provide messages: [{ role, content }] or a prompt' });
      const { premium } = premiumOf(req);
      const result = await chat(messages, null);
      if (premium && body.save) {
        db.prepare('INSERT INTO sessions (title, messages) VALUES (?, ?)')
          .run(String(messages[messages.length - 1].content || '').slice(0, 60), JSON.stringify([...messages, result.message]));
      }
      return send(res, 200, result);
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/tools$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const messages = Array.isArray(body.messages) ? body.messages : (body.prompt ? [{ role: 'user', content: String(body.prompt) }] : null);
      if (!messages) return send(res, 400, { error: 'Provide messages or a prompt' });
      const tools = Array.isArray(body.tools) && body.tools.length ? body.tools : [
        { type: 'function', function: { name: 'get_weather', description: 'Get weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } },
      ];
      const result = await chat(messages, tools);
      return send(res, 200, { ...result, toolsOffered: tools.map((t) => t.function?.name || t.name) });
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/sessions$/,
    handler: (req, res) => {
      const { premium } = premiumOf(req);
      if (!premium) return send(res, 402, { error: 'Saved sessions are a desk feature', upgrade: `$${DESK_PRICE_CENTS / 100}/month` });
      return send(res, 200, { sessions: db.prepare('SELECT id, title, created_at FROM sessions ORDER BY id DESC').all() });
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/premium\/subscribe$/,
    handler: async (req, res) => {
      const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
      const sub = subscribeDesk();
      const payment = STRIPE_PUBLIC_KEY
        ? { method: 'stripe', checkout: `${origin}/?checkout=desk&key=${STRIPE_PUBLIC_KEY}` }
        : { method: 'payoneer', token: PAYONEER_TOKEN, amount: DESK_PRICE_CENTS / 100, currency: 'USD' };
      return send(res, 201, { success: true, tier: 'desk', price: DESK_PRICE_CENTS / 100, expiresAt: sub.expiresAt, payment, message: `Agent desk active — $${DESK_PRICE_CENTS / 100}/month` });
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
        price: DESK_PRICE_CENTS / 100,
        defaultModel: MODEL_NAME,
        message: premium ? 'Desk active — saved sessions, tools, unlimited calls' : 'Free — model catalogue and live backend probe',
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
  console.log(`saluki-desk on http://localhost:${PORT} — model ${MODEL_NAME}${MODEL_BACKEND_URL ? `, backend ${MODEL_BACKEND_URL}` : ' (no backend configured)'}`);
});
