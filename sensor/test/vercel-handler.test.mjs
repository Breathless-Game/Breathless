import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { createGearHandler } from '../nft-gear.mjs';
import { createNftHandler } from '../nft-meta.mjs';
import { CRON_PATH, NFT_CDN_CACHE, SWEEP_DEADLINE_MS, SWEEP_EVERY_MS, createVercelHandler, cronAuthorized, originalUrl, vercelClientIp } from '../vercel-handler.mjs';
import { createFakeRedis } from './fake-redis.mjs';

// The Vercel function (vercel-handler.mjs) against the fake Redis and a stand-in market: routing,
// the cron's secret, the after-sale sweep's throttle, and /api/nft/* byte for byte as on the Dell.

const META = '/api/nft/meta/v1/c61cd89c/uncommon/8-3-38-0.52/slim-130-45-50-310-3/Coral%20Reef/Lively%20Striped%20Wrasse.json';
const IMG = '/api/nft/img/v1/c61cd89c/uncommon/slim-130-45-50-310-3/Striped%20Wrasse.png';
const BOAT = '/api/nft/gear/v1/boat/3/1-2-1-3-1.json';
const OWNER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const ORIGIN = 'https://breathless.gotclass.xyz';
const SECRET = 'cron-secret-for-tests';

async function serve(handler, fn) {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

/** A stand-in for market.mjs's createMarket: answers sales 200 and counts sweeps. */
function fakeMarket({ fail = false } = {}) {
  const m = { made: 0, sweeps: 0, options: null, sweepOptions: [] };
  m.createMarket = async (options) => {
    m.made++;
    m.options = options;
    if (fail) throw new Error('MARKET_SECRET_KEY is not set');
    return {
      handle: async (req, res) => {
        const status = req.url.includes('reject') ? 409 : 200;
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ route: `${req.method} ${req.url}`, ip: options.clientIp(req) }));
        return true;
      },
      sweep: async (opts) => {
        m.sweeps++;
        m.sweepOptions.push(opts);
        return { burned: 1, resumed: 0, settled: 0, skipped: 0, failed: 0, waiting: 0, left: 0, rateLimited: false };
      },
    };
  };
  return m;
}

function setup({ env = {}, market = fakeMarket(), t = { now: 1_000_000 } } = {}) {
  const redis = createFakeRedis({ now: () => t.now });
  const pending = [];
  const handler = createVercelHandler({
    env: { MARKET_STORE: 'redis', PUBLIC_ORIGIN: ORIGIN, CRON_SECRET: SECRET, ...env },
    redis,
    log: () => {},
    createMarket: market.createMarket,
    waitUntil: (p) => pending.push(p),
    now: () => t.now,
  });
  return { handler, redis, market, pending, t };
}

test('the rewrite: the original path, or __path when the URL is the rewrite\'s destination', () => {
  assert.equal(originalUrl('/api/market/balance?owner=x&__path=market/balance'), '/api/market/balance?owner=x');
  assert.equal(originalUrl('/api/index?__path=nft/img/v1/a%20b.png'), '/api/nft/img/v1/a%20b.png');
  assert.equal(originalUrl('/api/index?owner=x&__path=market/balance'), '/api/market/balance?owner=x');
  assert.equal(originalUrl('/api/index'), '/api/');
  assert.equal(originalUrl(META), META);
});

test('client IP: Vercel\'s x-real-ip, else the first x-forwarded-for, else the socket', () => {
  assert.equal(vercelClientIp({ headers: { 'x-real-ip': ' 1.2.3.4 ', 'x-forwarded-for': '5.6.7.8' } }), '1.2.3.4');
  assert.equal(vercelClientIp({ headers: { 'x-forwarded-for': '5.6.7.8, 10.0.0.1' } }), '5.6.7.8');
  assert.equal(vercelClientIp({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }), '9.9.9.9');
});

