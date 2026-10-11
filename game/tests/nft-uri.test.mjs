import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { formatSerial as serverFormatSerial, imagePath, metadataJson, parseImagePath, parseMetaPath } from '../../sensor/nft-meta.mjs';

// The game builds NFT metadata paths (src/nft-uri.ts); the server parses them (sensor/nft-meta.mjs).
// These tests keep the two sides of the grammar in step.
const source = await readFile(new URL('../src/nft-uri.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { DEFAULT_NFT_ORIGIN, fishImagePath, fishMetaPath, formatSerial, isHostedMetaUri, isSerial, nftName, nftOrigin } = await import(
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

test('fish numbers: at least four digits, never capped at 9999', () => {
  for (const [n, text] of [
    [1, '#0001'],
    [42, '#0042'],
    [9999, '#9999'],
    [10000, '#10000'],
    [123456, '#123456'],
    [1234567, '#1234567'],
    [999999999, '#999999999'],
  ]) {
    assert.equal(formatSerial(n), text);
    assert.equal(serverFormatSerial(n), text, 'the server formats the same');
  }
  assert.equal(nftName({ name: 'Lively Striped Wrasse', serial: 42 }), 'Lively Striped Wrasse #0042');
  assert.equal(nftName({ name: 'Lively Striped Wrasse', serial: 1234567 }), 'Lively Striped Wrasse #1234567');
  // No number yet: just the name, never a made-up one.
  assert.equal(nftName({ name: 'Lively Striped Wrasse' }), 'Lively Striped Wrasse');
  for (const bad of [0, -1, 1.5, NaN, '42', 1_000_000_000, undefined, null]) assert.equal(isSerial(bad), false, String(bad));
  for (const good of [1, 42, 10000, 999_999_999]) assert.equal(isSerial(good), true);
});

test('a numbered fish round-trips through v2 paths, and the JSON name carries the number', () => {
  for (const [serial, text] of [
    [42, '#0042'],
    [10000, '#10000'],
    [1234567, '#1234567'],
  ]) {
    const numbered = { ...fish, serial };
    const path = fishMetaPath(numbered, { depthM: 8, value: 3, zone: 'Coral Reef' });
    assert.ok(path.startsWith(`/api/nft/meta/v2/${serial}/c61cd89c/`), path);
    const parsed = parseMetaPath(path);
    assert.ok(parsed, path);
    assert.equal(parsed.serial, serial);
    assert.equal(parsed.name, fish.name);
    assert.equal(imagePath(parsed), fishImagePath(numbered));
    assert.equal(parseImagePath(fishImagePath(numbered)).serial, serial);
    const json = metadataJson(parsed, DEFAULT_NFT_ORIGIN);
    assert.equal(json.name, `Lively Striped Wrasse ${text}`);
    assert.equal(json.name, nftName(numbered), 'the JSON name matches the on-chain name');
    assert.ok(isHostedMetaUri(DEFAULT_NFT_ORIGIN + path));
  }
  // Without a number the game still builds v1, which the server still resolves (minted fish keep working).
  const v1 = fishMetaPath(fish, { depthM: 8, value: 3, zone: 'Coral Reef' });
  assert.ok(v1.startsWith('/api/nft/meta/v1/'));
  assert.equal(parseMetaPath(v1).serial, undefined);
  assert.equal(metadataJson(parseMetaPath(v1), DEFAULT_NFT_ORIGIN).name, 'Lively Striped Wrasse');
});
