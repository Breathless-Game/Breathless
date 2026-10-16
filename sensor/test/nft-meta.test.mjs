import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { CARD_RENDER_VERSION } from '../fish-png.mjs';
import { createNftHandler, originFor, parseImagePath, parseMetaPath } from '../nft-meta.mjs';

/** The JSON's image URL carries the card renderer's version, so caches let go when the art changes. */
const R = `?r=${CARD_RENDER_VERSION}`;

const META = '/api/nft/meta/v1/c61cd89c/uncommon/8-3-38-0.52/slim-130-45-50-310-3/Coral%20Reef/Lively%20Striped%20Wrasse.json';
const IMG = '/api/nft/img/v1/c61cd89c/uncommon/slim-130-45-50-310-3/Striped%20Wrasse.png';

async function withServer(options, fn) {
  const nft = createNftHandler({ log: () => {}, ...options });
  const server = createServer(async (req, res) => {
    if (await nft(req, res)) return;
    res.writeHead(418).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('parses a metadata path and rejects malformed ones', () => {
  const fish = parseMetaPath(META);
  assert.equal(fish.name, 'Lively Striped Wrasse');
  assert.equal(fish.zone, 'Coral Reef');
  assert.equal(fish.rarity, 'uncommon');
  assert.deepEqual([fish.depthM, fish.value, fish.lengthCm, fish.weightKg], [8, 3, 38, 0.52]);
  assert.deepEqual(fish.look, { archetype: 'slim', hue: 130, sat: 0.45, light: 0.5, accentHue: 310, stripes: 3 });
  for (const bad of [
    META.replace('uncommon', 'godly'),
    META.replace('c61cd89c', 'C61CD89Z'),
    META.replace('8-3-38', '8-3'),
    META.replace('slim-', 'blob-'),
    META.replace('Lively%20Striped%20Wrasse', '%3Cscript%3E'),
    META.replace('Lively%20Striped%20Wrasse', '%E0%A4%A'),
    META.replace('.json', '.png'),
    META.replace('/Coral%20Reef', ''),
    '/api/nft/meta/v1/../../etc/passwd.json',
  ]) {
    assert.equal(parseMetaPath(bad), null, bad);
  }
  assert.equal(parseImagePath(IMG).species, 'Striped Wrasse');
  assert.equal(parseImagePath(IMG.replace('.png', '.jpg')), null);
});

test('image origin: PUBLIC_ORIGIN, else the Host header, never a bad host', () => {
  assert.equal(originFor({ headers: { host: 'breathless.gotclass.xyz' } }, ''), 'https://breathless.gotclass.xyz');
  assert.equal(originFor({ headers: { host: '127.0.0.1:8794' } }, ''), 'http://127.0.0.1:8794');
  assert.equal(originFor({ headers: { host: 'evil.com/"x' } }, ''), 'https://breathless.gotclass.xyz');
  assert.equal(originFor({ headers: {} }, ''), 'https://breathless.gotclass.xyz');
  assert.equal(originFor({ headers: { host: '127.0.0.1:8794' } }, 'https://game.example.com/'), 'https://game.example.com');
});

test('serves Metaplex JSON whose image resolves to a 512x512 PNG', async () => {
  await withServer({ publicOrigin: '' }, async (base) => {
    const res = await fetch(base + META);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const meta = await res.json();
    assert.equal(meta.name, 'Lively Striped Wrasse');
    assert.equal(meta.symbol, 'DIVE');
    assert.equal(meta.image, base + IMG + R);
    assert.deepEqual(meta.properties, { category: 'image', files: [{ uri: meta.image, type: 'image/png' }] });
    const attrs = Object.fromEntries(meta.attributes.map((a) => [a.trait_type, a.value]));
    assert.equal(attrs.Rarity, 'Uncommon');
    assert.equal(attrs.Species, 'Striped Wrasse');
    assert.equal(attrs['Depth (m)'], '8');
    assert.equal(attrs['Catch value'], '3');
    assert.equal(attrs.Seed, 'c61cd89c');

    const img = await fetch(meta.image);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await img.arrayBuffer());
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.toString('ascii', 12, 16), 'IHDR');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [512, 512]);
    // Deterministic: the same path gives the same bytes.
    const again = Buffer.from(await (await fetch(meta.image)).arrayBuffer());
    assert.ok(again.equals(png));
  });
});