test('the cron secret: exact Bearer match only, and no secret set lets nobody in', () => {
  const req = (authorization) => ({ headers: authorization === undefined ? {} : { authorization } });
  assert.equal(cronAuthorized(req(`Bearer ${SECRET}`), SECRET), true);
  assert.equal(cronAuthorized(req(SECRET), SECRET), false);
  assert.equal(cronAuthorized(req(`Bearer ${SECRET}x`), SECRET), false);
  assert.equal(cronAuthorized(req(), SECRET), false);
  assert.equal(cronAuthorized(req('Bearer '), ''), false);
  assert.equal(cronAuthorized(req('Bearer undefined'), undefined), false);
});

test('/api/nft/* answers byte for byte as on the Dell, plus Vercel\'s own CDN lifetime', async () => {
  const dellNft = createNftHandler({ publicOrigin: ORIGIN, log: () => {} });
  const dellGear = createGearHandler({ publicOrigin: ORIGIN });
  const dell = async (req, res) => {
    if (await dellGear(req, res)) return;
    if (!(await dellNft(req, res))) res.writeHead(404).end();
  };
  const { handler, market } = setup();
  const get = async (base, path) => {
    const r = await fetch(base + path);
    return { status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) };
  };
  await serve(dell, async (dellBase) => {
    await serve(handler, async (base) => {
      for (const path of [META, IMG, BOAT, `${IMG}?r=7`, '/api/nft/meta/v1/nope.json']) {
        const [a, b] = [await get(dellBase, path), await get(base, path)];
        assert.equal(b.status, a.status, path);
        assert.ok(a.body.equals(b.body), `${path}: same bytes`);
        const { date: _d1, 'vercel-cdn-cache-control': cdn, ...bh } = b.headers;
        const { date: _d2, ...ah } = a.headers;
        assert.deepEqual(bh, ah, `${path}: same headers`);
        assert.equal(cdn, a.status === 200 ? NFT_CDN_CACHE : undefined, path);
      }
      // A metadata request through the rewrite's destination is the same request.
      const viaIndex = await get(base, `/api/index?__path=${META.slice('/api/'.length)}`);
      assert.ok(viaIndex.body.equals((await get(dellBase, META)).body));
    });
  });
  assert.equal(market.made, 0, 'NFT routes never start the market');
});

test('fish numbers come from Redis, shared by every instance', async () => {
  const { handler, redis } = setup();
  const other = createVercelHandler({ env: { MARKET_STORE: 'redis' }, redis, log: () => {} });
  const post = (base, id) =>
    fetch(`${base}/api/nft/serial`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, owner: OWNER }) }).then((r) => r.json());
  await serve(handler, async (a) => {
    await serve(other, async (b) => {
      assert.deepEqual(await post(a, 'c61cd89c'), { serial: 1 });
      assert.deepEqual(await post(b, '0000beef'), { serial: 2 });
      assert.deepEqual(await post(b, 'c61cd89c'), { serial: 1 });
    });
  });
});

