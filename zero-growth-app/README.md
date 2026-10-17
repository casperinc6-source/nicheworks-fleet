# zero-growth-app

Track money growing **from zero**: log income and expenses, watch the net
growth curve climb. Zero npm dependencies — pure Node.js + built-in SQLite. Requires Node.js
22.13 or newer (`node:sqlite` is unflagged from that release).

## Run

```bash
cd zero-growth-app
npm start
```

Open http://localhost:3002

## Features

- Income/expense entries with labels and dates (stored in cents, SQLite WAL)
- Live totals: income, expenses, net growth
- Cumulative **growth curve from zero** drawn on a canvas
- API: `GET/POST /api/entries`, `DELETE /api/entries/:id`, `GET /api/summary`

## Structure

- `server.js` — HTTP server + API (SQLite-backed)
- `public/index.html` — dashboard UI

The honest version of "zero to growth": every dollar logged is real.
