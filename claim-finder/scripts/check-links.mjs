#!/usr/bin/env node
// Liveness check for every link in sources.js.
//   node scripts/check-links.mjs
// Runs with concurrency 8 so it finishes fast. Usage is manual (the app
// itself makes no outbound calls): a link found dead here should be fixed
// in sources.js. The app always offers the NAUPA master finder
// (https://unclaimed.org/search/) as the official fallback.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { STATES, AUCTIONS, NAUPA, MISSINGMONEY } = require('../sources.js');

const targets = [
  ...STATES.map(([code, name, url]) => [code, url]),
  ...AUCTIONS.map(([name, url]) => [name, url]),
  ['NAUPA', NAUPA],
  ['MissingMoney', MISSINGMONEY],
];

const TIMEOUT = 10_000;
const CONCURRENCY = 8;
let bad = 0;

async function check([label, url]) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) claim-finder-linkcheck/0.2' },
    });
    const ok = res.status < 400;
    console.log(`${ok ? 'OK  ' : 'DEAD'} ${String(res.status).padEnd(3)} ${label.padEnd(4)} ${url}`);
    if (!ok) bad++;
  } catch (e) {
    console.log(`ERR     ${label.padEnd(4)} ${url}  (${e.cause?.code || e.name})`);
    bad++;
  }
}

const queue = [...targets];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) await check(queue.shift());
}));

console.log(bad ? `\n${bad} unreachable/blocked link(s) — verify in a browser, fix sources.js` : '\nAll links live.');
process.exit(bad ? 1 : 0);
