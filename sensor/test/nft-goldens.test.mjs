import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { CARD_RENDER_VERSION } from '../fish-png.mjs';
import { createNftHandler, parseImagePath, parseMetaPath } from '../nft-meta.mjs';

// Golden images for fish NFTs that are already minted. Their PNG is stored nowhere: every wallet
// and explorer fetches /api/nft/img/..., which re-renders it from the path through the game's own
// mesh code (fish-png.mjs -> fish-card.gen.mjs, bundled from game/src/fish.ts, marine.ts and
// fish-card-geometry.ts). So any change to that code silently redraws every old fish. These tests
// pin today's pixels and metadata for a handful of real fish so such a change fails here instead.
//
// What is hashed: the raw scanlines inside the PNG (IDAT inflated), not the PNG file bytes. The
// rasteriser is pure JS (Float64/Float32 maths, rounded to 8-bit RGB), but the file is compressed
// with node:zlib deflateSync, and Node bundles its own zlib whose output can change between Node
// majors and CPUs (CI is Node 24 on ubuntu x64, dev Macs are arm64, Vercel is its own runtime)
// while inflating it always gives back exactly the same bytes. So the golden is exact (no
// tolerance) and independent of the compressor; the IHDR (size, depth, colour type) is checked too.
//
// To regenerate deliberately (after bumping CARD_RENDER_VERSION):
//   UPDATE_NFT_GOLDENS=1 node --test test/nft-goldens.test.mjs

const FIXTURE = new URL('./fixtures/nft-goldens.json', import.meta.url);
const ORIGIN = 'https://breathless.gotclass.xyz';
const CHANGED =
  'an already-minted NFT now renders differently; new looks must not change old fish ' +
  '(if intended, bump CARD_RENDER_VERSION and update the goldens deliberately)';

// The fish: the metadata path minted on chain (the image path is the one its JSON points at).
// `asset` is the devnet Metaplex Core asset holding that URI; null = not confirmed on chain.
const FISH = [
  {
    note: 'v1 (pre-numbering), generic body, slim, 3 stripes, uncommon. Repo fixture (nft-meta/vercel-handler tests), not confirmed on chain',
    asset: null,
    meta: '/api/nft/meta/v1/c61cd89c/uncommon/8-3-38-0.52/slim-130-45-50-310-3/Coral%20Reef/Lively%20Striped%20Wrasse.json',
  },
  {
    note: 'Venomous Hammerhead Shark #0026: marine hammerhead, no stripes, epic',
    asset: 'Ssdxi63TqUAqACmRarRbquieZJeRVZwQ9TvooqNuDTt',
    meta: '/api/nft/meta/v2/26/43d2622c/epic/126-134-83-17.92/bulky-292-82-56-121-0/The%20Trench/Venomous%20Hammerhead%20Shark.json',
  },
  {
    note: 'Prismatic Abyssal Giant Octopus #0098: marine octopus, 5 stripes, mythic',
    asset: '5zFpMCDLB2hZD8g551WLZTRJMKZsteJ9YodfXhX23mTE',
    meta: '/api/nft/meta/v2/98/34ab86a5/mythic/119-3072-125-30.83/long-323-92-63-156-5/Kelp%20Forest/Prismatic%20Abyssal%20Giant%20Octopus.json',
  },
  {
    note: 'Crowned Golden Sea Turtle #0044: marine turtle, 4 stripes, legendary',
    asset: '9tdSpNUS2vuSGMUjetxXNuKyGNu5x64etwXm3PgfmCM2',
    meta: '/api/nft/meta/v2/44/e3450866/legendary/346-900-45-2.9/disc-32-88-54-209-4/The%20Trench/Crowned%20Golden%20Sea%20Turtle.json',
  },
  {
    note: 'Phantom Moon Jellyfish #0043: marine jellyfish, 4 stripes, epic',
    asset: 'BFq6QB33b3tk8gRTU6BgQsT5kp1GR6JMFBP43nLdAqNt',
    meta: '/api/nft/meta/v2/43/84f9c1e0/epic/358-210-102-12.32/long-277-67-51-77-4/The%20Trench/Phantom%20Moon%20Jellyfish.json',
  },
  {
    note: 'Storm Ember Triggerfish #0020: v2 generic body, disc, no stripes, epic',
    asset: 'CzHK3xTJZPqr5TzHPANcMhmcnXLAGhMF4o5DMRChkWdg',
    meta: '/api/nft/meta/v2/20/c1eba7e5/epic/114-121-44-3.31/disc-292-75-53-126-0/The%20Trench/Storm%20Ember%20Triggerfish.json',
  },
];

