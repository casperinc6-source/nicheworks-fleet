/**
 * exelo — deploy an AI employee to a local business.
 *
 * The pitch is the product: point it at a local business's own website, read
 * what is (and is not) there, price the revenue that gap costs them, hand back
 * a proposal, and configure the receptionist that closes it.
 *
 *   POST /api/scan { url }        read a public site, save the lead, price the leaks
 *   GET  /api/leads               every scanned business, newest first
 *   GET  /api/leads/:id           one lead, with findings + proposal
 *   POST /api/agents { lead_id }  build the receptionist kit for a lead
 *   GET  /api/agents/:id          the kit (prompt, intents, tools, webhook contract)
 *   GET  /api/premium/status
 *   POST /api/premium/subscribe   $199/mo — unlimited scans + proposals
 *
 * HONESTY RULES (load-bearing, not decoration):
 *   - Every dollar figure is an ESTIMATE from observable page signals. The
 *     assumptions behind each one are returned with it and shown in the UI;
 *     nothing here claims to know a business's real revenue.
 *   - The scan only fetches public http(s) pages. Loopback and private ranges
 *     are refused, so this cannot be used as an SSRF proxy into the fleet.
 *     EXELO_ALLOW_PRIVATE=1 is a test-only escape hatch (see tests).
 *   - The agent kit is a kit. No calls are placed and none are simulated; a
 *     real deployment needs a telephony provider and a model endpoint.
 */
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3024;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

const PAYONEER_TOKEN = 'B504755D8A834FC0A0DD5E50F302270A';
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const DESK_PRICE_CENTS = 19900; // $199.00 / month
const SETUP_CENTS = 49900;      // $499.00 one-time deployment
const ALLOW_PRIVATE = process.env.EXELO_ALLOW_PRIVATE === '1';

const MAX_BYTES = 750 * 1024;
const FETCH_TIMEOUT_MS = 8000;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'exelo.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS leads (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    url            TEXT NOT NULL,
    host           TEXT NOT NULL,
    business       TEXT,
    findings       TEXT NOT NULL,
    leaks          TEXT NOT NULL,
    monthly_cents  INTEGER NOT NULL,
    total_cents    INTEGER NOT NULL,
    fetched_ms     INTEGER NOT NULL,
    bytes          INTEGER NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS agents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    kit        TEXT NOT NULL,
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

function readBody(req, limit = 1e5) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > limit) { reject(new Error('Body too large')); req.destroy(); } });
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

function tokenOf(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

function isPremium(req) {
  return tokenOf(req) === PAYONEER_TOKEN;
}

// ---- SSRF guard -------------------------------------------------------------
// A public-website reader must not become a door into the host. Refuse
// anything that is not http(s) to a hostname resolving to a public address.
function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return false;
  }
  if (family === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return false;
  }
  return true; // not an IP at all — refuse rather than guess
}

async function assertPublicTarget(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { throw Object.assign(new Error('Not a valid URL'), { status: 400 }); }
  if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('Only http and https are supported'), { status: 400 });
  if (url.username || url.password) throw Object.assign(new Error('Credentials in the URL are refused'), { status: 400 });
  if (ALLOW_PRIVATE) return url;
  let addrs;
  try { addrs = await dns.lookup(url.hostname, { all: true }); }
  catch { throw Object.assign(new Error(`Could not resolve ${url.hostname}`), { status: 400 }); }
  if (!addrs.length) throw Object.assign(new Error(`Could not resolve ${url.hostname}`), { status: 400 });
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) throw Object.assign(new Error(`${url.hostname} resolves to a private address (${address}) — refused`), { status: 403 });
  }
  return url;
}

