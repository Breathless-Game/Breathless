import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SERIAL_FILE, createSerialCounter, createSerialHandler } from '../nft-serial.mjs';

const OWNER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const OTHER = '7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nft-serial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function withServer(options, fn) {
  const serials = createSerialHandler({ log: () => {}, ...options });
  const server = createServer(async (req, res) => {
    if (await serials(req, res)) return;
    res.writeHead(418).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = (body, method = 'POST') =>
    fetch(base + '/api/nft/serial', { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined });
  try {
    await fn(ask, base);
  } finally {
    server.close();
  }
}

test('numbers are sequential, idempotent per owner + fish, and survive a restart', (t) => {
  const file = join(tempDir(t), SERIAL_FILE);
  const a = createSerialCounter(file);
  assert.equal(a.assign(OWNER, 'c61cd89c'), 1);
  assert.equal(a.assign(OWNER, '0000beef'), 2);
  assert.equal(a.assign(OWNER, 'c61cd89c'), 1, 'a retried mint keeps its number');
  assert.equal(a.assign(OTHER, 'c61cd89c'), 3, 'the same seed caught by someone else is another fish');
  assert.ok(!existsSync(`${file}.tmp`), 'written via a temp file, then renamed');

  // "Restart": a new counter on the same file carries on where the last one stopped.
  const b = createSerialCounter(file);
  assert.equal(b.last, 3);
  assert.equal(b.assign(OWNER, '0000beef'), 2);
  assert.equal(b.assign(OWNER, '12345678'), 4);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).last, 4);
});

test('numbers keep going past 9999', (t) => {
  const file = join(tempDir(t), SERIAL_FILE);
  writeFileSync(file, JSON.stringify({ last: 9999, keys: {} }));
  const c = createSerialCounter(file);
  assert.equal(c.assign(OWNER, 'a'), 10000);
  writeFileSync(file, JSON.stringify({ last: 1234566, keys: {} }));
  assert.equal(createSerialCounter(file).assign(OWNER, 'b'), 1234567);
});

test('a corrupt counter fails closed instead of starting again from 1', (t) => {
  const dir = tempDir(t);
  const file = join(dir, SERIAL_FILE);
  writeFileSync(file, '{"last": 41, "keys": {');
  assert.throws(() => createSerialCounter(file));
  writeFileSync(file, '"hello"');
  assert.throws(() => createSerialCounter(file));
});

test('a number that cannot be saved is not handed out', (t) => {
  const dir = tempDir(t);
  const c = createSerialCounter(join(dir, 'missing-dir', SERIAL_FILE));
  assert.throws(() => c.assign(OWNER, 'a'), (e) => e.status === 503);
  assert.equal(c.last, 0, 'rolled back');
  assert.equal(c.peek(OWNER, 'a'), undefined);
});

test('POST /api/nft/serial: validates, numbers, persists across a restart', async (t) => {
  const file = join(tempDir(t), SERIAL_FILE);
  await withServer({ file }, async (ask, base) => {
    const first = await ask({ id: 'c61cd89c', owner: OWNER });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { serial: 1 });
    assert.deepEqual(await (await ask({ id: 'c61cd89c', owner: OWNER })).json(), { serial: 1 });
    assert.deepEqual(await (await ask({ id: 'beef', owner: OWNER })).json(), { serial: 2 });
    for (const bad of [{}, { id: 'XYZ', owner: OWNER }, { id: 'c61cd89c' }, { id: 'c61cd89c', owner: 'not-an-address' }, { id: 'a'.repeat(17), owner: OWNER }]) {
      assert.equal((await ask(bad)).status, 400, JSON.stringify(bad));
    }
    const bad = await fetch(base + '/api/nft/serial', { method: 'POST', body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal((await ask(null, 'GET')).status, 405);
    assert.equal((await fetch(base + '/api/nft/meta/v1/x.json')).status, 418, 'other paths fall through');
  });
  await withServer({ file }, async (ask) => {
    assert.deepEqual(await (await ask({ id: 'c61cd89c', owner: OWNER })).json(), { serial: 1 });
    assert.deepEqual(await (await ask({ id: 'f00d', owner: OWNER })).json(), { serial: 3 });
  });
});

test('rate limits new numbers only, and answers 503 on a corrupt counter', async (t) => {
  const dir = tempDir(t);
  await withServer({ file: join(dir, SERIAL_FILE), limit: 2 }, async (ask) => {
    assert.equal((await ask({ id: 'a', owner: OWNER })).status, 200);
    assert.equal((await ask({ id: 'b', owner: OWNER })).status, 200);
    assert.equal((await ask({ id: 'c', owner: OWNER })).status, 429);
    // Fish that already have a number (a repair asking again) are not limited.
    assert.deepEqual(await (await ask({ id: 'a', owner: OWNER })).json(), { serial: 1 });
  });
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, 'not json');
  await withServer({ file: broken }, async (ask) => {
    assert.equal((await ask({ id: 'a', owner: OWNER })).status, 503);
  });
  assert.equal(readFileSync(broken, 'utf8'), 'not json', 'left alone for a human to fix');
});
