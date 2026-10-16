// node --test scripts/health-check.test.mjs  (no network: fetch is faked)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CORE_PROGRAM,
  FISH_META_PATH,
  FISH_NAME,
  QUIET_MS,
  TOKEN_PROGRAM,
  decideIssueAction,
  evaluate,
  fetchRetry,
  issueState,
  marker,
  readMarker,
  runChecks,
} from './health-check.mjs';

const MARKET = '12b3GY2Pbh4HnNaLqL7GszmeFrcrfiULwfLz5HcF7gRd';
const MINT = '3aX1muNxajg9VuxfigrVk2f7dGdCedJ67kUsAqCc9drp';
const COLL = 'AB2Wss9G1w246PoTWc6CQQ4pKnxQKeY1vC6MmyCYvkx5';
const SITE = 'https://site.test';
const RPC = 'https://rpc.test/';
const IMG = `${SITE}/api/nft/img/v2/26/x.png?r=3`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const noWait = { sleep: async () => {} };

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** A healthy production; `over` replaces any route's answer: (url, init) => Response | undefined. */
function fakeFetch({ lamports = 5_424_959_587, mintAuthority = MARKET, info = {}, rpc, over } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const o = over?.(u, init);
    if (o) return typeof o === 'function' ? o() : o;
    if (u === RPC) {
      if (rpc) return rpc();
      return json({
        result: {
          value: [
            { lamports, owner: '11111111111111111111111111111111' },
            { lamports: 1_066_800, owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { isInitialized: true, mintAuthority, supply: '15807', decimals: 0 } } } },
            { lamports: 1, owner: CORE_PROGRAM },
          ],
        },
      });
    }
    const path = u.slice(SITE.length);
    if (path === '/') return new Response('<title>屏息 Breathless</title><canvas id="scene"></canvas>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (path === '/api/market/info') return json({ mode: 'server', market: MARKET, pearlMint: MINT, fishCollection: COLL, tokenProgram: TOKEN_PROGRAM, funded: true, ...info });
    if (path === FISH_META_PATH) return json({ name: FISH_NAME, image: IMG });
    if (u === IMG) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    if (path === '/api/cron/sweep') return json({ error: 'Unauthorized' }, 401);
    return new Response('not found', { status: 404 });
  };
  f.calls = calls;
  return f;
}

const run = (f) => runChecks({ fetch: f, site: SITE, rpc: RPC, retry: noWait });
const byName = (results) => Object.fromEntries(results.map((r) => [r.name, r]));

test('a healthy production passes every check', async () => {
  const results = await run(fakeFetch());
  assert.deepEqual(results.map((r) => [r.name, r.status]), [
    ['site', 'ok'],
    ['market-info', 'ok'],
    ['market-sol', 'ok'],
    ['pearl-mint', 'ok'],
    ['fish-collection', 'ok'],
    ['nft-meta', 'ok'],
    ['nft-image', 'ok'],
    ['cron-route', 'ok'],
  ]);
  assert.deepEqual(evaluate(results), { ok: true, failing: [], unknown: [], summary: 'All 8 checks OK' });
});

test('market SOL: warn below 0.5, critical below 0.02', async () => {
  assert.equal(byName(await run(fakeFetch({ lamports: 0.3e9 })))['market-sol'].status, 'warn');
  assert.equal(byName(await run(fakeFetch({ lamports: 0.01e9 })))['market-sol'].status, 'fail');
  assert.equal(byName(await run(fakeFetch({ lamports: 0.5e9 })))['market-sol'].status, 'ok');
});

test('an unreachable RPC is its own state, retried 3 times, and opens no issue', async () => {
  let n = 0;
  const f = fakeFetch({ rpc: () => (n++, new Response('rate limited', { status: 429 })) });
  const results = await run(f);
  assert.equal(n, 3);
  const r = byName(results);
  for (const name of ['market-sol', 'pearl-mint', 'fish-collection']) assert.equal(r[name].status, 'rpc-unreachable');
  const v = evaluate(results);
  assert.equal(v.ok, true);
  assert.deepEqual(v.failing, []);
  assert.equal(v.unknown.length, 3);
});

test('a 429 or 5xx is retried; a definitive answer is not', async () => {
  let n = 0;
  const flaky = async () => (++n < 3 ? new Response('', { status: n === 1 ? 503 : 429 }) : new Response('ok'));
  assert.equal((await fetchRetry(flaky, 'x', {}, noWait)).status, 200);
  assert.equal(n, 3);
  let m = 0;
  const unauthorized = async () => (m++, new Response('', { status: 401 }));
  assert.equal((await fetchRetry(unauthorized, 'x', {}, noWait)).status, 401);
  assert.equal(m, 1);
  let k = 0;
  const down = async () => {
    k++;
    throw new TypeError('fetch failed');
  };
  await assert.rejects(fetchRetry(down, 'x', {}, noWait), /fetch failed/);
  assert.equal(k, 3);
});

test('PEARL: the market must be the mint authority (it mints payouts, it holds no PEARL)', async () => {
  const r = byName(await run(fakeFetch({ mintAuthority: 'someoneElse' })));
  assert.equal(r['pearl-mint'].status, 'fail');
  assert.match(r['pearl-mint'].detail, /mint authority/);
});

