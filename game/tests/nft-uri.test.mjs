import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { imagePath, parseImagePath, parseMetaPath } from '../../sensor/nft-meta.mjs';

// The game builds NFT metadata paths (src/nft-uri.ts); the server parses them (sensor/nft-meta.mjs).
// These tests keep the two sides of the grammar in step.
const source = await readFile(new URL('../src/nft-uri.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { DEFAULT_NFT_ORIGIN, fishImagePath, fishMetaPath, isHostedMetaUri, nftOrigin } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

const fish = {
  id: 'c61cd89c',
  seed: 0xc61cd89c,
  rarity: 'uncommon',
  species: 'Striped Wrasse',
  name: 'Lively Striped Wrasse',
  archetype: 'slim',
  lengthCm: 38,
  weightKg: 0.52,
  depthM: 8,
  hue: 129.6,
  sat: 0.4512,
  light: 0.4987,
  accentHue: 310.2,
  stripes: 3,
  scale: 1.1,
  value: 3,
};

test('the server parses what the game builds', () => {
  const path = fishMetaPath(fish, { depthM: 8, value: 3, zone: "Kelp Forest's Edge" });
  const parsed = parseMetaPath(path);
  assert.ok(parsed, path);
  assert.equal(parsed.id, fish.id);
  assert.equal(parsed.rarity, fish.rarity);
  assert.equal(parsed.name, fish.name);
  assert.equal(parsed.zone, "Kelp Forest's Edge");
  assert.deepEqual([parsed.depthM, parsed.value, parsed.lengthCm, parsed.weightKg], [8, 3, 38, 0.52]);
  assert.deepEqual(parsed.look, { archetype: 'slim', hue: 130, sat: 0.45, light: 0.5, accentHue: 310, stripes: 3 });
  // The JSON's image is the same path the game records as the mint's image.
  assert.equal(imagePath(parsed), fishImagePath(fish));
  assert.equal(parseImagePath(fishImagePath(fish)).species, 'Striped Wrasse');
  assert.ok(isHostedMetaUri(DEFAULT_NFT_ORIGIN + path));
  assert.ok(!isHostedMetaUri('https://gateway.irys.xyz/EJGxHmBxmzBu21SCSVKbqNhGEzeEwqhZdS1FS6LVynQb'));
});

test('odd values still make a valid path', () => {
  const odd = { ...fish, name: 'Starborn Moonfin Leviathan', rarity: 'mythic', archetype: 'long', hue: 359.9, accentHue: -20, sat: 1.2, light: -0.1, stripes: 12, weightKg: 1234.5678, lengthCm: 129 };
  const parsed = parseMetaPath(fishMetaPath(odd, { depthM: 1000, value: 4800, zone: 'The Trench' }));
  assert.ok(parsed);
  assert.deepEqual(parsed.look, { archetype: 'long', hue: 0, sat: 1, light: 0, accentHue: 340, stripes: 9 });
  assert.equal(parsed.weightKg, 1234.57);
});

test('minted URIs never point at localhost or a LAN address', () => {
  const page = (origin) => {
    const u = new URL(origin);
    return { protocol: u.protocol, hostname: u.hostname, origin: u.origin };
  };
  assert.equal(nftOrigin(undefined, page('http://localhost:5173')), DEFAULT_NFT_ORIGIN);
  assert.equal(nftOrigin(undefined, page('https://localhost:5173')), DEFAULT_NFT_ORIGIN);
  assert.equal(nftOrigin(undefined, page('http://127.0.0.1:8794')), DEFAULT_NFT_ORIGIN);
  assert.equal(nftOrigin(undefined, page('https://192.168.1.20:8794')), DEFAULT_NFT_ORIGIN);
  assert.equal(nftOrigin(undefined, page('http://breathless.gotclass.xyz')), DEFAULT_NFT_ORIGIN);
  assert.equal(nftOrigin(undefined, page('https://breathless.gotclass.xyz')), 'https://breathless.gotclass.xyz');
  assert.equal(nftOrigin(undefined, page('https://other-host.example.com')), 'https://other-host.example.com');
  assert.equal(nftOrigin('https://nft.example.com/', page('http://localhost:5173')), 'https://nft.example.com');
  assert.equal(nftOrigin(undefined, undefined), DEFAULT_NFT_ORIGIN);
});
