/**
 * fuse-hub smoke test.
 *
 * Boots the real hub (and therefore every sibling app) on throwaway ports,
 * then walks each mount the way a browser would. The point is the proxy: for
 * every app that has an API, the response through /<mount>/ must be the same
 * JSON the app returns when asked directly.
 *
 * Zero dependencies, like the hub itself: `npm test`.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

// Mirrors APPS in server.js. The env names are the contract that lets this
// test (or a second copy of the fleet) run beside an already-running hub.
const EXPECTED = [
  {
    mount: 'growth', env: 'PORT_GROWTH', api: 'api/summary',
    check: (d) => typeof d.net === 'number' && Array.isArray(d.curve),
  },
  {
    mount: 'casper', env: 'PORT_CASPER', api: 'api/trips',
    check: (d) => Array.isArray(d) && d.length > 0,
  },
  { mount: 'cobra', env: 'PORT_COBRA', marker: 'beige-cobras-scream' },
  { mount: 'conway', env: 'PORT_CONWAY', marker: 'Game of Life' },
  { mount: 'bots', env: 'PORT_BOTS', marker: 'survivalbots' },
  {
    mount: 'clips', env: 'PORT_CLIPS', api: 'api/state',
    check: (d) => d === null || (typeof d === 'object' && d !== null),
  },
  { mount: 'jarvis', env: 'PORT_JARVIS', marker: 'JARVIS' },
  {
    mount: 'claims', env: 'PORT_CLAIMS', api: 'api/states',
    check: (d) => Array.isArray(d.states) && d.count === d.states.length,
  },
  // The red-team console has no API of its own to compare against the app
  // directly (its JSON carries timestamps), so it is checked by the dedicated
  // tests below — including that the hub handed it the real mount table.
  { mount: 'redteam', env: 'PORT_REDTEAM', marker: 'fleet hardening console' },
  { mount: 'pup', env: 'PORT_PUP', marker: 'the little dog on the hub' },
  { mount: 'watchtower', env: 'PORT_WATCHTOWER', marker: 'security audit as a service' },
  { mount: 'loom', env: 'PORT_LOOM', marker: 'generative pattern studio' },
  { mount: 'keysmith', env: 'PORT_KEYSMITH', marker: 'post-quantum readiness' },
  { mount: 'deception', env: 'PORT_DECEPTION', marker: 'the trap room' },
  { mount: 'agentzero', env: 'PORT_AGENTZERO', marker: 'the king of the fleet' },
  { mount: 'vault', env: 'PORT_VAULT', marker: 'offline file storage' },
  { mount: 'reader', env: 'PORT_READER', marker: 'private reader' },
  { mount: 'esim', env: 'PORT_ESIM', marker: 'travel data' },
  { mount: 'krypt', env: 'PORT_KRYPT', marker: 'live crypto market' },
  { mount: 'saluki', env: 'PORT_SALUKI', marker: 'Underdog Saluki' },
  { mount: 'poe', env: 'PORT_POE', marker: 'multi-model chat' },
  { mount: 'ultron', env: 'PORT_ULTRON', marker: 'adversary simulator' },
  { mount: 'ruflow', env: 'PORT_RUFLOW', marker: 'runnable flows' },
  { mount: 'exelo', env: 'PORT_EXELO', marker: 'deploy an AI employee' },
  { mount: 'revenue', env: 'PORT_REVENUE', marker: 'own books' },
];

let hub;
let hubPort;
let hubLog = '';
let hubExit = null;

/** Reserve `count` ports and release them, all at once, so none repeat. */
async function freePorts(count) {
  const servers = [];
  try {
    for (let i = 0; i < count; i += 1) {
      servers.push(await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => resolve(srv));
      }));
    }
    const ports = servers.map((srv) => srv.address().port);
    await Promise.all(servers.map((srv) => new Promise((resolve) => srv.close(resolve))));
    return ports;
  } catch (error) {
    for (const srv of servers) srv.close();
    throw error;
  }
}

async function get(url) {
  const res = await fetch(url, { redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML pages are expected too */ }
  return { status: res.status, headers: res.headers, text, json };
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `${label} did not happen within ${timeoutMs}ms` +
    (lastError ? ` (last error: ${lastError.message})` : '') +
    `\n--- hub output ---\n${hubLog}`,
  );
}

const hubUrl = (p = '/') => `http://127.0.0.1:${hubPort}${p}`;
const appUrl = (app, p = '/') => `http://127.0.0.1:${app.port}${p}`;

