# claim-finder

**Official** unclaimed money directory (all 50 states + DC) + government
surplus auction sources + a personal claim tracker.

Claiming money through your state's unclaimed-property program is always
**free** — states hold billions in dormant accounts, uncashed paychecks and
old deposits, and by law must return them to whoever proves ownership. This
app points you only at official government sources and never asks for
personal data. It is not affiliated with any government agency.

Every per-state URL was taken from the official NAUPA master finder
(https://unclaimed.org/search/) — the association *of* the state programs —
not from aggregators. Link hygiene: `node scripts/check-links.mjs`.

Also includes the legal version of "free cars / houses": government surplus
and seized-property auctions (GovDeals, GSA, realestatesales.gov, USA.gov
hubs). You can't just *claim* an abandoned car — cities tow and auction it.

Zero dependencies. `npm start` → http://localhost:3007

## Static mode (GitHub Pages)

The same page also runs with **no backend**: https://casperinc6-source.github.io/claim-finder/

It tries the SQLite API first; if that's absent it falls back to
`states.json` and stores tracker claims in browser localStorage (with a
one-time "static mode" banner). The directory works identically in both
modes.

`docs/` is the Pages copy — after changing `public/index.html` or
`sources.js`, regenerate it:

    node -e "const {STATES,AUCTIONS,NAUPA,MISSINGMONEY}=require('./sources.js');\n      require('fs').writeFileSync('public/states.json',JSON.stringify({generated:new Date().toISOString(),source:'official NAUPA finder (https://unclaimed.org/search/)',states:STATES.map(([c,n,u])=>[c,n,u]),auctions:AUCTIONS,naupa:NAUPA,missingmoney:MISSINGMONEY},null,2)+'\n')"
    cp public/index.html public/states.json docs/

## API

- `GET  /api/states` — all 51 programs + auction sources + NAUPA fallback
- `GET  /api/claims` — list tracked claims
- `POST /api/claims` — `{ item, state, url, value, notes? }` (validated)
- `PATCH /api/claims/:id` — `{ status }`: researching → filed → waiting → paid → closed
- `DELETE /api/claims/:id`

Tracked claims live in `data/claims.db` (built-in `node:sqlite`), gitignored.

## Structure

- `server.js` — static files + API
- `db.js` — SQLite claim store
- `sources.js` — verified state + auction link registry
- `public/index.html` — the UI
- `scripts/check-links.mjs` — link-liveness sweep (concurrent)

## Legal note

Some states allow licensed finders to charge a small statutory commission —
but you can always file yourself for free. Never pay anyone a percentage to
do what your state does for nothing.

## CSV export / import

The tracker toolbar exports all claims as CSV (`item, state, url,
value_usd, status, notes`) and imports them back — quotes, embedded
commas and escaped quotes handled per RFC-4180-ish rules; invalid rows
(item < 2 chars, non-http url) are skipped with a count. Works
identically in node and static modes (static imports land in
localStorage).
