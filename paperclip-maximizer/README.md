# paperclip-maximizer

The classic AI-box thought experiment as an idle game. You are a
paperclip maximizer: make clips from wire, price them against demand,
market them, buy autoclippers — and watch the universe become clips.

Zero dependencies. `npm start` → http://localhost:3005

Milestones at 10 / 100 / 500 / 1k / 5k / 20k clips. The last one is a joke.
Mostly.

## Persistence

Progress lives in `data/paperclip.db` (built-in `node:sqlite`), autosaved
every 4s while dirty and flushed on tab close — restart the server and
the empire continues. "Reset universe" wipes it (with a confirm).

API: `GET/POST/DELETE /api/state` — one sanitized JSON row.

## Structure

- `server.js` — static files + state API
- `db.js` — SQLite single-row state store
- `public/index.html` — the game