before(async () => {
  const ports = await freePorts(EXPECTED.length + 1);
  hubPort = ports[0];
  EXPECTED.forEach((app, i) => { app.port = ports[i + 1]; });

  const env = { ...process.env, PORT: String(hubPort) };
  for (const app of EXPECTED) env[app.env] = String(app.port);

  hub = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hub.stdout.on('data', (d) => { hubLog += d; });
  hub.stderr.on('data', (d) => { hubLog += d; });
  hub.on('exit', (code, signal) => { hubExit = { code, signal }; });

  await waitFor(
    async () => (await get(hubUrl('/healthz'))).status === 200,
    15_000,
    'hub /healthz',
  );

  // Every child needs to be listening before the proxy can answer.
  await waitFor(async () => {
    const statuses = await Promise.all(
      EXPECTED.map(async (app) => (await get(hubUrl(`/${app.mount}/`))).status),
    );
    return statuses.every((status) => status === 200);
  }, 25_000, 'all mounts to answer 200');
}, { timeout: 40_000 });

after(async () => {
  if (!hub || hubExit) return;
  hub.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { hub.kill('SIGKILL'); resolve(); }, 3_000);
    hub.once('exit', () => { clearTimeout(timer); resolve(); });
  });
});

test('healthz reports a live hub with every app', async () => {
  // `apps` is configured; `ready` is listening. Both matter, and they are not
  // the same number while children are still binding — so poll for ready.
  await waitFor(async () => {
    const probe = await get(hubUrl('/healthz'));
    return probe.json.ready === EXPECTED.length;
  }, 12_000, 'healthz to report every configured app ready');

  const res = await get(hubUrl('/healthz'));
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.apps, EXPECTED.length);
  assert.equal(res.json.ready, EXPECTED.length, 'ready counts listening children');
  assert.equal(res.json.down, 0, 'no app should be down');
  assert.equal(res.json.starting, 0, 'no app should still be starting');
  assert.equal(
    res.json.ready + res.json.starting + res.json.down,
    res.json.apps,
    'every configured app is in exactly one state',
  );
});

test('the landing page links every mount and sees every app up', async () => {
  await waitFor(async () => {
    const { text } = await get(hubUrl('/'));
    const badges = [...text.matchAll(/<tr><td>([^<]+)<\/td>/g)].map((m) => m[1].trim());
    return badges.length === EXPECTED.length && badges.every((b) => b === '🟢');
  }, 12_000, 'every app to report 🟢 on the landing page');

  const { text } = await get(hubUrl('/'));
  for (const app of EXPECTED) {
    assert.match(text, new RegExp(`href="/${app.mount}/"`), `landing links /${app.mount}/`);
  }
});

test('every mount redirects to its trailing-slash form', async () => {
  for (const app of EXPECTED) {
    const res = await get(hubUrl(`/${app.mount}`));
    assert.equal(res.status, 301, `/${app.mount} should redirect`);
    assert.equal(res.headers.get('location'), `/${app.mount}/`);
  }
});

test('every mount serves its app page through the proxy', async () => {
  for (const app of EXPECTED) {
    const res = await get(hubUrl(`/${app.mount}/`));
    assert.equal(res.status, 200, `/${app.mount}/ status`);
    assert.match(res.headers.get('content-type') || '', /text\/html/, `/${app.mount}/ content-type`);
    if (app.marker) {
      assert.ok(res.text.includes(app.marker), `/${app.mount}/ should contain ${JSON.stringify(app.marker)}`);
    }
  }
});

test('proxied APIs match the apps answering directly', async () => {
  for (const app of EXPECTED.filter((a) => a.api)) {
    const viaHub = await get(hubUrl(`/${app.mount}/${app.api}`));
    const direct = await get(appUrl(app, `/${app.api}`));

    assert.equal(viaHub.status, 200, `/${app.mount}/${app.api} status`);
    assert.match(
      viaHub.headers.get('content-type') || '',
      /application\/json/,
      `/${app.mount}/${app.api} content-type`,
    );
    assert.deepEqual(
      viaHub.json,
      direct.json,
      `/${app.mount}/${app.api} should be the app's own JSON, not a hub error`,
    );
    assert.ok(app.check(viaHub.json), `/${app.mount}/${app.api} has the expected shape`);
  }
});

