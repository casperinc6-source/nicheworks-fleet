# casperinc6-source

Casper Inc. — company travel booking app with **real Stripe Checkout**.
Zero npm dependencies: pure Node.js (built-in `node:sqlite`, `fetch`, `node:crypto`).

## Run

```bash
cd casperinc6-source
cp .env.sample .env       # then paste YOUR real Stripe keys into .env
npm start                 # or: npm run dev (auto-reload)
```

Open http://localhost:3001

**Without Stripe keys the app refuses to check out (503) — it never fakes a payment.**
Payments go through Stripe-hosted Checkout; a booking is `pending` (seats held)
until the webhook or return-verification confirms the real payment.

## Payment flow

```
book form → POST /api/bookings → pending booking (seats held)
          → 201 {checkoutUrl}  → redirect to Stripe Checkout (hosted by Stripe)
          → buyer pays on stripe.com → redirect back ?payment=success&session_id=…
          → GET /api/checkout/return verifies the REAL session server-side → confirmed
   and/or → POST /api/webhooks/stripe (HMAC-verified) fulfills asynchronously
   cancel → session expired / buyer aborts → seats released automatically
```

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/trips` | trips + live seat counts |
| POST | `/api/bookings` | validate → hold seats → create Stripe Checkout → `{checkoutUrl}` |
| GET | `/api/bookings?email=` | bookings for an email |
| GET | `/api/checkout/return?session_id=` | server-side payment verification |
| DELETE | `/api/bookings/:id` | cancel a **confirmed** booking, restock seats |
| POST | `/api/webhooks/stripe` | signature-verified Stripe events |

## Webhooks (local dev)

```bash
stripe listen --forward-to localhost:3001/api/webhooks/stripe
# paste the printed whsec_… into .env as STRIPE_WEBHOOK_SECRET
```

Webhook signatures are verified with HMAC-SHA256 (`node:crypto`) + replay window.

## Structure

- `server.js` — HTTP server, static files, API, checkout + webhook routes
- `stripe.js` — zero-dependency Stripe REST client + webhook signature verification
- `db.js` — SQLite schema (incl. auto-migration for pre-Stripe databases), seed
- `public/index.html` — frontend: trips, booking form, Stripe redirect, return banners

Test card for test mode: `4242 4242 4242 4242`, any future expiry, any CVC.