async function serve(handler, fn) {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

/** sha256 of the PNG's decoded scanlines (filter byte + RGB per row), plus its IHDR facts. */
function pixelHash(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'not a PNG');
  let o = 8;
  let ihdr = null;
  const idat = [];
  while (o < png.length) {
    const len = png.readUInt32BE(o);
    const type = png.toString('ascii', o + 4, o + 8);
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9] };
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { ...ihdr, sha256: createHash('sha256').update(raw).digest('hex') };
}

/** Today's response for each fish, through the production handler (parse -> render -> send). */
async function current() {
  const nft = createNftHandler({ publicOrigin: ORIGIN, log: () => {} });
  return serve(nft, async (base) => {
    const out = {};
    for (const f of FISH) {
      const parsed = parseMetaPath(f.meta);
      assert.ok(parsed, `metadata path no longer parses: ${f.meta}\n${CHANGED}`);
      const res = await fetch(base + f.meta);
      assert.equal(res.status, 200, f.meta);
      const metadata = await res.json();
      const img = new URL(metadata.image);
      assert.equal(img.origin, ORIGIN);
      assert.ok(parseImagePath(img.pathname), `image path no longer parses: ${img.pathname}\n${CHANGED}`);
      const r = await fetch(base + img.pathname + img.search);
      assert.equal(r.status, 200, img.pathname);
      assert.equal(r.headers.get('content-type'), 'image/png');
      const png = Buffer.from(await r.arrayBuffer());
      out[f.meta] = { note: f.note, asset: f.asset, image: pixelHash(png), metadata };
    }
    return out;
  });
}

if (process.env.UPDATE_NFT_GOLDENS === '1') {
  test('regenerate the NFT goldens', async () => {
    const got = await current();
    writeFileSync(FIXTURE, `${JSON.stringify({ cardRenderVersion: CARD_RENDER_VERSION, fish: got }, null, 2)}\n`);
  });
} else {
  const golden = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  test('the goldens cover the pinned fish and this CARD_RENDER_VERSION', () => {
    assert.deepEqual(Object.keys(golden.fish), FISH.map((f) => f.meta));
    assert.equal(
      CARD_RENDER_VERSION,
      golden.cardRenderVersion,
      `CARD_RENDER_VERSION is ${CARD_RENDER_VERSION} but the goldens were taken at ${golden.cardRenderVersion}: regenerate them deliberately (UPDATE_NFT_GOLDENS=1) after checking the old fish still look right`,
    );
  });

  test('already-minted fish NFTs render exactly as pinned (image pixels and metadata JSON)', async () => {
    const got = await current();
    for (const f of FISH) {
      const want = golden.fish[f.meta];
      const have = got[f.meta];
      assert.deepEqual(
        have.image,
        want.image,
        `${CHANGED}\n  fish: ${f.note}\n  meta: ${f.meta}\n  expected pixels ${want.image.sha256}\n  got      pixels ${have.image.sha256}`,
      );
      assert.deepEqual(have.metadata, want.metadata, `${CHANGED}\n  fish: ${f.note}\n  meta: ${f.meta} (metadata JSON changed)`);
    }
  });

  test('a render is deterministic within one process (the precondition for the goldens)', async () => {
    const [a, b] = [await current(), await current()];
    for (const f of FISH) assert.equal(a[f.meta].image.sha256, b[f.meta].image.sha256, f.meta);
  });
}
