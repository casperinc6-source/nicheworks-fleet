# fuse-hub

One command, all the apps. fuse-hub spawns every sibling project's
`server.js` as a child process (with auto-restart) and reverse-proxies
them under a single port.

```bash
cd fuse-hub
npm start            # → http://localhost:4000
npm test             # boots the fleet on free ports and walks every mount
```

Child ports default to 3001–3010. Override any with `PORT_<MOUNT>`
(`PORT_GROWTH`, `PORT_CASPER`, … `PORT_REDTEAM`, `PORT_PUP`) to run a second
copy of the fleet — or `npm test` — beside a live one.

| Mount | App |
|---|---|
| `/growth` | zero-growth-app — money growth tracker |
| `/casper` | casperinc6-source — booking + Stripe |
| `/cobra`  | beige-cobras-scream — scaffold |
| `/conway` | automaton-conway — Game of Life |
| `/bots`   | conway-automoton-survivalbots — bot ecology |
| `/clips`  | paperclip-maximizer — idle game |
| `/jarvis` | jarvis-landing — voice OS assistant landing page |
| `/claims` | claim-finder — official unclaimed-money directory + tracker |
| `/redteam` | redteam — promptfoo probe scans of the fleet's own endpoints |
| `/pup` | pup — the little dog that reads the fleet and does what you say |

The landing page shows live health (probed 🟢/🟡/🔴). `Ctrl-C` stops
everything cleanly.

## Scanning the fleet (`/redteam`)

The hub hands its own mount table to the red-team console through
`FLEET_TARGETS`, so `/redteam/` scans the siblings on whatever ports this
hub actually used — including `PORT_*` overrides.

The scan engine is [promptfoo](https://github.com/promptfoo/promptfoo).
Install it once inside the app (the hub itself stays dependency-free):

```bash
cd ../redteam && npm install   # promptfoo, ~250 MB of node_modules
```

Until then the console still runs and says so; scans return a clear 503
instead of failing silently. On Linux, `npm install` there needs
`@libsql/linux-x64-gnu` if npm skipped optional dependencies.

## The dog (`/pup`)

`/pup/` is a read-only companion over the same mount table: ask it for the
money, the trips, the clip count or the claim directory and it fetches the real
response; say `scan growth` and it hands that target to `/redteam/`. It also
health-checks the fleet every 15 s by itself and tells you when an app goes
down. It reads only — the sibling proxy refuses anything but `GET`.

Both `/redteam` and `/pup` receive `FLEET_TARGETS` from this hub, so they target
the ports this hub actually used, `PORT_*` overrides included.

## Deploy on Render (free, 24/7)

The whole fleet runs as **one free web service** — `render.yaml` in this
repo is a Blueprint.

1. Push this repo to GitHub (done: `casperinc6-source/fuse-hub`).
2. On [render.com](https://render.com): **New + → Blueprint** → connect
   this repo → **Apply**. Render builds nothing (zero deps) and runs
   `node server.js` on one port.
3. Copy your service URL (`https://fuse-hub-xxxx.onrender.com`).
4. In GitHub → this repo → **Settings → Secrets and variables → Actions**:
   add secret `RENDER_URL` with that URL. The included
   `keepalive.yml` workflow then pings `/healthz` every 10 minutes, so
   the free tier's 15-minute idle sleep never triggers.

**Free-tier honest limits:**

- Cold start is ~50s if the service ever does sleep (e.g. GitHub
  Actions disabled after 60 days without a push — any push resets it).
- **Disk is ephemeral**: SQLite data (paperclip saves, claims tracker,
  growth entries) resets on redeploys/restarts. Demo-grade persistence;
  a paid disk or external DB fixes it later.
- `GET /healthz` returns JSON liveness for the hub (used by keepalive
  and Render health checks).
