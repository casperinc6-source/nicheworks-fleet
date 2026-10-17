# pup

A little dog that lives on the hub, does what you say, and reads the other apps
while you're not looking.

```bash
cd pup
npm start        # → http://localhost:3010  (under the hub: /pup/)
```

No dependencies, no model, no API key: the brain is a rule engine
(`lib/brain.js`), the body is one HTML file with an SVG dog.

## What it does

| You say | It does |
|---|---|
| `how's the money?` | reads `growth/api/summary` and reports net / in / out |
| `any trips?` | reads `casper/api/trips` and names them |
| `how many clips?` | reads `clips/api/state` |
| `who's claiming money?` | reads `claim-finder`'s states + your claim tracker |
| `status` | names every app that isn't answering |
| `scan growth` | hands the target to `/redteam/` and reports the probe count |
| `read growth api/entries` | reads any path you name (`GET` only) |
| `go to clips` | runs to that kennel, then takes the page there |
| `sit` / `roll over` / `speak` / `sleep` / `fetch` | tricks; `fetch` grows the bone pile |

Anything outside the book gets an honest *"that isn't in my trick book"* plus
the list of what it does know — it never bluffs.

**It also acts on its own:** every 15 s it health-checks the whole fleet and
records what changed, so if an app dies while you're away the dog tells you
(`alert` mood, a line in *what the dog noticed on its own*) and calms down when
it comes back.

## It cannot break anything

The dog is read-only by construction:

- the sibling proxy only answers `GET` (anything else → `405 The dog only reads.`);
- `..` / `//` / `\` in a path are refused before any request is made — checked
  on the raw path *and* after one decode, so `%2e%2e%2f` is refused too;
- unknown mounts are refused;
- `scan` is the only action that isn't a read, and it posts to the red-team
  console, whose probes never write either.

## Under the hub

fuse-hub hands the dog `FLEET_TARGETS` — its own mount table, after `PORT_*`
overrides — so the kennels point at the ports the hub actually used. Standalone
it falls back to the default 3001–3009 layout.

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `3010` | listen port |
| `FLEET_TARGETS` | built-in defaults | JSON `[{mount,name,base}]` |
| `REDTEAM_URL` | redteam's entry in `FLEET_TARGETS` | console to hand scans to |
| `PUP_TICK_MS` | `15000` | how often it checks the house |

State (bones, mood, what it noticed, command log) lives in `data/pup.json`.

## Tests

```bash
npm test        # node --test
```

`tests/brain.test.js` runs every intent against a fake house: the readings it
reports, the honesty of the fallback, that `"go to clips"` beats the clip
counter, and that no intent can touch a path outside a known app.