// ---- page reader ------------------------------------------------------------
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = client.get(url, {
      headers: { 'user-agent': 'exelo-scan/1.0 (+local revenue audit)', accept: 'text/html,*/*' },
      timeout: FETCH_TIMEOUT_MS,
    }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url); } catch { return reject(Object.assign(new Error('Bad redirect'), { status: 502 })); }
        if (!/^https?:$/.test(next.protocol)) return reject(Object.assign(new Error('Redirect left http(s)'), { status: 502 }));
        return resolve(assertPublicTarget(next.toString()).then(fetchPage));
      }
      if (status >= 400) {
        res.resume();
        return reject(Object.assign(new Error(`Site returned HTTP ${status}`), { status: 502 }));
      }
      let raw = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) { req.destroy(); return reject(Object.assign(new Error('Page larger than 750 KB'), { status: 502 })); }
        raw += chunk;
      });
      res.on('end', () => resolve({
        status,
        html: raw,
        bytes,
        ms: Date.now() - started,
        finalUrl: url.toString(),
        contentType: String(res.headers['content-type'] || ''),
      }));
    });
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error('Site timed out'), { status: 504 })); });
    req.on('error', (err) => reject(Object.assign(new Error(`Could not reach site: ${err.message}`), { status: 502 })));
  });
}

