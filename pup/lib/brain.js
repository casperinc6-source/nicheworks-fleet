/**
 * The dog's brain.
 *
 * A deterministic rule engine — no model, no API key, no network beyond the
 * fleet itself. It reads the siblings through the hub and never writes to them,
 * and an unknown command gets an honest "I don't know that" rather than a
 * confident guess.
 *
 * Every intent returns:
 *   say     what the dog says (speech bubble)
 *   action  what the body does: 'wag' | 'bark' | 'jump' | 'sit' | 'sleep' |
 *           'goto' | 'scan' | 'sniff'
 *   data    optional payload the UI can show
 *   report  optional list of lines (help)
 *   mood    optional mood override
 *
 * ctx (supplied by the server):
 *   fleet                 the fleet table
 *   get(mount, path)      read a fleet endpoint  → { ok, status, data, error }
 *   scan(mount)           start a red-team scan  → { ok, runId, probes, error }
 *   state                 { bones, mood, name }
 */

const HELP = [
  '"how\'s the money?" — growth totals',
  '"any trips?" — casper\'s trips',
  '"how many clips?" — the paperclip counter',
  '"who\'s claiming money?" — claim-finder\'s directory',
  '"status" — health of every app',
  '"scan growth" — start a red-team scan',
  '"read growth api/entries" — read any read-only path',
  '"go to clips" — run to that app',
  '"sit" / "roll over" / "speak" / "sleep" / "fetch"',
];

const money = (n) => `${Number(n) < 0 ? '-' : ''}$${Math.abs(Number(n) || 0).toFixed(2)}`;

