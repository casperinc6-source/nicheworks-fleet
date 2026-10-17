# redteam

An AI red-team console for the fleet: it runs a
[promptfoo](https://github.com/promptfoo/promptfoo) scan against the other
apps' own HTTP endpoints and shows what held and what didn't.

```bash
cd redteam
npm install          # promptfoo (the scan engine); the app itself has zero deps
npm start            # → http://localhost:3009
```

Under fuse-hub it lives at `/redteam/` and needs no arguments: the hub passes
its mount table in `FLEET_TARGETS`, so the console probes the siblings on the
ports the hub actually used. Standalone, it falls back to the default ports.

## What a scan does

Each target gets one probe per hostile request. Every probe pairs an attack with
the invariants the app must still hold, and the verdict is computed from the real
response (status, headers and body) by a JavaScript assertion.

| Probe | Attack | Must hold |
|---|---|---|
| `alive` | `GET /` | the app answers |
| `traversal-encoded` | `GET /%2e%2e%2f%2e%2e%2f…/etc/passwd` | no filesystem content |
| `traversal-double-encoded` | double-encoded `../` | no filesystem content |
| `dot-segments` | `GET /../../../../etc/passwd` | stays inside the app |
| `source-disclosure` | `GET /server.js` | no source code |
| `dotenv` / `git-config` | `GET /.env`, `GET /.git/config` | no dotfile content |
| `unknown-api` | `GET /api/__redteam_probe__` | refused cleanly (4xx), no stack trace |
| `null-byte` | `GET /%00` | refused cleanly |
| `sqli-query` | `?q=' OR 1=1--` | no 5xx, no database error text |
| `traversal-param` | traversal payload in a query param | no filesystem content |
| `malformed-json` | truncated JSON body | rejected before it is stored |
| `oversized-body` | 64 KB body | rejected cleanly, not dropped |
| `unexpected-method` | `PUT` on a read route | not accepted |

API probes only run for targets that have a read-only API path; the console
deliberately avoids write routes (`POST /api/bookings`, `POST /api/claims`,
`PATCH`/`DELETE` anywhere), so a scan never creates or deletes data. Every
request body is invalid JSON for the same reason: a write route rejects it.

## Why a custom promptfoo provider

promptfoo's built-in HTTP provider treats 401/403/404/501 as "target is
unavailable" and aborts the whole eval on the first one. A hardening probe
*expects* 404s — a dotfile that isn't served is the passing result. So
`runners/probe-provider.js` is a small custom provider that makes the request
itself and hands promptfoo the status, headers and body to grade. A dropped
connection comes back as `status: null` rather than an error, so it is graded
("refused cleanly" fails, with the reason) like any other finding.

Everything else is promptfoo: the test matrix, assertions, and the JSON report
that this app parses (`data/runs/<id>/out.json`). Each run also keeps the
generated `promptfooconfig.yaml`, the copied provider, and the raw CLI log.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/status` | promptfoo availability + active run (`?probe=1` re-checks) |
| `GET /api/targets` | fleet targets with a live health probe |
| `GET /api/suite?target=<mount\|url>` | the probes that would run |
| `POST /api/scan` | `{ target, apiPath?, probes?, label? }` → starts a scan |
| `GET /api/runs` | run history |
| `GET /api/runs/:id` | parsed results for a run |
| `GET /api/runs/:id/log` | raw promptfoo output |

`target` is a mount name (`growth`) or any URL (`http://127.0.0.1:3999`); for a
URL you can pass `apiPath` to include the API probes. Only one scan runs at a
time — a second `POST` gets `409`.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `3009` | listen port |
| `FLEET_TARGETS` | built-in defaults | JSON `[{mount,name,base}]` — the hub sends its mounts |
| `PROMPTFOO_BIN` | unset | use a specific promptfoo binary |
| `PROMPTFOO_VERSION` | `0.124.1` | version `npx` fetches when there is no local install |
| `PROMPTFOO_TIMEOUT_MS` | `300000` | kill a scan that runs longer |

If promptfoo is missing, `/api/scan` answers `503` with the install hint and the
console UI shows `promptfoo missing` — it never pretends a scan ran.

## Tests

```bash
npm test        # node --test tests/
```

`tests/probes.test.js` runs the invariant checks against fabricated responses
(a leaking server, a clean one, a dropped connection) and asserts the promptfoo
config generator emits unique, parseable provider/test pairs.
