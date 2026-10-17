/**
 * Real Stripe integration over the REST API — no SDK, no simulation.
 * 
 * Requires STRIPE_SECRET_KEY (and STRIPE_WEBHOOK_SECRET for webhooks) in env.
 * Without a key the checkout route fails loudly with a 503 — the app never
 * fakes a payment.
 */
const crypto = require('node:crypto');

const API = 'https://api.stripe.com/v1';
const API_VERSION = '2026-05-23.basil'; // pinned from Stripe dashboard "API version"

function secretKey() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !/^sk_(test|live)_/.test(key)) {
    const err = new Error('STRIPE_SECRET_KEY is not configured (expected sk_test_… or sk_live_…)');
    err.status = 503;
    throw err;
  }
  return key;
}

/** URL-encode an object the way Stripe's form API expects. */
function form(obj) {
  return new URLSearchParams(obj).toString();
}

/** Minimal typed wrapper around fetch for Stripe's JSON API. */
async function stripeRequest(method, path, params) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      'Stripe-Version': API_VERSION,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? form(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `Stripe HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status === 401 ? 503 : 502; // bad key vs Stripe-side problem
    throw err;
  }
  return data;
}

/**
 * Create a real Checkout Session for a Pro subscription.
 * `origin` builds success/cancel URLs.
 */
function createCheckoutSession({ origin }) {
  return stripeRequest('POST', '/checkout/sessions', {
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: {
      0: {
        price_data: {
          currency: 'usd',
          unit_amount: '1200', // $12.00 in cents
          recurring: { interval: 'month' },
          product_data: { name: 'JARVIS Pro — Voice Operating Layer' },
        },
      },
    },
    success_url: `${origin}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?payment=cancelled`,
  });
}

/** Retrieve a session directly (used when the buyer returns from checkout). */
function retrieveSession(sessionId) {
  return stripeRequest('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

/** Verify a webhook signature (Stripe-Signature header) against the raw body. */
function verifyWebhookSignature(header, rawBody) {
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whsec || !whsec.startsWith('whsec_')) {
    const err = new Error('STRIPE_WEBHOOK_SECRET is not configured');
    err.status = 503;
    throw err;
  }
  if (!header) {
    const err = new Error('Missing Stripe-Signature header');
    err.status = 400;
    throw err;
  }

  let t = null;
  const v1 = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = v;
    if (k === 'v1') v1.push(v);
  }
  if (!t || v1.length === 0) {
    const err = new Error('Malformed Stripe-Signature header');
    err.status = 400;
    throw err;
  }

  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > 300) {
    const err = new Error('Webhook timestamp outside tolerance');
    err.status = 400;
    throw err;
  }

  const expected = crypto.createHmac('sha256', whsec).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const ok = v1.some((sig) => {
    const b = Buffer.from(sig, 'hex');
    return b.length === a.length && crypto.timingSafeEqual(a, b);
  });
  if (!ok) {
    const err = new Error('Webhook signature mismatch');
    err.status = 400;
    throw err;
  }
  return JSON.parse(rawBody.toString('utf8'));
}

module.exports = { createCheckoutSession, retrieveSession, verifyWebhookSignature };