/** Find a mount by exact name or by loose match ("paperclip" → clips). */
function mountOf(name, fleet) {
  const needle = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!needle) return null;
  const exact = fleet.find((t) => t.mount === needle);
  if (exact) return exact.mount;
  const loose = fleet.find((t) => {
    const haystack = `${t.mount}${t.name}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    return haystack.includes(needle) || needle.includes(t.mount);
  });
  return loose ? loose.mount : null;
}

function summarizeTrip(trip) {
  return trip.name || trip.destination || trip.title || trip.trip_id || null;
}

const INTENTS = [
  {
    id: 'greet',
    test: /^(hi|hey|hello|yo|morning|good boy|who'?s a good boy)\b/,
    run: () => ({ say: 'Woof! Tail already going. What are we doing?', action: 'wag' }),
  },
  {
    id: 'help',
    test: /^(help|what can you do|commands?|what do you know)\b/,
    run: () => ({ say: 'I know every app in the house:', action: 'sit', report: HELP }),
  },

  // Actions that name a target come first: "go to clips" must not fall through
  // to the clip counter.
  {
    id: 'goto',
    test: /^(?:go to|open|show me|take me to|navigate to|run to)\s+(.+)$/,
    run: (ctx, match) => {
      const mount = mountOf(match[1], ctx.fleet);
      if (!mount) return { say: `No app called "${match[1].trim()}" in this house.`, action: 'sit', report: HELP };
      const target = ctx.fleet.find((t) => t.mount === mount);
      return { say: `Bolting to ${target.name}. See you there!`, action: 'goto', data: { url: `/${mount}/`, mount } };
    },
  },
  {
    id: 'read',
    test: /^(?:read|fetch|get|look at|check)\s+(\S+)\s+(\S+)$/,
    run: async (ctx, match) => {
      const mount = mountOf(match[1], ctx.fleet);
      if (!mount) return { say: `I don't know an app called "${match[1].trim()}".`, action: 'sit' };
      const path = match[2].replace(/^\/+/, '');
      const result = await ctx.get(mount, path);
      if (!result.ok) return { say: `${mount}/${path} answered ${result.status ?? result.error}. Bad smell.`, action: 'bark' };
      const data = result.data;
      const shape = data === null || data === undefined
        ? 'empty'
        : Array.isArray(data) ? `${data.length} items` : `${Object.keys(data).length} fields`;
      const preview = data === null || data === undefined ? 'nothing stored yet' : JSON.stringify(data).slice(0, 220);
      return {
        say: `${mount}/${path} → ${shape}: ${preview}`,
        action: 'sniff',
        data,
      };
    },
  },
  {
    id: 'scan',
    test: /^(?:scan|probe|red ?team|sniff out|test)\s+(.+)$/,
    run: async (ctx, match) => {
      const mount = mountOf(match[1], ctx.fleet);
      if (!mount) return { say: `Nothing called "${match[1].trim()}" to sniff.`, action: 'sit' };
      const scan = await ctx.scan(mount);
      if (!scan.ok) return { say: `I can't start a scan: ${scan.error}`, action: 'bark' };
      return {
        say: `${scan.probes} probes heading at /${mount}/. I'll bark when the report lands.`,
        action: 'scan',
        data: { runId: scan.runId, mount },
      };
    },
  },

  {
    id: 'status',
    test: /\b(status|health|healthy|who'?s up|what'?s up|fleet|everything (?:up|ok|alright))\b/,
    run: (ctx) => {
      const down = ctx.fleet.filter((t) => !t.health?.up);
      if (!ctx.fleet.length) return { say: 'I can smell no apps at all. Spooky.', action: 'bark' };
      return {
        say: down.length
          ? `${ctx.fleet.length - down.length} of ${ctx.fleet.length} up. Not answering: ${down.map((t) => t.mount).join(', ')}.`
          : `All ${ctx.fleet.length} apps are up. Good house.`,
        action: down.length ? 'bark' : 'wag',
        data: ctx.fleet.map((t) => ({ mount: t.mount, up: Boolean(t.health?.up) })),
      };
    },
  },
  {
    id: 'claims',
    test: /\b(claims?|claiming|unclaimed|money owed|treasury|auctions?)\b/,
    run: async (ctx) => {
      const result = await ctx.get('claims', 'api/states');
      if (!result.ok) return { say: `ClaimFinder is out (${result.status ?? result.error}).`, action: 'bark' };
      const states = result.data?.states || [];
      const tracked = await ctx.get('claims', 'api/claims');
      const mine = tracked.ok && Array.isArray(tracked.data) ? tracked.data.length : 0;
      return {
        say: `${states.length} states on file, ${mine} claim${mine === 1 ? '' : 's'} in your tracker.`,
        action: 'sniff',
        data: { states: states.length, tracked: mine },
      };
    },
  },
  {
    // "who's claiming money?" is about claim-finder, so this intent stands down
    // whenever the sentence is about a claim.
    id: 'money',
    test: /^(?!.*unclaimed)(?!.*\bclaim(?:s|ing|ed)?\b).*\b(money|growth|income|revenue|profit|books|cash)\b/,
    run: async (ctx) => {
      const result = await ctx.get('growth', 'api/summary');
      if (!result.ok) return { say: `I scratched at /growth/ and got ${result.status ?? result.error}.`, action: 'bark' };
      const d = result.data;
      return {
        say: `Net ${money(d.net)} across ${d.entries} ${d.entries === 1 ? 'entry' : 'entries'} — ${money(d.income)} in, ${money(d.expense)} out.`,
        action: 'wag',
        data: d,
      };
    },
  },
  {
    id: 'trips',
    test: /\b(trips?|travel|bookings?|casper|flights?|hotel)\b/,
    run: async (ctx) => {
      const result = await ctx.get('casper', 'api/trips');
      if (!result.ok) return { say: `Casper isn't answering (${result.status ?? result.error}).`, action: 'bark' };
      const names = result.data.map(summarizeTrip).filter(Boolean);
      return {
        say: names.length ? `${names.length} trips: ${names.slice(0, 4).join(', ')}.` : 'No trips on the board.',
        action: 'jump',
        data: result.data,
      };
    },
  },
  {
    id: 'clips',
    test: /\b(clips?|paperclips?|factory)\b/,
    run: async (ctx) => {
      const result = await ctx.get('clips', 'api/state');
      if (!result.ok) return { say: `The clip factory is quiet (${result.status ?? result.error}).`, action: 'bark' };
      const count = Number(result.data?.clips ?? result.data?.count ?? 0);
      return { say: `${count.toLocaleString('en-US')} clips. Everything is clips.`, action: 'wag', data: result.data };
    },
  },

  { id: 'sit', test: /^(sit|stay|heel)\b/, run: () => ({ say: 'Sitting. Watching. Judging, slightly.', action: 'sit' }) },
  { id: 'rollover', test: /^(roll over|roll|spin)\b/, run: () => ({ say: 'Rolled. Twice. Nobody saw.', action: 'jump' }) },
  { id: 'speak', test: /^(speak|bark|say something)\b/, run: () => ({ say: 'WOOF.', action: 'bark' }) },
  { id: 'sleep', test: /^(sleep|nap|rest|tired)\b/, run: () => ({ say: 'Curling up by the router.', action: 'sleep' }) },
  {
    id: 'fetch',
    test: /^(fetch|ball|treat|good boy|toy)\b/,
    run: (ctx) => {
      const bones = (ctx.state.bones || 0) + 1;
      return { say: `Fetched! That's ${bones} bone${bones === 1 ? '' : 's'} in the pile.`, action: 'jump', data: { bones } };
    },
  },
];

/**
 * Turn a line of human into an action.
 * ctx: { fleet, get, scan, state }
 */
async function think(text, ctx) {
  const input = String(text || '').trim();
  if (!input) return { intent: 'unknown', say: 'You said nothing. I wagged anyway.', action: 'wag' };

  for (const intent of INTENTS) {
    const match = input.toLowerCase().match(intent.test);
    if (!match) continue;
    const result = await intent.run(ctx, match);
    return { intent: intent.id, ...result };
  }

  return {
    intent: 'unknown',
    say: `"${input}" isn't in my trick book. Here's what I do know:`,
    action: 'sit',
    report: HELP,
  };
}

module.exports = { INTENTS, HELP, think, mountOf };