// ---- signal extraction ------------------------------------------------------
const BOOKING_HOSTS = /(calendly|booksy|acuityscheduling|squareup\.com\/appointments|schedulicity|vagaro|housecallpro|servicetitan|opendental|zocdoc|mindbodyonline|getjobber|jobber)/i;

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extract(html, finalUrl) {
  const text = textOf(html);
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '';
  const phone = (html.match(/href=["']tel:([+0-9().\-\s]{7,})["']/i) || [])[1]
    || (text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/) || [])[0]
    || null;
  const links = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const bookingLink = links.find((l) => BOOKING_HOSTS.test(l)) || null;
  const hasForm = /<form[\s>]/i.test(html);
  const hasHours = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b[\s\S]{0,24}\d{1,2}(:\d{2})?\s*(am|pm|-|–|to)/i.test(text)
    || /\b(open|hours)\b[\s\S]{0,40}\d{1,2}\s*(am|pm|:\d{2})/i.test(text)
    || /\b24\/7\b/.test(text);
  const hasAddress = /\b\d{2,6}\s+[A-Za-z0-9.\- ]{3,40}\s+(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|suite|ste)\b/i.test(text);
  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const hasReviews = /\b(testimonial|reviews?|rated|google review|stars?)\b/i.test(text);
  const hasMap = /(google\.com\/maps|maps\.google|goo\.gl\/maps|mapbox|openstreetmap)/i.test(html);
  const hasChat = /(intercom|drift\.com|tidio|crisp\.chat|tawk\.to|livechat|hubspot.*chat|zendesk.*widget)/i.test(html);
  const hasSchema = /application\/ld\+json/i.test(html);
  const hasAnalytics = /(googletagmanager|gtag\(|analytics\.js|plausible\.io|posthog|hotjar)/i.test(html);
  const email = (html.match(/mailto:([^"'?>\s]+)/i) || [])[1] || null;

  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  return {
    title: clean(titleTag) || null,
    headline: clean(h1) || null,
    phone: phone ? clean(phone) : null,
    email: email ? decodeURIComponent(email) : null,
    bookingLink,
    hasForm, hasHours, hasAddress, hasViewport, hasReviews, hasMap, hasChat, hasSchema, hasAnalytics,
    textChars: text.length,
    isHttps: finalUrl.startsWith('https:'),
  };
}

// ---- leak pricing -----------------------------------------------------------
// Every line states its assumption. These are published, editable numbers, not
// a black box; the UI renders them next to the dollar figure.
const ASSUMPTIONS = {
  booking: '40 booking-intent contacts/mo, 30% lost with no online scheduling, $85 average ticket',
  ai_voice: '35 inbound calls/mo outside staffed hours, 60% missed without an answering agent, $85 average ticket',
  hours: '12 after-hours calls/mo asking hours or availability, $85 average ticket',
  mobile: '55% of local search traffic is mobile; a desktop-only page loses 20% of them',
  speed: '1s added load time costs ~7% of conversions on 25 form starts/mo at $85',
  contact: 'No phone or form: 20 inbound intents/mo with no path to the business, $85 average ticket',
  trust: 'No reviews or testimonials shown: 10% of 60 monthly visitors bounce at the trust step',
  analytics: 'Cannot see what converts yet — priced at $0 until tracking exists (real cost, unmeasured)',
};

function priceLeaks(sig, fetched, finalUrl) {
  const leaks = [];
  const add = (id, label, severity, cents, evidence, assumption) =>
    leaks.push({ id, label, severity, monthly_cents: cents, evidence, assumption });

  if (!sig.bookingLink) {
    add('booking', 'No online booking', 'high', Math.round(40 * 0.30 * 85 * 100),
      'No Calendly/Booksy/Acuity/Jobber-style link found in the page',
      ASSUMPTIONS.booking);
  }
  if (!sig.hasHours) {
    add('hours', 'Opening hours not published', 'medium', Math.round(12 * 0.25 * 85 * 100),
      'No weekday/time pattern found in the page text', ASSUMPTIONS.hours);
  }
  if (!sig.phone && !sig.hasForm) {
    add('contact', 'No way to contact from the page', 'high', Math.round(20 * 0.5 * 85 * 100),
      'No tel: link, no phone number in text, no <form>', ASSUMPTIONS.contact);
  }
  if (!sig.hasViewport) {
    add('mobile', 'Page is not mobile-ready', 'high', Math.round(0.55 * 60 * 0.20 * 85 * 100),
      'No <meta name="viewport"> — the page pins to desktop width', ASSUMPTIONS.mobile);
  }
  if (fetched.ms > 1200 || fetched.bytes > 400 * 1024) {
    add('speed', 'Slow / heavy page', 'medium', Math.round(25 * 0.07 * 85 * 100),
      `${fetched.ms} ms to first byte-ish, ${(fetched.bytes / 1024).toFixed(0)} KB of HTML`, ASSUMPTIONS.speed);
  }
  if (!sig.hasReviews) {
    add('trust', 'No reviews or testimonials shown', 'low', Math.round(60 * 0.10 * 85 * 100),
      'No testimonial/review/rating language found', ASSUMPTIONS.trust);
  }
  if (!sig.hasAnalytics) {
    add('analytics', 'No analytics installed', 'low', 0,
      'No gtag/GTM/Plausible/PostHog/Hotjar snippet found', ASSUMPTIONS.analytics);
  }
  if (!sig.isHttps) {
    add('https', 'Served over plain HTTP', 'medium', 0,
      `Final URL is ${finalUrl}`, 'Browsers mark the site "Not secure"; treated as trust damage, not priced');
  }
  if (!sig.hasSchema) {
    add('schema', 'No LocalBusiness structured data', 'low', 0,
      'No application/ld+json block found', 'Keeps the business out of rich results; growth cost, not priced');
  }
  if (!sig.hasChat) {
    add('chat', 'No live chat / answering agent', 'medium', Math.round(35 * 0.60 * 85 * 100),
      'No chat widget detected', ASSUMPTIONS.ai_voice);
  }

  const monthly = leaks.reduce((sum, l) => sum + l.monthly_cents, 0);
  return {
    leaks,
    monthly_cents: monthly,
    // Two of these lines are the same phone traffic seen through different
    // lenses, so the sum is deliberately an upper bound, not a forecast.
    basis: 'Sum of per-gap estimates. The booking and after-hours/answering lines describe overlapping caller traffic, so treat the total as an upper bound rather than a forecast.',
  };
}

// ---- receptionist kit -------------------------------------------------------
function buildKit(lead, sig, opts = {}) {
  const business = lead.business || lead.host;
  const hours = typeof opts.hours === 'string' && opts.hours.trim() ? opts.hours.trim() : 'Mon–Fri 9:00–17:00, closed weekends';
  const transferTo = typeof opts.transfer_to === 'string' && opts.transfer_to.trim() ? opts.transfer_to.trim() : (sig.phone || 'the owner’s mobile');
  const services = Array.isArray(opts.services) && opts.services.length
    ? opts.services.filter((s) => typeof s === 'string' && s.length <= 80).slice(0, 12)
    : ['the service they called about'];

  const systemPrompt = [
    `You are the receptionist for ${business}${lead.host ? ` (${lead.host})` : ''}.`,
    `You answer the phone like a calm, competent front-desk person. You are not a chatbot and you never mention being an AI unless asked directly.`,
    ``,
    `HOURS: ${hours}.`,
    `BOOKINGS: take the caller's name, phone, service, and preferred window, then read it back once to confirm. Never invent availability.`,
    `SERVICES: ${services.join('; ')}. If the caller asks about anything outside this list, say you will have the owner confirm.`,
    `PRICING: never quote a price for work you cannot confirm. Say "${business} will confirm the price before anything is scheduled."`,
    `URGENCY: if the caller is in danger, tell them to hang up and call 911.`,
    `ESCALATE to ${transferTo} for: complaints, refunds, legal questions, anything about an existing job that has gone wrong, or any request to speak to a person.`,
    `Every call ends with a capture: name, number, reason, and the next action. If a required detail is missing, ask exactly once, then continue.`,
    `Keep replies to one or two short spoken sentences. No lists, no markdown, no emoji.`,
  ].join('\n');

  return {
    business,
    host: lead.host,
    // Stated plainly so nobody mistakes the kit for a running phone line.
    status: 'kit-only',
    calls_placed: 0,
    note: 'Nothing here places or simulates a call. Deploying this needs a telephony provider (number + media stream) and a model endpoint; until both are configured the agent does not answer.',
    model_suggestion: 'any tool-calling model — the local Saluki 27B desk (/saluki) is the cheapest fit',
    system_prompt: systemPrompt,
    greeting: `Thanks for calling ${business}. How can I help?`,
    intents: [
      { name: 'book_appointment', capture: ['name', 'phone', 'service', 'window'], tool: 'create_booking' },
      { name: 'hours_and_location', answer_from: ['hours', 'address'] },
      { name: 'pricing', policy: 'defer', say: 'The owner will confirm the price before anything is scheduled.' },
      { name: 'existing_job', policy: 'transfer' },
      { name: 'message_for_owner', tool: 'take_message' },
      { name: 'transfer_to_human', tool: 'transfer_call', to: transferTo },
    ],
    tools: [
      { name: 'create_booking', method: 'POST', path: '/api/bookings', required: ['name', 'phone', 'service', 'window'] },
      { name: 'take_message', method: 'POST', path: '/api/messages', required: ['name', 'phone', 'reason'] },
      { name: 'transfer_call', method: 'POST', path: '/api/transfer', required: ['reason'] },
    ],
    webhook_contract: {
      endpoint: 'POST /api/voice/turn',
      request: { call_id: 'string', from: 'string', transcript_turn: 'string', history: 'array' },
      response: { say: 'string', tool: 'object|null' },
      note: 'Your telephony provider posts a turn here; the desk answers with what to say plus an optional tool call.',
    },
    compliance: [
      'Announce recording if the call is recorded (two-party-consent states).',
      'Do not give medical, legal, or financial advice — route to a human.',
      'Do not invent availability, prices, or guarantees.',
    ],
    lead_url: lead.url,
    monthly_cents: DESK_PRICE_CENTS,
    setup_cents: SETUP_CENTS,
  };
}

// ---- HTTP -------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = new URL(req.url, 'http://x').pathname; }
  catch { return send(res, 400, { error: 'Bad request URL' }); }
  const premium = isPremium(req);

  try {
    if (urlPath === '/api/scan' && req.method === 'POST') {
      const body = await readBody(req);
      const target = await assertPublicTarget(body.url);
      const page = await fetchPage(target);
      const sig = extract(page.html, page.finalUrl);
      const business = (body.business && String(body.business).slice(0, 120)) || sig.title || target.hostname;
      const priced = priceLeaks(sig, page, page.finalUrl);
      const info = db.prepare(
        `INSERT INTO leads (url, host, business, findings, leaks, monthly_cents, total_cents, fetched_ms, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        page.finalUrl, target.hostname, business,
        JSON.stringify(sig), JSON.stringify(priced.leaks),
        priced.monthly_cents, priced.monthly_cents * 12, page.ms, page.bytes,
      );
      const id = Number(info.lastInsertRowid);
      return send(res, 201, {
        id,
        url: page.finalUrl,
        business,
        fetched_ms: page.ms,
        bytes: page.bytes,
        signals: sig,
        leaks: priced.leaks,
        estimate: {
          monthly_cents: priced.monthly_cents,
          annual_cents: priced.monthly_cents * 12,
          basis: priced.basis,
          disclaimer: 'Estimate from page signals and the stated assumptions — not a measurement of this business’s revenue.',
        },
        proposal: {
          setup_cents: SETUP_CENTS,
          monthly_cents: DESK_PRICE_CENTS,
          premium: premium,
          next: `POST /api/agents {"lead_id": ${id}} to build the receptionist`,
        },
      });
    }

    if (urlPath === '/api/leads' && req.method === 'GET') {
      const rows = db.prepare('SELECT id, url, host, business, monthly_cents, total_cents, created_at FROM leads ORDER BY id DESC LIMIT 50').all();
      return send(res, 200, { count: rows.length, leads: rows });
    }

    const leadMatch = urlPath.match(/^\/api\/leads\/(\d+)$/);
    if (leadMatch && req.method === 'GET') {
      const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadMatch[1]));
      if (!row) return send(res, 404, { error: 'No such lead' });
      return send(res, 200, {
        ...row,
        findings: JSON.parse(row.findings),
        leaks: JSON.parse(row.leaks),
        estimate: {
          monthly_cents: row.monthly_cents,
          annual_cents: row.total_cents,
          basis: 'Sum of per-gap estimates; overlapping caller traffic makes this an upper bound.',
          disclaimer: 'Estimate from page signals and stated assumptions — not a measurement of revenue.',
        },
      });
    }

    if (urlPath === '/api/agents' && req.method === 'POST') {
      const body = await readBody(req);
      const leadId = Number(body.lead_id);
      if (!Number.isInteger(leadId) || leadId < 1) return send(res, 400, { error: 'lead_id is required' });
      const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
      if (!row) return send(res, 404, { error: 'No such lead — scan the site first' });
      const sig = JSON.parse(row.findings);
      const lead = { url: row.url, host: row.host, business: row.business };
      const kit = buildKit(lead, sig, body);
      const name = (body.name && String(body.name).slice(0, 80)) || `${row.business} receptionist`;
      const info = db.prepare('INSERT INTO agents (lead_id, name, kit) VALUES (?, ?, ?)').run(leadId, name, JSON.stringify(kit));
      return send(res, 201, { id: Number(info.lastInsertRowid), lead_id: leadId, name, kit });
    }

    const agentMatch = urlPath.match(/^\/api\/agents\/(\d+)$/);
    if (agentMatch && req.method === 'GET') {
      const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(agentMatch[1]));
      if (!row) return send(res, 404, { error: 'No such agent' });
      return send(res, 200, { ...row, kit: JSON.parse(row.kit) });
    }

    if (urlPath === '/api/agents' && req.method === 'GET') {
      const rows = db.prepare('SELECT id, lead_id, name, created_at FROM agents ORDER BY id DESC LIMIT 50').all();
      return send(res, 200, { count: rows.length, agents: rows });
    }

    if (urlPath === '/api/premium/status') {
      const sub = db.prepare('SELECT * FROM premium_subscriptions WHERE user_identifier = ?').get('current');
      const active = Boolean(sub && new Date() < new Date(sub.expires_at));
      return send(res, 200, {
        premium: premium && active,
        tier: premium && active ? 'desk' : 'free',
        price_cents: DESK_PRICE_CENTS,
        setup_cents: SETUP_CENTS,
        payments: { provider: STRIPE_PUBLIC_KEY ? 'stripe' : 'payoneer', publishable_key: STRIPE_PUBLIC_KEY || null },
        features: premium && active ? ['unlimited_scans', 'agent_kits', 'proposal_pdf', 'call_transcripts'] : [],
      });
    }

    if (urlPath === '/api/premium/subscribe' && req.method === 'POST') {
      if (!premium) return send(res, 402, { error: 'A desk token is required', hint: 'Authorization: Bearer <token>' });
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO premium_subscriptions (user_identifier, tier, expires_at) VALUES (?, ?, ?)').run('current', 'desk', expiresAt);
      return send(res, 201, { success: true, tier: 'desk', expires_at: expiresAt, monthly_cents: DESK_PRICE_CENTS, setup_cents: SETUP_CENTS });
    }

    if (urlPath === '/api/voice/turn') {
      return send(res, 501, {
        error: 'No telephony provider is wired',
        hint: 'This endpoint is the contract your provider posts to once a number exists. Configure a number + media stream and it will answer; until then it refuses rather than faking a call.',
      });
    }

    return serveStatic(res, urlPath);
  } catch (err) {
    if (err && err.status) return send(res, err.status, { error: err.message });
    return send(res, 500, { error: err.message || 'Scan failed' });
  }
});

server.listen(PORT, () => {
  console.log(`exelo deploying AI employees on http://localhost:${PORT}`);
});
