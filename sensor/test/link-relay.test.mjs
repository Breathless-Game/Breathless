import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { staticHandler } from '../static.mjs';
import { LINK_BODY_LIMIT, LINK_CREATES_PER_MIN, LINK_TTL_MS, createLinkHandler } from '../link-relay.mjs';
import { createMemoryKv, createRedisKv } from '../market-store.mjs';
import { createVercelHandler } from '../vercel-handler.mjs';
import { createFakeRedis } from './fake-redis.mjs';

// The desktop app's wallet relay (link-relay.mjs), on both KVs the servers give it: the Dell's
// memory map and Vercel's Redis (here the fake). Tokens, first-result-wins, expiry, limits.

const OWNER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const TX = Buffer.alloc(200, 7).toString('base64');
const SIG = Buffer.alloc(64, 9).toString('base64');
const NONCE = 'n0nce-n0nce-n0nce-123';

async function serve(handler, fn) {
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const KVS = {
  memory: (clock) => createMemoryKv({ now: () => clock.now }),
  redis: (clock) => createRedisKv(createFakeRedis({ now: () => clock.now }), 'test:'),
};

for (const [name, makeKv] of Object.entries(KVS)) {
  /** A relay on a fresh KV, with a clock the test moves and one IP per test unless told otherwise. */
  async function withRelay(fn, { ip = () => '203.0.113.7' } = {}) {
    const clock = { now: 1_700_000_000_000 };
    const kv = makeKv(clock);
    const handler = createLinkHandler({ kv, clientIp: ip, log: () => {}, now: () => clock.now });
    return serve(handler, (base) => {
      const call = async (method, path, { body, page, app, raw } = {}) => {
        const headers = {};
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (page) headers['x-link-token'] = page;
        if (app) headers.authorization = `Bearer ${app}`;
        const res = await fetch(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
      };
      const open = async (kind = 'sign', payload = kind === 'sign' ? { owner: OWNER, txs: [TX, TX] } : { nonce: NONCE }) => {
        const r = await call('POST', '/api/link', { body: { kind, payload } });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        return r.body;
      };
      return fn({ call, open, clock, kv });
    });
  }

  test(`${name}: a sign session end to end`, () =>
    withRelay(async ({ call, open, clock }) => {
      const s = await open();
      assert.match(s.sid, /^[A-Za-z0-9_-]{43}$/);
      assert.match(s.appToken, /^[A-Za-z0-9_-]{43}$/);
      assert.match(s.pageToken, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(s.appToken, s.pageToken);
      assert.match(s.matchCode, /^\d{4}$/);
      assert.equal(s.expiresAt, clock.now + LINK_TTL_MS);

      const page = await call('GET', `/api/link/${s.sid}`, { page: s.pageToken });
      assert.equal(page.status, 200);
      assert.deepEqual(page.body, { kind: 'sign', payload: { owner: OWNER, txs: [TX, TX], keepBlockhash: false }, matchCode: s.matchCode, expiresAt: s.expiresAt });
      assert.equal(page.headers.get('cache-control'), 'no-store');

      assert.deepEqual((await call('GET', `/api/link/${s.sid}/result`, { app: s.appToken })).body, { status: 'pending', expiresAt: s.expiresAt });
      const result = { txs: [TX, TX], blockhash: OWNER, lastValidBlockHeight: 123 };
      assert.equal((await call('POST', `/api/link/${s.sid}/result`, { page: s.pageToken, body: result })).status, 200);
      const got = await call('GET', `/api/link/${s.sid}/result`, { app: s.appToken });
      assert.deepEqual(got, { ...got, status: 200, body: { status: 'done', result } });
      // Handed over once: then the session is gone.
      assert.equal((await call('GET', `/api/link/${s.sid}/result`, { app: s.appToken })).status, 404);
      assert.equal((await call('GET', `/api/link/${s.sid}`, { page: s.pageToken })).status, 404);
    }));

  test(`${name}: a connect session`, () =>
    withRelay(async ({ call, open }) => {
      const s = await open('connect');
      assert.deepEqual((await call('GET', `/api/link/${s.sid}`, { page: s.pageToken })).body.payload, { nonce: NONCE });
      const bad = await call('POST', `/api/link/${s.sid}/result`, { page: s.pageToken, body: { publicKey: OWNER, signature: 'short' } });
      assert.equal(bad.status, 400);
      assert.equal((await call('POST', `/api/link/${s.sid}/result`, { page: s.pageToken, body: { publicKey: OWNER, signature: SIG } })).status, 200);
      assert.deepEqual((await call('GET', `/api/link/${s.sid}/result`, { app: s.appToken })).body, { status: 'done', result: { publicKey: OWNER, signature: SIG } });
    }));

  test(`${name}: wrong or missing tokens get nothing`, () =>
    withRelay(async ({ call, open }) => {
      const s = await open();
      const other = await open();
      for (const page of [undefined, '', 'x', s.appToken, other.pageToken]) {
        assert.equal((await call('GET', `/api/link/${s.sid}`, { page })).status, 401, `page ${page}`);
        assert.equal((await call('POST', `/api/link/${s.sid}/result`, { page, body: { txs: [TX, TX] } })).status, 401);
        assert.equal((await call('POST', `/api/link/${s.sid}/cancel`, { page })).status, 401);
      }
      for (const app of [undefined, 'x', s.pageToken, other.appToken]) {
        assert.equal((await call('GET', `/api/link/${s.sid}/result`, { app })).status, 401, `app ${app}`);
        assert.equal((await call('DELETE', `/api/link/${s.sid}`, { app })).status, 401);
      }
      // An unknown or malformed session: 404.
      assert.equal((await call('GET', `/api/link/${'A'.repeat(43)}`, { page: s.pageToken })).status, 404);
      assert.equal((await call('GET', '/api/link/..%2F..%2Fetc', { page: s.pageToken })).status, 404);
      assert.equal((await call('GET', `/api/link/${s.sid}/result`, {})).status, 401);
      // Still intact after all that.
      assert.equal((await call('GET', `/api/link/${s.sid}`, { page: s.pageToken })).status, 200);
    }));

  test(`${name}: the first answer wins and the page token stops working`, () =>
    withRelay(async ({ call, open }) => {
      const s = await open();
      const answers = await Promise.all([
        call('POST', `/api/link/${s.sid}/result`, { page: s.pageToken, body: { txs: [TX, TX] } }),
        call('POST', `/api/link/${s.sid}/result`, { page: s.pageToken, body: { txs: [SIG, SIG] } }),
        call('POST', `/api/link/${s.sid}/cancel`, { page: s.pageToken }),
      ]);
      assert.equal(answers.filter((a) => a.status === 200).length, 1, JSON.stringify(answers.map((a) => a.status)));
      assert.ok(answers.every((a) => a.status === 200 || a.status === 401 || a.status === 409));
      assert.equal((await call('GET', `/api/link/${s.sid}`, { page: s.pageToken })).status, 401);
      assert.equal((await call('POST', `/api/link/${s.sid}/cancel`, { page: s.pageToken })).status, 401);
      const won = answers.findIndex((a) => a.status === 200);
      const got = (await call('GET', `/api/link/${s.sid}/result`, { app: s.appToken })).body;
      assert.deepEqual(got, won === 2 ? { status: 'cancelled' } : { status: 'done', result: { txs: won === 0 ? [TX, TX] : [SIG, SIG] } });
    }));

  test(`${name}: cancel from the page, and the app closing its screen`, () =>
    withRelay(async ({ call, open }) => {
      const s = await open();
      assert.equal((await call('POST', `/api/link/${s.sid}/cancel`, { page: s.pageToken })).status, 200);
      assert.deepEqual((await call('GET', `/api/link/${s.sid}/result`, { app: s.appToken })).body, { status: 'cancelled' });

      const t = await open();
      assert.equal((await call('DELETE', `/api/link/${t.sid}`, { app: t.appToken })).status, 200);
      assert.equal((await call('GET', `/api/link/${t.sid}`, { page: t.pageToken })).status, 404);
      assert.equal((await call('POST', `/api/link/${t.sid}/result`, { page: t.pageToken, body: { txs: [TX, TX] } })).status, 404);
    }));

  test(`${name}: sessions expire after five minutes`, () =>
    withRelay(async ({ call, open, clock }) => {
      const s = await open();
      clock.now += LINK_TTL_MS - 1000;
      assert.equal((await call('GET', `/api/link/${s.sid}`, { page: s.pageToken })).status, 200);
      clock.now += 1000;
      assert.equal((await call('GET', `/api/link/${s.sid}`, { page: s.pageToken })).status, 404);
      assert.equal((await call('POST', `/api/link/${s.sid}/result`, { page: s.pageToken, body: { txs: [TX, TX] } })).status, 404);
      assert.equal((await call('GET', `/api/link/${s.sid}/result`, { app: s.appToken })).status, 404);

      // An answer that came in time can still be collected a little after.
      const u = await open();
      clock.now += LINK_TTL_MS - 10;
      assert.equal((await call('POST', `/api/link/${u.sid}/result`, { page: u.pageToken, body: { txs: [TX, TX] } })).status, 200);
      clock.now += 30_000;
      assert.equal((await call('GET', `/api/link/${u.sid}/result`, { app: u.appToken })).body.status, 'done');
    }));

  // Every request from its own address: a bad request still counts against creating sessions.
  let n = 0;
  test(`${name}: requests are validated and capped at 64 kB`, () =>
    withRelay(async ({ call }) => {
      const bad = [
        { kind: 'steal', payload: {} },
        { kind: 'sign' },
        { kind: 'sign', payload: { owner: 'not-an-address', txs: [TX] } },
        { kind: 'sign', payload: { owner: OWNER, txs: [] } },
        { kind: 'sign', payload: { owner: OWNER, txs: Array(25).fill(TX) } },
        { kind: 'sign', payload: { owner: OWNER, txs: ['%%%'] } },
        { kind: 'sign', payload: { owner: OWNER, txs: [TX], keepBlockhash: 'yes' } },
        { kind: 'connect', payload: { nonce: 'short' } },
        [],
        null,
      ];
      for (const body of bad) assert.equal((await call('POST', '/api/link', { body })).status, 400, JSON.stringify(body));
      assert.equal((await call('POST', '/api/link', { raw: '{not json' , body: undefined })).status, 400);
      const huge = JSON.stringify({ kind: 'sign', payload: { owner: OWNER, txs: [TX] }, pad: 'x'.repeat(LINK_BODY_LIMIT) });
      assert.equal((await call('POST', '/api/link', { raw: huge })).status, 413);

      const s = (await call('POST', '/api/link', { body: { kind: 'sign', payload: { owner: OWNER, txs: [TX] } } })).body;
      for (const body of [{ txs: [TX, TX] }, { txs: [] }, { txs: [TX], lastValidBlockHeight: -1 }, { txs: [TX], blockhash: 'l0l' }, null]) {
        assert.equal((await call('POST', `/api/link/${s.sid}/result`, { page: s.pageToken, body })).status, 400, JSON.stringify(body));
      }
      assert.equal((await call('POST', `/api/link/${s.sid}/result`, { page: s.pageToken, raw: JSON.stringify({ txs: [TX], pad: 'x'.repeat(LINK_BODY_LIMIT) }) })).status, 413);
      // Nothing above used up the one answer.
      assert.equal((await call('POST', `/api/link/${s.sid}/result`, { page: s.pageToken, body: { txs: [TX] } })).status, 200);
      assert.equal((await call('PUT', `/api/link/${s.sid}`, {})).status, 405);
    }, { ip: () => `10.0.${n >> 8}.${n++ & 255}` }));

  test(`${name}: session creation is rate limited per IP, across instances`, async () => {
    const clock = { now: 1_700_000_000_000 };
    const kv = makeKv(clock);
    let ip = '198.51.100.1';
    // Two handlers on one KV: two serverless instances.
    const a = createLinkHandler({ kv, clientIp: () => ip, log: () => {}, now: () => clock.now });
    const b = createLinkHandler({ kv, clientIp: () => ip, log: () => {}, now: () => clock.now });
    const create = (h) =>
      serve(h, async (base) => (await fetch(`${base}/api/link`, { method: 'POST', body: JSON.stringify({ kind: 'connect', payload: { nonce: NONCE } }) })).status);
    const statuses = [];
    for (let i = 0; i < LINK_CREATES_PER_MIN + 2; i++) statuses.push(await create(i % 2 ? a : b));
    assert.deepEqual(statuses, [...Array(LINK_CREATES_PER_MIN).fill(201), 429, 429]);
    ip = '198.51.100.2';
    assert.equal(await create(a), 201); // another player
    ip = '198.51.100.1';
    clock.now += 60_000;
    assert.equal(await create(b), 201); // a minute later
  });
}

test('tokens are stored only as hashes, and nothing secret is logged', async () => {
  const kv = createMemoryKv();
  const logs = [];
  const writes = [];
  const spy = { ...kv, set: async (k, v, o) => (writes.push(v), kv.set(k, v, o)), cas: async (k, e, v, o) => (writes.push(v), kv.cas(k, e, v, o)) };
  // A KV that fails on reads makes the handler log: what it logs must not hold a token.
  let failReads = false;
  spy.get = async (k) => {
    if (failReads) throw new Error(`redis down while reading ${k.slice(0, 9)}`);
    return kv.get(k);
  };
  await serve(createLinkHandler({ kv: spy, log: (m) => logs.push(m) }), async (base) => {
    const s = await (await fetch(`${base}/api/link`, { method: 'POST', body: JSON.stringify({ kind: 'connect', payload: { nonce: NONCE } }) })).json();
    await fetch(`${base}/api/link/${s.sid}/result`, { method: 'POST', headers: { 'x-link-token': s.pageToken }, body: JSON.stringify({ publicKey: OWNER, signature: SIG }) });
    for (const w of writes) assert.ok(!String(w).includes(s.appToken) && !String(w).includes(s.pageToken));
    failReads = true;
    const r = await fetch(`${base}/api/link/${s.sid}`, { headers: { 'x-link-token': s.pageToken } });
    assert.equal(r.status, 500);
    assert.equal(logs.length, 1);
    for (const m of logs) assert.ok(!m.includes(s.sid) && !m.includes(s.pageToken) && !m.includes(s.appToken) && !m.includes(SIG), m);
  });
});

test('the Vercel function serves /api/link from Redis, shared by its instances', async () => {
  const redis = createFakeRedis();
  const make = () => createVercelHandler({ env: { MARKET_STORE: 'redis' }, redis, log: () => {}, createMarket: async () => ({ handle: async () => false }) });
  const [one, two] = [make(), make()];
  let s;
  await serve(async (req, res) => (await one(req, res), true), async (base) => {
    const r = await fetch(`${base}/api/link`, { method: 'POST', headers: { 'x-real-ip': '192.0.2.4' }, body: JSON.stringify({ kind: 'connect', payload: { nonce: NONCE } }) });
    assert.equal(r.status, 201);
    s = await r.json();
  });
  await serve(async (req, res) => (await two(req, res), true), async (base) => {
    const r = await fetch(`${base}/api/link/${s.sid}`, { headers: { 'x-link-token': s.pageToken } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).matchCode, s.matchCode);
  });
  assert.ok([...redis.data.keys()].some((k) => k === `market:kv:link:${s.sid}`));
});

test('the Dell serves link.html with frame-ancestors none, and only link.html', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'link-static-'));
  try {
    writeFileSync(join(dir, 'link.html'), '<!doctype html>');
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    await serve(async (req, res) => (await staticHandler(dir)(req, res), true), async (base) => {
      const link = await fetch(`${base}/link.html`);
      assert.equal(link.headers.get('content-security-policy'), "frame-ancestors 'none'");
      assert.equal(link.headers.get('x-frame-options'), 'DENY');
      assert.equal(link.headers.get('referrer-policy'), 'no-referrer');
      const index = await fetch(`${base}/`);
      assert.equal(index.headers.get('x-frame-options'), null);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
