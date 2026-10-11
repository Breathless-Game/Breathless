import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createNftHandler } from '../nft-meta.mjs';
import { createGearHandler, gearMetadataJson, gearStem, gearSvg, parseGearPath } from '../nft-gear.mjs';

const BOAT = '/api/nft/gear/v1/boat/3/1-2-1-3-1.json';
const KIT = '/api/nft/gear/v1/kit/1-2-3-1-2-1-3/far-fine-sprint-light-focus-silentReel.json';

async function withServer(fn) {
  const gear = createGearHandler({ publicOrigin: 'https://example.test' });
  const nft = createNftHandler({ log: () => {} });
  const server = createServer(async (req, res) => {
    if (await gear(req, res)) return;
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

test('parses boat and kit paths into absolute levels', () => {
  assert.deepEqual(parseGearPath(BOAT), { kind: 'boat', ext: 'json', ship: 3, bait: 1, boat: 2, boatSpeed: 1, boatHull: 3, boatDeck: 1 });
  const kit = parseGearPath(KIT);
  assert.equal(kit.kind, 'kit');
  assert.deepEqual([kit.rod, kit.reel, kit.net, kit.fins, kit.tank, kit.lamp, kit.sonar], [1, 2, 3, 1, 2, 1, 3]);
  assert.deepEqual(kit.branches, { rod: 'far', net: 'fine', fins: 'sprint', tank: 'light', lamp: 'focus', reel: 'silentReel' });
  assert.equal(parseGearPath(KIT.replace('.json', '.svg')).ext, 'svg');
  // The stem round-trips: the server rebuilds exactly the path it parsed.
  assert.equal(`${gearStem(parseGearPath(BOAT))}.json`, BOAT);
  assert.equal(`${gearStem(kit)}.json`, KIT);
});

test('rejects anything outside the allowlist', () => {
  for (const bad of [
    BOAT.replace('/3/', '/6/'), // no seventh ship
    BOAT.replace('/3/', '/-1/'),
    BOAT.replace('/3/', '/03/'),
    BOAT.replace('1-2-1-3-1', '1-2-1-3-4'), // level 4
    BOAT.replace('1-2-1-3-1', '0-2-1-3-1'), // level 0
    BOAT.replace('1-2-1-3-1', '1-2-1-3'), // one level short
    BOAT.replace('1-2-1-3-1', '1-2-1-3-1-1'), // one too many
    BOAT.replace('1-2-1-3-1', '1-2-1-3-1.5'),
    BOAT.replace('.json', '.png'),
    BOAT.replace('.json', ''),
    BOAT.replace('/v1/', '/v2/'),
    BOAT.replace('/boat/', '/ship/'),
    `${BOAT.replace('.json', '')}/x.json`,
    KIT.replace('silentReel', 'loudReel'), // unknown branch
    KIT.replace('far-fine', 'fine-far'), // branches in the wrong slots
    KIT.replace('far-fine-sprint-light-focus-silentReel', 'far-fine-sprint-light-focus'),
    KIT.replace('sprint-light', 'silent-light'), // fins Lv1 runs its default branch only
    KIT.replace('1-2-3-1-2-1-3', '1-2-3-1-2-1'),
    KIT.replace('1-2-3-1-2-1-3', '1-2-3-1-2-1-9'),
    KIT.replace('silentReel', 'silentReel%3Cscript%3E'),
    '/api/nft/gear/v1/../../etc/passwd.json',
    '/api/nft/gear/v1/boat/3/1-2-1-3-1.json/',
    '/api/nft/gear/v1/kit//.json',
    '/api/nft/gear/',
    '',
    null,
  ]) {
    assert.equal(parseGearPath(bad), null, String(bad));
  }
});

test('metadata JSON shows every level, points at the card, and follows the levels', () => {
  const boat = gearMetadataJson(parseGearPath(BOAT), 'https://example.test');
  assert.equal(boat.name, 'Breathless Boat');
  assert.equal(boat.image, 'https://example.test/api/nft/gear/v1/boat/3/1-2-1-3-1.svg');
  assert.deepEqual(boat.attributes[0], { trait_type: 'Ship', value: 'Echo Scout' });
  assert.deepEqual(boat.attributes.find((a) => a.trait_type === 'Hull'), { trait_type: 'Hull', value: 3 });
  assert.equal(boat.properties.files[0].type, 'image/svg+xml');
  const kit = gearMetadataJson(parseGearPath(KIT), 'https://example.test');
  assert.equal(kit.name, 'Breathless Dive Kit');
  assert.deepEqual(kit.attributes.find((a) => a.trait_type === 'Net'), { trait_type: 'Net', value: 3 });
  assert.deepEqual(kit.attributes.find((a) => a.trait_type === 'Net branch'), { trait_type: 'Net branch', value: 'Fine mesh' });
});

test('the card is a self-contained SVG with the levels drawn as pips', () => {
  const svg = gearSvg(parseGearPath(KIT));
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /Dive Kit/);
  assert.match(svg, /Fine mesh/);
  assert.doesNotMatch(svg, /<script|href=|xlink/i);
  // 7 pieces x 3 pips; the filled ones total the levels (1+2+3+1+2+1+3 = 13).
  assert.equal((svg.match(/<rect x="\d+" y="[\d.]+" width="22"/g) ?? []).length, 21);
  assert.equal((svg.match(/width="22" height="14" rx="4" fill="#3ef0a8"/g) ?? []).length, 13);
});

test('serves JSON and SVG, 400 on bad paths, 405 on writes, and leaves fish paths to nft-meta', async () => {
  await withServer(async (base) => {
    const meta = await fetch(base + BOAT);
    assert.equal(meta.status, 200);
    assert.match(meta.headers.get('content-type'), /application\/json/);
    assert.equal(meta.headers.get('access-control-allow-origin'), '*');
    assert.equal((await meta.json()).image, 'https://example.test/api/nft/gear/v1/boat/3/1-2-1-3-1.svg');

    const img = await fetch(base + KIT.replace('.json', '.svg'));
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(img.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await img.text(), /<svg/);

    const bad = await fetch(base + BOAT.replace('/3/', '/9/'));
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'Bad gear NFT path' });

    const post = await fetch(base + BOAT, { method: 'POST' });
    assert.equal(post.status, 405);

    // Not a gear path: the fish handler (mounted after) answers it.
    const fish = await fetch(`${base}/api/nft/meta/v1/zz/nope.json`);
    assert.equal(fish.status, 400);
    assert.deepEqual(await fish.json(), { error: 'Bad NFT metadata path' });
  });
});
