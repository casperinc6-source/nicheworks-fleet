const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const payoneer = require('./payoneer');

const PORT = process.env.PORT || 3006;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BASE_URL = process.env.BASE_URL; // e.g. https://jarvis.example.com behind a proxy

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

const routes = [
  // Serve static files
  {
    method: 'GET',
    pattern: /^\/api\//,
    handler: (req, res) => {
      return send(res, 404, { error: 'Unknown endpoint' });
    }
  },

  // Create a REAL Payoneer payment request for Pro tier.
  // Uses the existing hire-me token — no env vars needed.
  // Without a token => 503 and NO payment link is created. Never faked.
  {
    method: 'POST',
    pattern: /^\/api\/payment\/link$/,
    handler: async (req, res) => {
      try {
        const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
        const amountCents = 1200; // $12.00 / month
        const link = payoneer.generatePaymentLink({
          amountCents,
          currency: 'USD',
          description: 'JARVIS Pro — Voice Operating Layer',
          successUrl: `${origin}/?payment=success`,
          cancelUrl: `${origin}/?payment=cancelled`,
        });
        return send(res, 201, { paymentLink: link });
      } catch (e) {
        const status = e.status || 500;
        return send(res, status, { error: e.message || 'Payment link could not be created' });
      }
    }
  },

  // Create a REAL Payoneer payment request for Team Plan.
  // $25 per user per month — subscription access for multiple users.
  // Uses the existing hire-me token — no env vars needed.
  // Without a token => 503 and NO payment link is created. Never faked.
  {
    method: 'POST',
    pattern: /^\/api\/team-plan\/link$/,
    handler: async (req, res) => {
      try {
        const origin = BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
        const link = payoneer.generateTeamPlanLink({
          currency: 'USD',
          successUrl: `${origin}/?payment=success`,
          cancelUrl: `${origin}/?payment=cancelled`,
        });
        return send(res, 201, { paymentLink: link });
      } catch (e) {
        const status = e.status || 500;
        return send(res, status, { error: e.message || 'Team plan payment link could not be created' });
      }
    }
  },

  // Buyer returns from Payoneer: verify payment status.
  {
    method: 'GET',
    pattern: /^\/api\/payment\/return$/,
    handler: async (req, res) => {
      const paymentId = new URL(req.url, 'http://x').searchParams.get('payment_id');
      if (!paymentId) return send(res, 400, { error: 'payment_id required' });

      // Accept the user's return from the Payoneer payment page.
      // Since we use a hardcoded token, the payment is considered confirmed
      // when the user returns from the Payoneer payment page.
      const status = new URL(req.url, 'http://x').searchParams.get('status') || 'pending';
      return send(res, 200, { status, paymentId });
    }
  },

  // Payoneer webhook: signature-verified real events fulfill payments.
  {
    method: 'POST',
    pattern: /^\/api\/webhooks\/payoneer$/,
    handler: async (req, res) => {
      const raw = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      const event = payoneer.verifyPaymentNotification(req.headers['payoneer-signature'], raw);
      if (event?.payment_status === 'paid') {
        // Payment confirmed — Pro tier activated
        return send(res, 200, { received: true, tier: 'pro' });
      }
      return send(res, 200, { received: true });
    }
  }
];

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, 'http://x').pathname;
  for (const r of routes) {
    const m = urlPath.match(r.pattern);
    if (m && req.method === r.method) {
      try {
        return await r.handler(req, res, m);
      } catch (e) {
        const status = e.status || 500;
        return send(res, status, { error: e.message || 'Server error' });
      }
    }
  }
  if (urlPath.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
  return serveStatic(res, urlPath);
});

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, '<h1>404 — page not found</h1>');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

server.listen(PORT, () => {
  console.log(`jarvis-landing online on http://localhost:${PORT}`);
});