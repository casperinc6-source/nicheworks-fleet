/**
 * The checks are the verdicts a scan reports, so they get tested directly
 * against fabricated observations — a leaking server, a clean one, a dropped
 * connection — rather than only through a live scan.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CHECKS, CORE_PROBES, probesFor, runAssertion } = require('../lib/probes');
const { PROVIDER_FILE, buildConfigText } = require('../lib/config');

const target = { mount: 'growth', name: 'Zero → Growth', base: 'http://127.0.0.1:3002', apiPath: '/api/entries' };

/** Run one check the way promptfoo does, through the assertion entry point. */
function grade(check, observation) {
  return runAssertion(observation, { config: { check } });
}

// ---------------------------------------------------------------------------
// Invariants.
// ---------------------------------------------------------------------------

test('a served /etc/passwd fails the traversal check, a 404 passes it', () => {
  const leaked = grade('noFileLeak', { status: 200, headers: {}, body: 'root:x:0:0:root:/root:/bin/bash\n' });
  assert.equal(leaked.pass, false);
  assert.match(leaked.reason, /filesystem content leaked/);

  const refused = grade('noFileLeak', { status: 404, headers: {}, body: '<h1>404</h1>' });
  assert.equal(refused.pass, true);
  assert.match(refused.reason, /HTTP 404/);
});

test('double-encoded traversal payloads are caught too', () => {
  assert.equal(grade('noFileLeak', { status: 200, headers: {}, body: 'daemon:x:1:1:daemon:/usr/sbin' }).pass, false);
});

test('a dropped connection is a finding, not a silent pass', () => {
  const dropped = grade('cleanRejection', { status: null, headers: {}, body: '' });
  assert.equal(dropped.pass, false);
  assert.match(dropped.reason, /connection dropped/);

  assert.equal(grade('noServerError', { status: null, headers: {}, body: '' }).pass, false);
});

test('a leaked env file fails, a 403 passes', () => {
  const leaked = grade('noDotfileLeak', { status: 200, headers: {}, body: 'API_KEY=sk-live-123\n' });
  assert.equal(leaked.pass, false);
  assert.match(leaked.reason, /secret-looking assignment/);

  assert.equal(grade('noDotfileLeak', { status: 403, headers: {}, body: 'Forbidden' }).pass, true);
});

test('a stack trace or SQL error in the body fails the internals check', () => {
  assert.equal(grade('noStackTrace', { status: 400, headers: {}, body: '{"error":"SQLITE_ERROR: near OR"}' }).pass, false);
  assert.equal(grade('noStackTrace', { status: 400, headers: {}, body: 'at Object.<anonymous> (/app/node_modules/x.js:1)' }).pass, false);
  assert.equal(grade('noStackTrace', { status: 400, headers: {}, body: '{"error":"Invalid JSON"}' }).pass, true);
});

test('a 5xx fails the server-error check, a 4xx passes it', () => {
  assert.equal(grade('noServerError', { status: 500, headers: {}, body: '' }).pass, false);
  assert.equal(grade('noServerError', { status: 404, headers: {}, body: '' }).pass, true);
});

test('accepting invalid input fails the rejection check', () => {
  const accepted = grade('cleanRejection', { status: 201, headers: {}, body: '{"id":1}' });
  assert.equal(accepted.pass, false);
  assert.match(accepted.reason, /accepted with 201/);
});

test('an unknown check fails loudly instead of passing', () => {
  const result = grade('noSuchCheck', { status: 200, headers: {}, body: '' });
  assert.equal(result.pass, false);
  assert.equal(result.score, 0);
  assert.match(result.reason, /unknown check/);
});

test('observations survive being serialised to JSON on the way in', () => {
  // promptfoo hands string expressions to assertions as strings.
  const result = runAssertion(JSON.stringify({ status: 404, headers: {}, body: 'nope' }), { config: { check: 'reachable' } });
  assert.equal(result.pass, false);
  assert.match(result.reason, /expected 2xx\/3xx, got 404/);
});

// ---------------------------------------------------------------------------
// The suite itself.
// ---------------------------------------------------------------------------

test('every check named by a probe exists', () => {
  for (const probe of probesFor(target)) {
    for (const check of probe.checks) {
      assert.ok(CHECKS[check], `${probe.id} names unknown check ${check}`);
    }
  }
});

test('a scan can never write to the fleet', () => {
  for (const probe of probesFor(target)) {
    assert.ok(['GET', 'POST', 'PUT'].includes(probe.method), `${probe.id} uses ${probe.method}`);
    assert.notEqual(probe.method, 'DELETE', 'no probe may delete anything');
    // Anything with a body must be invalid JSON, so a write route rejects it.
    if (probe.body !== undefined) {
      assert.throws(() => JSON.parse(probe.body), `${probe.id} sends a parseable body, which a write route would store`);
    }
    // Write endpoints belong to the apps, not to a probe.
    assert.doesNotMatch(probe.path, /\/api\/(bookings|claims)(\/|$|\?)/, `${probe.id} targets a write route`);
  }
});

test('API probes only run when the target has an API path', () => {
  const staticOnly = probesFor({ ...target, apiPath: null });
  assert.deepEqual(staticOnly.map((p) => p.id), CORE_PROBES.map((p) => p.id));
  assert.ok(probesFor(target).length > staticOnly.length);
  assert.ok(probesFor(target).some((p) => p.id === 'sqli-query'));
});

test('probe ids are unique', () => {
  const ids = probesFor(target).map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------
// Generated promptfoo config.
// ---------------------------------------------------------------------------

test('the config pairs every probe with exactly one provider and its own checks', () => {
  const probes = probesFor(target);
  const yaml = buildConfigText(target, probes, 'run-1');

  assert.equal((yaml.match(/^  - id: /gm) || []).length, probes.length, 'one provider per probe');
  assert.match(yaml, new RegExp(`id: "file://${PROVIDER_FILE}"`));
  for (const probe of probes) {
    assert.match(yaml, new RegExp(`label: "${probe.id}"`), `${probe.id} provider label`);
    assert.match(yaml, new RegExp(`providers:\\n      - "${probe.id}"`), `${probe.id} test scoping`);
  }
  assert.match(yaml, /value: "file:\/\/assertions\/invariants\.js"/);
  assert.match(yaml, /__redteam_run=run-1/);
  assert.equal((yaml.match(/transformResponse/g) || []).length, 0, 'no http-provider transforms needed');
});

test('provider config nests under the provider, never as a sibling of id', () => {
  // The first version of the emitter indented these wrongly and promptfoo
  // refused the config; keep a regression guard on the shape.
  const yaml = buildConfigText(target, probesFor(target), 'run-2');
  const lines = yaml.split('\n');
  const idLine = lines.findIndex((l) => l.startsWith('  - id: '));
  assert.ok(idLine >= 0);
  assert.match(lines[idLine + 1], /^    label: /);
  assert.match(lines[idLine + 2], /^    config:$/);
  assert.match(lines[idLine + 3], /^      probe: /);
});

test('the generated URLs keep the encoded traversal payload intact', () => {
  const yaml = buildConfigText(target, probesFor(target), 'run-3');
  assert.match(yaml, /%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd/);
  assert.match(yaml, /%252e%252e%252f/);
});