test('the red-team console is pointed at this hub\'s own mounts', async () => {
  const res = await get(hubUrl('/redteam/api/targets'));
  assert.equal(res.status, 200, '/redteam/api/targets status');
  assert.deepEqual(
    res.json.targets.map((t) => t.mount).sort(),
    EXPECTED.filter((a) => a.mount !== 'redteam').map((a) => a.mount).sort(),
    'the console should target every sibling mount',
  );
  for (const target of res.json.targets) {
    const app = EXPECTED.find((a) => a.mount === target.mount);
    assert.equal(
      target.base,
      `http://127.0.0.1:${app.port}`,
      `/redteam should probe ${target.mount} on the port this hub gave it`,
    );
  }
});

test('the red-team console serves a probe suite for a chosen target', async () => {
  const growth = EXPECTED.find((a) => a.mount === 'growth');
  const res = await get(hubUrl('/redteam/api/suite?target=growth'));
  assert.equal(res.status, 200, '/redteam/api/suite status');
  assert.equal(res.json.target.base, `http://127.0.0.1:${growth.port}`);
  assert.ok(res.json.probes.length >= 10, 'the suite should carry every probe');
  assert.ok(
    res.json.probes.some((p) => p.id === 'traversal-encoded' && p.checks.includes('noFileLeak')),
    'the traversal probe should be in the suite',
  );
  assert.ok(res.json.probes.every((p) => p.checks.length > 0), 'every probe needs a check');
});

test('the dog is house-trained on this hub\'s mounts', async () => {
  const res = await get(hubUrl('/pup/api/state'));
  assert.equal(res.status, 200, '/pup/api/state status');
  const siblings = EXPECTED.filter((a) => a.mount !== 'pup');
  assert.deepEqual(
    res.json.fleet.map((t) => t.mount).sort(),
    siblings.map((a) => a.mount).sort(),
    'the dog should know every sibling app',
  );
  for (const target of res.json.fleet) {
    const app = EXPECTED.find((a) => a.mount === target.mount);
    assert.equal(target.base, `http://127.0.0.1:${app.port}`, `/pup should watch ${target.mount} on the port this hub gave it`);
  }
  assert.ok(res.json.up > 0, 'the dog should see at least one app up');
});

test('a command makes the dog read a real sibling app', async () => {
  const res = await fetch(hubUrl('/pup/api/command'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: "how's the money?" }),
  });
  assert.equal(res.status, 200, '/pup/api/command status');
  const outcome = await res.json();
  assert.equal(outcome.intent, 'money');
  assert.match(outcome.say, /Net \$/, `expected growth totals, got: ${outcome.say}`);

  // …and the numbers must be the app's, not the dog's imagination.
  const direct = await get(appUrl(EXPECTED.find((a) => a.mount === 'growth'), '/api/summary'));
  const net = `${direct.json.net < 0 ? '-' : ''}$${Math.abs(direct.json.net).toFixed(2)}`;
  assert.ok(outcome.say.includes(net), `${outcome.say} should include growth's net ${net}`);
});

test('the dog only reads the fleet, and cannot be talked into a traversal', async () => {
  const write = await fetch(hubUrl('/pup/api/fleet/growth/api/entries'), { method: 'DELETE' });
  assert.equal(write.status, 405, 'the dog must refuse anything but GET');

  const climbed = await get(hubUrl('/pup/api/fleet/growth/%2e%2e%2f%2e%2e%2fetc%2fpasswd'));
  assert.equal(climbed.status, 400, 'a path that leaves the app must be refused by the dog');
  assert.match(String(climbed.json.error || ''), /refusing to leave the app/);
  assert.doesNotMatch(climbed.text, /root:x:0:0:/);

  const unknown = await get(hubUrl('/pup/api/fleet/nope/api/state'));
  assert.equal(unknown.status, 404, 'an unknown app is not proxied');
});

test('pages do not call APIs at the host root, which the hub does not serve', async () => {
  // fetch('/api/...') from a page under /growth/ would hit the hub itself and
  // 404. Two safe shapes: a relative URL ('api/...'), or a helper that prepends
  // the mount (claim-finder's API_BASE). A bare '/api/...' is a bug either way.
  const mountAwareHelper = /const\s+api\s*=\s*\(p\)\s*=>\s*API_BASE\s*\+\s*p/;
  const directCall = /(?:fetch|sendBeacon|EventSource)\(\s*['"`]\/(?!\/)/g;
  const helperCall = /\bapi\(\s*['"`]\/(?!\/)/g;

  for (const app of EXPECTED) {
    const { text } = await get(hubUrl(`/${app.mount}/`));
    const patterns = mountAwareHelper.test(text) ? [directCall] : [directCall, helperCall];
    const offenders = patterns.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
    assert.deepEqual(offenders, [], `/${app.mount}/ makes root-absolute API calls: ${offenders.join(', ')}`);
  }
});
