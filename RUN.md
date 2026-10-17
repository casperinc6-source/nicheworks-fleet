# Run the fleet

25 zero-dependency Node apps. `fuse-hub` runs them all as child processes and
reverse-proxies each one under a path, so a single port serves everything.

## One command

```bash
node fuse-hub/server.js        # or: npm start
# → http://localhost:4000/     (hub index — every app, with live health)
```

Node 18+ only. There is nothing to `npm install` — every app uses the standard
library (`node:http`, `node:sqlite`, `node:crypto`).

## Test

```bash
npm test        # boots the real fleet behind a hub and walks every mount
# → 11 tests, 11 pass
```

## Docker

```bash
docker compose up --build
# → http://localhost:4000/
```

The image runs `fuse-hub` and exposes one port. Data lives in the `fleet-data`
volume.

## What's mounted

| Mount | App | One line |
|-------|-----|----------|
| `/growth` | zero-growth-app | $0 → growth tracker (premium: projections) |
| `/casper` | casperinc6-source | travel booking + Stripe checkout |
| `/cobra` | beige-cobras-scream | landing |
| `/conway` | automaton-conway | Conway's Game of Life |
| `/bots` | conway-automoton-survivalbots | predator-prey ecology |
| `/clips` | paperclip-maximizer | idle game |
| `/jarvis` | jarvis-landing | voice-OS landing + Payoneer links |
| `/claims` | claim-finder | unclaimed-money directory + tracker |
| `/redteam` | redteam | promptfoo probe scans of the fleet |
| `/pup` | pup | reads the fleet and answers |
| `/watchtower` | audit-funnel | **security audit**: real scans → paid report + monitoring |
| `/loom` | artcraft | **generative SVG pattern studio** |
| `/keysmith` | pqc-migration | **post-quantum readiness** key analyser |
| `/deception` | deception | decoy endpoints + canary tokens |
| `/agentzero` | agent-zero | **fleet orchestrator (the king)** |
| `/vault` | vault | **offline file storage** (content-addressed) |
| `/reader` | reader | **private script-free reader** |
| `/esim` | esim-desk | **travel data storefront** (referral) |
| `/krypt` | krypt-trader | **live crypto market + portfolio** (read-only) |
| `/saluki` | saluki-desk | **local agent model desk** (Underdog Saluki 27B) |
| `/poe` | aggregator | **multi-model chat front door** (Poe-style) |
| `/ultron` | ultron | **adversary simulator** (defensive, fleet-scoped) |
| `/ruflow` | ruflow | **repo of runnable flows** across the fleet |
| `/exelo` | exelo | **AI employee desk**: scans local businesses, prices the leak, builds the receptionist kit |
| `/revenue` | revenue | **the fleet's own books**: MRR from recorded deals, catalog grepped from each app |

## Environment variables

| Var | Used by | Effect |
|-----|---------|--------|
| `PORT` | fuse-hub | hub port (default 4000) |
| `PORT_<MOUNT>` | any | override a child's port (e.g. `PORT_CLIPS=13005`) |
| `STRIPE_PUBLIC_KEY` | paid apps | switch checkout from Payoneer token to Stripe |
| `MODEL_BACKEND_URL` | saluki, agent-zero | local Ollama (`:11434`) / llama.cpp / LocalAI (`:8080`) |
| `VAULT_URL` | reader | where archived articles go (default `:3016`) |
| `WATCHTOWER_URL` | agent-zero | where `audit` decrees are dispatched (default `:3011`) |
| `ESIM_AFFILIATE_TEMPLATE` / `ESIM_PROVIDER_KEY` | esim | tracked affiliate link / real provisioning |
| `EXELO_ALLOW_PRIVATE` | exelo | `1` lets the scanner read loopback/private hosts (tests only — default refuses them) |

`fuse-hub` wires `VAULT_URL` and `WATCHTOWER_URL` automatically to the ports it
assigns, so cross-app calls survive a `PORT_*` override.

## Deploy

- **Fly.io**: `fly.toml` is ready. One volume, one machine:
  ```bash
  fly volumes create fleet_data --size 1 --region iad   # once
  fly deploy
  ```
  Keep it at **one machine** — SQLite lives on that machine's volume, so scaling
  out would fork the books. `min_machines_running = 1` avoids cold starts and
  bills continuously; set it to `0` to trade that for sleep.
- **Render**: `fuse-hub/render.yaml` is a ready Blueprint (free tier notes are in
  the file — ephemeral disk, ~50s cold start).
- **Any Docker host**: `Dockerfile` + `docker-compose.yml` at the repo root.
  The entrypoint links each app's `data/` into the `/app/data` volume; without it
  a restart wipes every ledger.
- **Railway/Cloud Run**: point the start command at `node fuse-hub/server.js`
  and expose port `4000` (bring your own persistent volume).

### Honest limits
- Free hosts sleep and reset the filesystem — SQLite data and Vault blobs reset
  on restart unless you mount a volume (this compose file does).
- **No app takes a card by default.** Most paid endpoints gate on a hardcoded
  token (`Authorization: Bearer <token>`), which grants premium without money
  moving — it is a demo gate, not a checkout. `casperinc6-source` is the one app
  with a real Stripe Checkout path, and it refuses to charge until
  `STRIPE_SECRET_KEY` (+ webhook secret) is set. Deploying this fleet publishes
  it; it does not by itself produce revenue.
- `saluki` needs a local model backend; without one, `/api/chat` returns 503 and
  says so. `esim` is referral-only without `ESIM_PROVIDER_KEY`. `krypt` is
  read-only and never places orders.
