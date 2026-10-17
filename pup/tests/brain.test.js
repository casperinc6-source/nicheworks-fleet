/**
 * The brain is a rule engine, so it can be tested without a browser, a model or
 * a live fleet: every intent runs against a fake house that records what was
 * asked of it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { think, HELP, mountOf } = require('../lib/brain');

const FLEET = [
  { mount: 'growth', name: 'Zero → Growth', base: 'http://127.0.0.1:3002', health: { up: true } },
  { mount: 'casper', name: 'Casper Inc.', base: 'http://127.0.0.1:3001', health: { up: true } },
  { mount: 'clips', name: 'Paperclip Maximizer', base: 'http://127.0.0.1:3005', health: { up: true } },
  { mount: 'claims', name: 'ClaimFinder', base: 'http://127.0.0.1:3007', health: { up: false } },
  { mount: 'redteam', name: 'AI Red Team', base: 'http://127.0.0.1:3009', health: { up: true } },
];

/** A fake house: canned responses, and a record of every call it received. */
function makeContext(overrides = {}) {
  const calls = [];
  const responses = {
    'growth api/summary': { ok: true, status: 200, data: { income: 58, expense: 12.5, net: 45.5, entries: 2 } },
    'casper api/trips': { ok: true, status: 200, data: [{ name: 'Cape Town' }, { name: 'Marrakesh' }] },
    'clips api/state': { ok: true, status: 200, data: { clips: 12345 } },
    'claims api/states': { ok: true, status: 200, data: { states: new Array(51).fill('x') } },
    'claims api/claims': { ok: true, status: 200, data: [] },
    ...overrides,
  };
  return {
    calls,
    fleet: FLEET,
    state: { bones: 0, mood: 'happy' },
    get: async (mount, path) => {
      calls.push(`${mount} ${path}`);
      return responses[`${mount} ${path}`] || { ok: false, status: 404, error: 'not found' };
    },
    scan: async (mount) => {
      calls.push(`scan ${mount}`);
      return { ok: true, runId: 'run-1', probes: 14 };
    },
  };
}

test('mounts resolve by name, loosely and by mount', () => {
  assert.equal(mountOf('growth', FLEET), 'growth');
  assert.equal(mountOf('paperclip maximizer', FLEET), 'clips');
  assert.equal(mountOf('paperclip', FLEET), 'clips');
  assert.equal(mountOf('ClaimFinder', FLEET), 'claims');
  assert.equal(mountOf('nope', FLEET), null);
});

test('"how\'s the money?" reads growth and reports the totals', async () => {
  const ctx = makeContext();
  const out = await think("how's the money?", ctx);
  assert.equal(out.intent, 'money');
  assert.deepEqual(ctx.calls, ['growth api/summary']);
  assert.match(out.say, /\$45\.50/);
  assert.match(out.say, /2 entries/);
  assert.equal(out.action, 'wag');
});

test('an app that is down is reported as down, not guessed at', async () => {
  const ctx = makeContext({ 'growth api/summary': { ok: false, status: 502, error: 'bad gateway' } });
  const out = await think('money', ctx);
  assert.equal(out.action, 'bark');
  assert.match(out.say, /502/);
});

test('"any trips?" lists casper\'s trips', async () => {
  const out = await think('any trips?', makeContext());
  assert.equal(out.intent, 'trips');
  assert.match(out.say, /Cape Town/);
});

test('the clip counter reports the number investors care about', async () => {
  const out = await think('how many clips?', makeContext());
  assert.equal(out.intent, 'clips');
  assert.match(out.say, /12,345 clips/);
});

test('claim-finder is summarised with both counts', async () => {
  const out = await think("who's claiming money?", makeContext());
  assert.equal(out.intent, 'claims');
  assert.match(out.say, /51 states/);
  assert.match(out.say, /0 claims/);
});

test('status names every app that is not answering', async () => {
  const out = await think('status', makeContext());
  assert.equal(out.intent, 'status');
  assert.equal(out.action, 'bark');
  assert.match(out.say, /4 of 5 up/);
  assert.match(out.say, /claims/);
});

test('"go to clips" wins over the clip counter', async () => {
  const out = await think('go to clips', makeContext());
  assert.equal(out.intent, 'goto');
  assert.equal(out.action, 'goto');
  assert.equal(out.data.mount, 'clips');
});

test('"scan growth" hands the target to the red-team console', async () => {
  const ctx = makeContext();
  const out = await think('scan growth', ctx);
  assert.equal(out.intent, 'scan');
  assert.deepEqual(ctx.calls, ['scan growth']);
  assert.match(out.say, /14 probes/);
  assert.equal(out.data.runId, 'run-1');
});

test('a scan the console refuses is reported honestly', async () => {
  const ctx = makeContext();
  ctx.scan = async () => ({ ok: false, error: 'a scan is already running' });
  const out = await think('scan growth', ctx);
  assert.equal(out.action, 'bark');
  assert.match(out.say, /already running/);
});

test('"read growth api/entries" fetches exactly that path', async () => {
  const ctx = makeContext({ 'growth api/entries': { ok: true, status: 200, data: [{ id: 1 }, { id: 2 }] } });
  const out = await think('read growth api/entries', ctx);
  assert.equal(out.intent, 'read');
  assert.deepEqual(ctx.calls, ['growth api/entries']);
  assert.match(out.say, /2 items/);
});

test('tricks work and fetch counts bones', async () => {
  const sit = await think('sit', makeContext());
  assert.equal(sit.action, 'sit');

  const ctx = makeContext();
  const fetched = await think('fetch', ctx);
  assert.match(fetched.say, /1 bone/);
  assert.equal(fetched.data.bones, 1);
});

test('an unknown command gets an honest answer, not a guess', async () => {
  const ctx = makeContext();
  const out = await think('reticulate the splines', ctx);
  assert.equal(out.intent, 'unknown');
  assert.match(out.say, /isn't in my trick book/);
  assert.deepEqual(out.report, HELP);
  assert.deepEqual(ctx.calls, [], 'an unknown command must not touch the fleet');
});

test('the dog only ever reads the fleet', async () => {
  // get() is the only fleet access an intent has; scan() is the one write-ish
  // action and it targets the red-team console, whose probes are read-only.
  const ctx = makeContext();
  for (const line of ['money', 'trips', 'clips', 'claims', 'status', 'read growth api/summary', 'scan casper']) {
    await think(line, ctx);
  }
  assert.deepEqual(ctx.calls.filter((c) => !/^(scan |\w+ )/.test(c)), []);
  for (const call of ctx.calls.filter((c) => !c.startsWith('scan '))) {
    const [mount, ...rest] = call.split(' ');
    assert.ok(FLEET.some((t) => t.mount === mount), `${call} uses a known app`);
    assert.ok(!rest.join(' ').includes('..'), `${call} does not climb out of the app`);
  }
});

test('an empty command still gets a wag', async () => {
  const out = await think('   ', makeContext());
  assert.equal(out.action, 'wag');
});
