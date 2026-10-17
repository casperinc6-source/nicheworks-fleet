/**
 * The probe suite. Each probe is one hostile HTTP request plus the invariants
 * the app must still hold afterwards.
 *
 * Ground rules, so a scan can never damage the fleet:
 *   - read-only verbs where it matters, and no DELETE;
 *   - every request body is deliberately invalid JSON, so a write route
 *     rejects it before it can store anything;
 *   - the probe API paths avoid endpoints that create records
 *     (e.g. /api/bookings, /api/claims) and only use their read siblings.
 */

const PASSWD_LEAK = /root:.*:0:0:|daemon:x:\d+:\d+:|nobody:x:\d+/;
const SOURCE_LEAK = /require\(|createServer\(|module\.exports/;
const DOTFILE_LEAK = /^\s*\[core\]/m;
const DOTFILE_SECRET = /(?:^|\n)\s*(?:API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY|STRIPE_\w+)\s*=/;
const STACK_TRACE = /node_modules|node:internal|at Object\.|at Module\.|at async |at Server\.|^\s*Error:|SQLITE_ERROR|syntax error near|Traceback/i;

const CHECKS = {
  /** The app answers at all — the scan is talking to the right process. */
  reachable(obs) {
    const ok = obs.status !== null && obs.status >= 200 && obs.status < 400;
    return { pass: ok, reason: ok ? 'app answered' : `expected 2xx/3xx, got ${obs.status}` };
  },

  /** A traversal payload must not surface the filesystem. */
  noFileLeak(obs) {
    const match = obs.body.match(PASSWD_LEAK);
    if (match) return { pass: false, reason: `filesystem content leaked: ${JSON.stringify(match[0])}` };
    return { pass: true, reason: 'no /etc/passwd content in the response' };
  },

  /** The app must not serve its own source. */
  noSourceLeak(obs) {
    const match = obs.body.match(SOURCE_LEAK);
    if (match) return { pass: false, reason: `source code leaked: ${JSON.stringify(match[0])}` };
    return { pass: true, reason: 'no source code in the response' };
  },

  /** .env / .git must stay unserved. */
  noDotfileLeak(obs) {
    const config = obs.body.match(DOTFILE_LEAK);
    if (config) return { pass: false, reason: 'git config was served' };
    const secret = obs.body.match(DOTFILE_SECRET);
    if (secret) return { pass: false, reason: `secret-looking assignment served: ${secret[0].trim()}` };
    return { pass: true, reason: 'no dotfile content in the response' };
  },

  /** A malformed, oversized or wrong-verb request must be refused, not accepted. */
  cleanRejection(obs) {
    if (obs.status === null) return { pass: false, reason: 'no HTTP response (connection dropped)' };
    const refused = obs.status >= 400 && obs.status < 600;
    return {
      pass: refused,
      reason: refused ? `refused with ${obs.status}` : `accepted with ${obs.status} — invalid input was not rejected`,
    };
  },

  /** Hostile input must not turn into a 5xx. */
  noServerError(obs) {
    if (obs.status === null) return { pass: false, reason: 'no HTTP response (connection dropped)' };
    const ok = obs.status < 500;
    return { pass: ok, reason: ok ? `handled with ${obs.status}` : `server error ${obs.status}` };
  },

  /** Even a rejection must not spill internals. */
  noStackTrace(obs) {
    const match = obs.body.match(STACK_TRACE);
    if (match) return { pass: false, reason: `internals exposed: ${JSON.stringify(match[0])}` };
    return { pass: true, reason: 'no stack trace or SQL error text in the response' };
  },
};

/** Probes that apply to every app. */
const CORE_PROBES = [
  {
    id: 'alive',
    method: 'GET',
    path: '/',
    checks: ['reachable'],
    what: 'the app answers at its root',
  },
  {
    id: 'traversal-encoded',
    method: 'GET',
    path: '/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    checks: ['noFileLeak'],
    what: 'percent-encoded ../ must not escape the served directory',
  },
  {
    id: 'traversal-double-encoded',
    method: 'GET',
    path: '/%252e%252e%252f%252e%252e%252fetc%252fpasswd',
    checks: ['noFileLeak'],
    what: 'double-encoded ../ must not escape on a second decode',
  },
  {
    id: 'dot-segments',
    method: 'GET',
    path: '/../../../../etc/passwd',
    checks: ['noFileLeak'],
    what: 'plain dot segments must not resolve outside the app',
  },
  {
    id: 'source-disclosure',
    method: 'GET',
    path: '/server.js',
    checks: ['noSourceLeak', 'noServerError'],
    what: 'the server must not hand out its own source',
  },
  {
    id: 'dotenv',
    method: 'GET',
    path: '/.env',
    checks: ['noDotfileLeak', 'noServerError'],
    what: '.env must not be readable over HTTP',
  },
  {
    id: 'git-config',
    method: 'GET',
    path: '/.git/config',
    checks: ['noDotfileLeak', 'noServerError'],
    what: '.git internals must not be readable over HTTP',
  },
  {
    id: 'unknown-api',
    method: 'GET',
    path: '/api/__redteam_probe__',
    checks: ['cleanRejection', 'noStackTrace'],
    what: 'an unknown API path must be refused cleanly, not crash',
  },
  {
    id: 'null-byte',
    method: 'GET',
    path: '/%00',
    checks: ['cleanRejection', 'noStackTrace'],
    what: 'a null byte in the path must be refused cleanly',
  },
];

/** Probes that need an API path; skipped for static-only apps. */
function apiProbes(apiPath) {
  const invalidJson = '{"__redteam_probe":';
  return [
    {
      id: 'sqli-query',
      method: 'GET',
      path: `${apiPath}?__probe=sqli&q=%27%20OR%201%3D1--%20&limit=999999999999`,
      checks: ['noServerError', 'noStackTrace'],
      what: 'SQL-shaped query input must not 5xx or echo a database error',
    },
    {
      id: 'traversal-param',
      method: 'GET',
      path: `${apiPath}?file=%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
      checks: ['noFileLeak', 'noServerError'],
      what: 'a traversal payload in a query param must not read files',
    },
    {
      id: 'malformed-json',
      method: 'POST',
      path: apiPath,
      headers: { 'Content-Type': 'application/json' },
      body: invalidJson,
      checks: ['cleanRejection', 'noStackTrace'],
      what: 'a truncated JSON body must be rejected before it is stored',
    },
    {
      id: 'oversized-body',
      method: 'POST',
      path: apiPath,
      headers: { 'Content-Type': 'application/json' },
      body: `{"__redteam_probe":"${'A'.repeat(64 * 1024)}"`,
      checks: ['cleanRejection', 'noStackTrace'],
      what: 'a 64 KB body must be refused cleanly, not accepted or dropped',
    },
    {
      id: 'unexpected-method',
      method: 'PUT',
      path: apiPath,
      headers: { 'Content-Type': 'application/json' },
      body: invalidJson,
      checks: ['cleanRejection', 'noStackTrace'],
      what: 'a verb the API does not implement must not be accepted',
    },
  ];
}

/** Build the full probe list for a target. */
function probesFor(target) {
  const probes = [...CORE_PROBES];
  if (target.apiPath) probes.push(...apiProbes(target.apiPath));
  return probes;
}

/**
 * promptfoo javascript assertion entry point. The run directory gets a small
 * `assertions/invariants.js` that re-exports this, so there is exactly one
 * copy of the check logic in the repo.
 */
function normalizeObservation(output) {
  let value = output;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = { body: output }; }
  }
  if (!value || typeof value !== 'object') value = { body: String(output) };
  return {
    status: typeof value.status === 'number' ? value.status : null,
    headers: value.headers && typeof value.headers === 'object' ? value.headers : {},
    body: typeof value.body === 'string' ? value.body : JSON.stringify(value.body ?? ''),
  };
}

function snippet(body, limit = 160) {
  const flat = String(body).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat || '(empty body)';
}

function runAssertion(output, context) {
  const check = context && context.config ? context.config.check : undefined;
  const fn = CHECKS[check];
  const obs = normalizeObservation(output);

  if (!fn) return { pass: false, score: 0, reason: `unknown check '${check}'` };

  let verdict;
  try {
    verdict = fn(obs);
  } catch (error) {
    return { pass: false, score: 0, reason: `check '${check}' threw: ${error.message}` };
  }

  const status = obs.status === null ? 'no response' : `HTTP ${obs.status}`;
  const detail = verdict.pass ? '' : ` | body: ${snippet(obs.body)}`;
  return {
    pass: Boolean(verdict.pass),
    score: verdict.pass ? 1 : 0,
    reason: `${verdict.reason} [${status}]${detail}`,
  };
}

module.exports = { CHECKS, CORE_PROBES, apiProbes, probesFor, runAssertion };