test('PUBLIC_ORIGIN wins for the image URL', async () => {
  await withServer({ publicOrigin: 'https://breathless.gotclass.xyz' }, async (base) => {
    const meta = await (await fetch(base + META)).json();
    assert.equal(meta.image, 'https://breathless.gotclass.xyz' + IMG + R);
  });
});

test('answers every /api/nft path itself, and nothing else', async () => {
  await withServer({ publicOrigin: '' }, async (base) => {
    assert.equal((await fetch(base + META.replace('uncommon', 'godly'))).status, 400);
    assert.equal((await fetch(base + IMG.replace('slim', 'blob'))).status, 400);
    assert.equal((await fetch(base + '/api/nft/whatever')).status, 404);
    assert.equal((await fetch(base + META, { method: 'POST' })).status, 405);
    const head = await fetch(base + META, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await fetch(base + '/api/market/info')).status, 418);
  });
});

test('a species named after an Object.prototype key draws the unknown-species fish, never a 500', async () => {
  await withServer({ publicOrigin: '' }, async (base) => {
    const img = (species, look = 'perch-1-1-1-1-1') => fetch(`${base}/api/nft/img/v1/0000abcd/common/${look}/${species}.png`);
    for (const look of ['perch-1-1-1-1-1', 'perch-1-1-1-1-1-0123456789abcdef']) {
      const unknown = await img('Nofish', look);
      assert.equal(unknown.status, 200);
      const expected = Buffer.from(await unknown.arrayBuffer());
      for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
        const res = await img(key, look);
        assert.equal(res.status, 200, `${key} ${look}`);
        assert.ok(Buffer.from(await res.arrayBuffer()).equals(expected), `${key} ${look}: the generic fallback`);
      }
    }
  });
});

const META2 ='/api/nft/meta/v2/42/c61cd89c/uncommon/8-3-38-0.52/slim-130-45-50-310-3/Coral%20Reef/Lively%20Striped%20Wrasse.json';
const IMG2 = '/api/nft/img/v2/42/c61cd89c/uncommon/slim-130-45-50-310-3/Striped%20Wrasse.png';

test('v2 paths carry the fish number; v1 still parses without one', () => {
  assert.equal(parseMetaPath(META2).serial, 42);
  assert.equal(parseMetaPath(META).serial, undefined);
  assert.equal(parseImagePath(IMG2).serial, 42);
  assert.equal(parseMetaPath(META2.replace('/v2/42/', '/v2/10000/')).serial, 10000);
  assert.equal(parseMetaPath(META2.replace('/v2/42/', '/v2/1234567/')).serial, 1234567);
  assert.equal(parseMetaPath(META2.replace('/v2/42/', '/v2/999999999/')).serial, 999999999);
  for (const bad of ['/v2/0/', '/v2/0042/', '/v2/-1/', '/v2/1e3/', '/v2/1000000000/', '/v2/', '/v3/42/', '/v2/abc/']) {
    assert.equal(parseMetaPath(META2.replace('/v2/42/', bad)), null, bad);
    assert.equal(parseImagePath(IMG2.replace('/v2/42/', bad)), null, bad);
  }
  // The serial segment is required in v2 and not allowed in v1.
  assert.equal(parseMetaPath(META.replace('/v1/', '/v1/42/')), null);
});

test('v2 JSON is named "<name> #0042" and its image draws the number', async () => {
  await withServer({ publicOrigin: '' }, async (base) => {
    const meta = await (await fetch(base + META2)).json();
    assert.equal(meta.name, 'Lively Striped Wrasse #0042');
    assert.equal(meta.image, base + IMG2 + R);
    const attrs = Object.fromEntries(meta.attributes.map((a) => [a.trait_type, a.value]));
    assert.equal(attrs.Number, '#0042');
    const big = await (await fetch(base + META2.replace('/v2/42/', '/v2/1234567/'))).json();
    assert.equal(big.name, 'Lively Striped Wrasse #1234567');

    const numbered = Buffer.from(await (await fetch(meta.image)).arrayBuffer());
    const plain = Buffer.from(await (await fetch(base + IMG)).arrayBuffer());
    assert.equal(numbered.toString('ascii', 12, 16), 'IHDR');
    assert.ok(!numbered.equals(plain), 'the number is on the card');
  });
});