test('the market is built once per instance, with no timers, the batch deadline and Vercel\'s client IP', async () => {
  const { handler, market } = setup();
  await serve(handler, async (base) => {
    const [r1, r2] = await Promise.all([
      fetch(`${base}/api/market/info`, { headers: { 'x-real-ip': '1.2.3.4' } }).then((r) => r.json()),
      fetch(`${base}/api/market/info`).then((r) => r.json()),
    ]);
    assert.deepEqual(r1, { route: 'GET /api/market/info', ip: '1.2.3.4' });
    assert.equal(r2.route, 'GET /api/market/info');
    const missing = await fetch(`${base}/api/elsewhere`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
  });
  assert.equal(market.made, 1);
  assert.equal(market.options.background, false);
  assert.equal(market.options.batchDeadlineMs, 180_000);
  assert.equal(market.options.store.kind, 'redis');
});

test('a market that cannot start answers 503 and is tried again on the next request', async () => {
  const market = fakeMarket({ fail: true });
  const { handler } = setup({ market });
  await serve(handler, async (base) => {
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${base}/api/market/info`);
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { error: 'PEARL market is unavailable on this server' });
    }
    assert.equal((await fetch(base + IMG)).status, 200, 'the NFT routes keep working');
  });
  assert.equal(market.made, 2);
});

test('the cron sweeps only with the secret', async () => {
  const t = { now: 1_000_000 };
  const market = fakeMarket();
  const coldStart = market.createMarket;
  market.createMarket = async (options) => {
    t.now += 40_000; // the market's cold start, inside the cron request
    return coldStart(options);
  };
  const { handler } = setup({ market, t });
  await serve(handler, async (base) => {
    assert.equal((await fetch(base + CRON_PATH)).status, 401);
    assert.equal((await fetch(base + CRON_PATH, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const ok = await fetch(base + CRON_PATH, { headers: { authorization: `Bearer ${SECRET}` } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { swept: true, burned: 1, resumed: 0, settled: 0, skipped: 0, failed: 0, waiting: 0, left: 0, rateLimited: false });
  });
  assert.equal(market.sweeps, 1);
  assert.deepEqual(market.sweepOptions, [{ deadlineMs: SWEEP_DEADLINE_MS - 40_000 }], 'time-boxed below maxDuration, counted from the request');
  const { handler: unset } = setup({ env: { CRON_SECRET: '' } });
  await serve(unset, async (base) => {
    assert.equal((await fetch(base + CRON_PATH, { headers: { authorization: 'Bearer ' } })).status, 401);
  });
});

test('after a sale the sweep runs in waitUntil, at most once per SWEEP_EVERY_MS across instances', async () => {
  const t = { now: 1_000_000 };
  const { handler, redis, market, pending } = setup({ t });
  const other = createVercelHandler({ env: { MARKET_STORE: 'redis' }, redis, log: () => {}, createMarket: market.createMarket, waitUntil: (p) => pending.push(p), now: () => t.now });
  const sell = (base, path = '/api/market/sell') => fetch(base + path, { method: 'POST', body: '{}' }).then((r) => r.status);
  await serve(handler, async (a) => {
    await serve(other, async (b) => {
      assert.equal(await sell(a), 200);
      assert.equal(await sell(b, '/api/market/sell-batch'), 200);
      assert.equal(await sell(a), 200);
      assert.equal(await sell(a, '/api/market/sell?reject=1'), 409);
      await fetch(`${a}/api/market/info`);
      await Promise.all(pending);
      assert.equal(pending.length, 3, 'only successful sales');
      assert.equal(market.sweeps, 1);
      t.now += SWEEP_EVERY_MS;
      assert.equal(await sell(b), 200);
      await Promise.all(pending);
      assert.equal(market.sweeps, 2);
      assert.deepEqual(market.sweepOptions, [{ deadlineMs: SWEEP_DEADLINE_MS }, { deadlineMs: SWEEP_DEADLINE_MS }], 'counted from the sale request');
    });
  });
});

test('the function\'s dependencies (root package.json) are the versions sensor/ is tested with', () => {
  const root = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')).packages;
  const sensor = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies;
  for (const [name, version] of Object.entries(root.dependencies)) {
    if (name === '@vercel/functions') continue; // Vercel only: sensor/ never imports it
    assert.ok(sensor[name], `${name} is a sensor dependency`);
    assert.equal(version, lock[`node_modules/${name}`]?.version, `${name}: root ${version}, sensor/package-lock.json ${lock[`node_modules/${name}`]?.version}`);
  }
  // Never in the function: the camera SDK (native, hundreds of MB), sharp (camera frames only), dotenv.
  for (const name of ['@smartspectra/node-sdk', 'sharp', 'dotenv', 'ws']) assert.equal(root.dependencies[name], undefined, name);
});