test('market info: wrong mode, missing fields, or funded:false fail; the chain checks are skipped without it', async () => {
  assert.equal(byName(await run(fakeFetch({ info: { mode: 'program' } })))['market-info'].status, 'fail');
  assert.equal(byName(await run(fakeFetch({ info: { funded: false } })))['market-info'].status, 'fail');
  // The server's own RPC call 429'd once: funded:false, then true on the next ask.
  let asks = 0;
  const flaky = fakeFetch({ info: { get funded() { return ++asks > 1; } } });
  assert.equal(byName(await run(flaky))['market-info'].status, 'ok');
  assert.equal(asks, 2);
  const r = byName(await run(fakeFetch({ info: { pearlMint: null } })));
  assert.equal(r['market-info'].status, 'fail');
  assert.equal(r['market-sol'].status, 'skipped');
  const down = byName(await run(fakeFetch({ over: (u) => (u.endsWith('/api/market/info') ? new Response('boom', { status: 500 }) : undefined) })));
  assert.equal(down['market-info'].status, 'fail');
  assert.deepEqual(evaluate(Object.values(down)).failing, ['market-info:fail']);
});

test('site, NFT routes and the cron route', async () => {
  const notGame = byName(await run(fakeFetch({ over: (u) => (u === `${SITE}/` ? new Response('<html>Vercel 404</html>', { headers: { 'content-type': 'text/html' } }) : undefined) })));
  assert.equal(notGame.site.status, 'fail');
  const htmlImage = byName(await run(fakeFetch({ over: (u) => (u === IMG ? new Response('<html>', { headers: { 'content-type': 'text/html' } }) : undefined) })));
  assert.equal(htmlImage['nft-image'].status, 'fail');
  const noMeta = byName(await run(fakeFetch({ over: (u) => (u.endsWith('.json') ? new Response('nope', { status: 404 }) : undefined) })));
  assert.equal(noMeta['nft-meta'].status, 'fail');
  assert.equal(noMeta['nft-image'].status, 'skipped');
  const openCron = byName(await run(fakeFetch({ over: (u) => (u.endsWith('/api/cron/sweep') ? json({ swept: true }) : undefined) })));
  assert.equal(openCron['cron-route'].status, 'fail');
});

test('evaluate sorts the failing set and keeps warn apart from fail', () => {
  const v = evaluate([
    { name: 'site', status: 'fail', detail: '' },
    { name: 'market-sol', status: 'warn', detail: '' },
    { name: 'pearl-mint', status: 'rpc-unreachable', detail: '' },
  ]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.failing, ['market-sol:warn', 'site:fail']);
  assert.deepEqual(v.unknown, ['pearl-mint:rpc-unreachable']);
  assert.equal(v.summary, 'Failing: market-sol:warn, site:fail');
});

test('the marker round-trips, including an empty set', () => {
  assert.deepEqual(readMarker(`x\n${marker(['a:fail', 'b:warn'])}`), ['a:fail', 'b:warn']);
  assert.deepEqual(readMarker(marker([])), []);
  assert.equal(readMarker('no marker here'), null);
});

test('issue actions: open, comment on change, remind after 6 h, close on recovery', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const issue = (lastFailing, agoMs) => ({ number: 7, lastFailing, lastAt: now - agoMs });
  assert.equal(decideIssueAction({ issue: null, failing: [], now }).action, 'none');
  assert.equal(decideIssueAction({ issue: null, failing: ['site:fail'], now }).action, 'open');
  assert.equal(decideIssueAction({ issue: issue(['site:fail'], 60_000), failing: ['site:fail'], now }).action, 'none');
  assert.equal(decideIssueAction({ issue: issue(['site:fail'], QUIET_MS - 1), failing: ['site:fail'], now }).action, 'none');
  assert.equal(decideIssueAction({ issue: issue(['site:fail'], QUIET_MS), failing: ['site:fail'], now }).action, 'comment');
  assert.equal(decideIssueAction({ issue: issue(['market-sol:warn'], 60_000), failing: ['market-sol:fail'], now }).action, 'comment');
  assert.equal(decideIssueAction({ issue: issue(['a:fail'], 60_000), failing: ['a:fail', 'b:fail'], now }).action, 'comment');
  assert.equal(decideIssueAction({ issue: issue(null, 60_000), failing: ['a:fail'], now }).action, 'comment');
  assert.equal(decideIssueAction({ issue: issue(['site:fail'], 60_000), failing: [], now }).action, 'close');
});

test('issueState takes the newest marker, ignoring comments without one', () => {
  const s = issueState({
    number: 3,
    body: `opened\n${marker(['site:fail'])}`,
    createdAt: '2026-10-15T00:00:00Z',
    comments: [
      { body: marker(['market-sol:warn']), createdAt: '2026-10-15T02:00:00Z' },
      { body: 'a human says hi', createdAt: '2026-10-15T03:00:00Z' },
    ],
  });
  assert.deepEqual(s, { number: 3, lastFailing: ['market-sol:warn'], lastAt: Date.parse('2026-10-15T02:00:00Z') });
});
