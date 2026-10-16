// Which fish the market trusts, and how much it pays one wallet. Pure rules (no chain, no files),
// shared by every price path and by the co-signed mint / migration (fish-collection.mjs):
//
//   assertTrustedFish(asset, { collection })  the one gate before any price: the fish is in the
//       market's collection, has no plugin that could rewrite it, and its attributes are ones the
//       game's generator can produce for its seed. Returns the price (appraise()).
//   checkFish(facts, { legacy })   the generator check: species follows from (seed, rarity); the
//       rarity and catch value must be reachable from some spawn depth near the recorded depth,
//       under one of the generator versions that has minted fish (fish-gen.mjs GENERATORS).
//   parseCosignMint(body, ...)     what a co-signed mint may write on-chain.
//   assertSignedByPayer(...)       a co-sign request is signed by its game wallet (payer), whose
//       quota it spends (cosignMintMessage / cosignMigrateMessage: the signed strings).
//   checkMigratable(asset, ...)    whether a fish minted before the collection may move into it.
//   payout cap helpers             DAILY_PEARL_CAP per wallet per 24 h, from the sale ledger.
//
// Boat / Dive Kit gear NFTs (and anything else the session key mints) are never in the fish
// collection, so assertTrustedFish refuses them: the market can never buy one.

import { verify as ed25519Verify } from 'node:crypto';
import { publicKeyBytes } from '@metaplex-foundation/umi';
import { CURRENT_GENERATOR, GENERATORS, RARITY_ORDER, Rng, fishLook, seedOfId } from './fish-gen.mjs';
import {
  DAILY_PEARL_CAP,
  HttpError,
  MAX_DEPTH_M,
  MIGRATE_BATCH,
  PAYOUT_WINDOW_MS,
  RARITY_VALUE,
  SPAWN_TOLERANCE_M,
  ZONES,
  appraise,
  isAddress,
  rewardMultiplierAt,
} from './market-rules.mjs';
import { parseMetaPath } from './nft-meta.mjs';

const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

/** The fish facts chain.ts writes as Core Attributes: rarity, species, depth, value, seed. */
export function readFacts(attributeList) {
  const attrs = new Map();
  for (const a of attributeList ?? []) if (a && a.key != null) attrs.set(normKey(a.key), String(a.value ?? '').trim());
  const valueRaw = attrs.get('catchvalue') ?? attrs.get('value');
  return {
    id: attrs.get('seed') ?? '',
    rarity: (attrs.get('rarity') ?? '').toLowerCase(),
    species: attrs.get('species') ?? '',
    depth: attrs.has('depth') && attrs.get('depth') !== '' ? Number(attrs.get('depth')) : NaN,
    value: valueRaw === undefined ? undefined : Number(valueRaw),
  };
}

const rank = (rarity) => RARITY_ORDER.indexOf(rarity);

/**
 * The spawn depths in [lo, hi] at which `seed` rolls `rarity` with generator `gen`'s odds (default:
 * today's), as [a, b], or null. For a fixed seed the rolled rarity never drops as depth grows
 * (P(rarity >= k) is non-decreasing in depth in every version's table, game/tests/depth-odds.test.mjs
 * and fish-trust.test.mjs), so the set is one interval; its edges are found by bisection.
 */
export function rarityInterval(seed, rarity, lo, hi, gen = CURRENT_GENERATOR) {
  const target = rank(rarity);
  const at = (d) => rank(gen.rarityAt(seed, d));
  if (at(lo) > target || at(hi) < target) return null;
  let a = lo;
  if (at(lo) < target) {
    let [x, y] = [lo, hi]; // at(x) < target <= at(y)
    for (let i = 0; i < 60; i++) {
      const m = (x + y) / 2;
      if (at(m) < target) x = m;
      else y = m;
    }
    a = y;
  }
  let b = hi;
  if (at(hi) > target) {
    let [x, y] = [lo, hi]; // at(x) <= target < at(y)
    for (let i = 0; i < 60; i++) {
      const m = (x + y) / 2;
      if (at(m) > target) y = m;
      else x = m;
    }
    b = x;
  }
  return at(a) === target && at(b) === target && a <= b ? [a, b] : null;
}

/**
 * Is `value` = round(rarity value x rewardMultiplierAt(d)) for some d in [a, b]? The multiplier is a
 * step per shelf zone above 60 m and continuous (and non-decreasing) below, so the trench part
 * reaches every whole number between its two ends.
 */
export function valueReachable(value, rarity, a, b) {
  const rv = RARITY_VALUE[rarity];
  for (const z of ZONES) {
    if (a < z.bottom && b >= z.top && Math.round(rv * z.rewardMultiplier) === value) return true;
  }
  const last = ZONES[ZONES.length - 1].bottom;
  if (b < last) return false;
  const lo = Math.round(rv * rewardMultiplierAt(Math.max(a, last)));
  const hi = Math.round(rv * rewardMultiplierAt(b));
  return value >= lo && value <= hi;
}

/** The value range the current generator gives `rarity` on [a, b] (for messages). */
function valueRange(rarity, a, b) {
  const rv = RARITY_VALUE[rarity];
  return [Math.round(rv * rewardMultiplierAt(a)), Math.round(rv * rewardMultiplierAt(b))];
}

/**
 * The generator check. `facts`: { id, rarity, species, depth, value } as on-chain.
 *   strict (new mints): some generator version must give this species for (seed, rarity), this
 *     rarity at a spawn depth within SPAWN_TOLERANCE_M of `depth` with that version's odds, and
 *     exactly this catch value at one of those depths.
 *   legacy (fish minted before the collection, and every sale): also accepts the old fixed zone
 *     odds the game rolled with on its first day (v1 only), an old fish's value from that day's
 *     formula (rarity value x zone multiplier) or its plain rarity value, and a missing value.
 * Nothing on-chain records the generator version, so every version is tried (newest first). That
 * is no wider for a forger than one version: any seed is theirs to pick and every version reaches
 * the same top value (a mythic below 235 m); the limits bound what a forger can take: the mint
 * quota per game wallet and the daily PEARL cap per seller.
 * The same holds for player_state's lifetime banked value (record_catch rides in every co-signed
 * mint): a client picks its seeds, so it can mint only top-value fish and inflate lifetime_value,
 * opening maps and ships sooner. An accepted hackathon limitation, bounded by the mint quota per
 * game wallet (MINTS_PER_HOUR, 240 an hour per session key that signed the request,
 * assertSignedByPayer; one count across all instances on a serverless host, KvQuota). That bounds
 * a forger per session key, which is no weaker than the old per-owner count: owner wallets were
 * already free to create, like session keys. There is no backfill and no separate value cap.
 * Returns { ok: true, fish, version } (fish = that version's fish for this seed and rarity) or { ok: false, reason }.
 */
export function checkFish(facts, { legacy = false, tolerance = SPAWN_TOLERANCE_M } = {}) {
  const { id, rarity, species, depth, value } = facts;
  const seed = seedOfId(id);
  if (seed === null) return { ok: false, reason: `Bad fish seed "${id || '(missing)'}"` };
  if (!Object.hasOwn(RARITY_VALUE, rarity)) return { ok: false, reason: `Unknown rarity "${rarity || '(missing)'}"` };
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH_M) return { ok: false, reason: `Bad depth "${depth}"` };
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) return { ok: false, reason: `Bad catch value "${value}"` };
  if (value === undefined && !legacy) return { ok: false, reason: 'The catch value is missing' };

  const grown = GENERATORS.map((gen) => ({ gen, fish: gen.fishOf(seed, rarity) }));
  const matching = grown.filter((g) => g.fish.species === species);
  if (!matching.length) {
    const could = [...new Set(grown.map((g) => g.fish.species))].join(' or ');
    return { ok: false, reason: `Fish ${id} is not a ${species || '(no species)'}: a ${rarity} from this seed is a ${could}` };
  }
  let failed = null;
  for (const { gen, fish } of matching) {
    const reason = depthAndValueProblem(gen, seed, facts, { legacy, tolerance });
    if (!reason) return { ok: true, fish, version: gen.version };
    failed ??= reason;
  }
  return { ok: false, reason: failed };
}

/** Could generator `gen` have rolled this rarity and catch value near the recorded depth? A reason, or null. */
function depthAndValueProblem(gen, seed, { id, rarity, depth, value }, { legacy, tolerance }) {
  const lo = Math.max(0, depth - tolerance);
  const hi = depth + tolerance;
  const span = rarityInterval(seed, rarity, lo, hi, gen);
  const rv = RARITY_VALUE[rarity];
  if (span) {
    if (value === undefined || valueReachable(value, rarity, span[0], span[1])) return null;
    if (legacy && value === rv) return null;
  }
  if (legacy) {
    for (const z of gen.legacyZones) {
      if (depth < z.top - tolerance || depth >= z.bottom + tolerance) continue;
      if (new Rng(seed).weighted(z.odds) !== rarity) continue;
      if (value === undefined || value === rv || value === Math.round(rv * z.rewardMultiplier)) return null;
    }
  }
  if (!span) return `Fish ${id} cannot be ${rarity} when caught at ${depth} m`;
  const [min, max] = valueRange(rarity, span[0], span[1]);
  return `Catch value ${value} does not fit a ${rarity} caught at ${depth} m (${min}–${max})`;
}

// ---- The asset itself ------------------------------------------------------------------------

/** Fields fetchAsset returns that are not plugins. */
const BASE_FIELDS = new Set(['publicKey', 'header', 'pluginHeader', 'key', 'owner', 'updateAuthority', 'name', 'uri', 'seq', 'attributes']);

/**
 * Anything on the asset besides its Attributes that could change it after the market checked it:
 * an update delegate (it may rewrite Attributes), permanent delegates, external plugins (lifecycle
 * hooks, oracles, …), or Attributes held by someone other than the update authority. Fish minted
 * by the game carry Attributes only. Returns a reason, or null.
 */
export function pluginProblem(asset) {
  const authority = asset?.attributes?.authority?.type;
  if (!asset?.attributes) return 'The fish has no Attributes';
  if (authority !== 'UpdateAuthority') return `Its Attributes are controlled by ${authority ?? 'an unknown authority'}, not by the collection`;
  for (const [k, v] of Object.entries(asset)) {
    if (BASE_FIELDS.has(k) || v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
    return `It carries a "${k}" plugin, which a game fish never has`;
  }
  return null;
}

const NOT_SELLABLE = 'only fish minted by the game (the Breathless Fish collection) can be sold';

/**
 * Does the asset carry a fish's attributes at all (a seed)? The game's Boat and Dive Kit NFTs
 * (game/src/gear-nft.ts: kind, schema, levels) are minted by the same session key, outside any
 * collection, like a fish from before the collection: without this they would be told to migrate.
 */
const hasFishFacts = (asset) => readFacts(asset?.attributes?.attributeList).id !== '';

/**
 * THE gate before any price (quote, quote-batch, sell, sell-batch, program-mode quotes): returns
 * the fish's price in PEARL or throws HttpError(422). The market pays only fish in its collection
 * whose on-chain facts its own generator agrees with.
 */
export function assertTrustedFish(asset, { collection }) {
  const ua = asset?.updateAuthority;
  if (!collection) throw new HttpError(503, 'The market is still creating its fish collection, try again shortly');
  if (ua?.type !== 'Collection' || String(ua.address) !== String(collection)) {
    const legacy = ua?.type === 'Address' && hasFishFacts(asset);
    throw new HttpError(
      422,
      legacy
        ? 'This fish is not in the Breathless Fish collection yet: the game moves it there before selling (open your collection)'
        : `Not a Breathless fish: ${NOT_SELLABLE}`,
      { code: legacy ? 'not-in-collection' : 'not-a-fish' },
    );
  }
  const plugin = pluginProblem(asset);
  if (plugin) throw new HttpError(422, `Not sellable: ${plugin}`);
  const list = asset.attributes?.attributeList;
  const check = checkFish(readFacts(list), { legacy: true });
  if (!check.ok) throw new HttpError(422, `Not sellable: ${check.reason}`);
  const a = appraise(list);
  if (!a.ok) throw new HttpError(422, a.reason);
  return a.pearls;
}

// ---- Co-signed mint ----------------------------------------------------------------------------

const SERIAL_NAME = /^(.*) #(\d{4,9})$/;
const MAX_URI = 300;

/**
 * POST /api/market/cosign-mint: { owner, payer, asset, name, uri, fish: { id, rarity, species, depth, value }, signature }.
 * (`signature`: checked by assertSignedByPayer, not here.)
 * Validates everything that will go on-chain against the generator and returns what to mint:
 * { owner, payer, asset, name, uri, fishId, attributeList }. Throws HttpError(400 | 422).
 */
export function parseCosignMint(body, { market, tolerance } = {}) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Expected a JSON object');
  const { owner, payer, asset, name, uri, fish } = body;
  for (const [k, v] of Object.entries({ owner, payer, asset })) if (!isAddress(v)) throw new HttpError(400, `${k} must be a base58 address`);
  if (new Set([owner, payer, asset]).size !== 3) throw new HttpError(400, 'owner, payer and asset must be different accounts');
  // The market signs this transaction: it must never pay for it, own it or be the new asset.
  if ([owner, payer, asset].includes(market)) throw new HttpError(400, 'The market wallet cannot pay for, own or be a minted fish');
  if (!fish || typeof fish !== 'object') throw new HttpError(400, 'fish must be { id, rarity, species, depth, value }');
  const facts = {
    id: String(fish.id ?? ''),
    rarity: String(fish.rarity ?? ''),
    species: String(fish.species ?? ''),
    depth: Number(fish.depth),
    value: Number(fish.value),
  };
  const check = checkFish(facts, { legacy: false, tolerance });
  if (!check.ok) throw new HttpError(422, `This catch does not match the game: ${check.reason}`, { code: 'invalid-fish' });
  const spec = check.fish;

  if (typeof name !== 'string') throw new HttpError(400, 'name must be a string');
  const numbered = SERIAL_NAME.exec(name);
  const serial = numbered ? Number(numbered[2]) : undefined;
  if ((numbered ? numbered[1] : name) !== spec.name || (numbered && String(serial).padStart(4, '0') !== numbered[2])) {
    throw new HttpError(422, `The NFT name "${name.slice(0, 64)}" does not match this fish (${spec.name})`, { code: 'invalid-fish' });
  }

  if (typeof uri !== 'string' || uri.length > MAX_URI || !/^https?:\/\/[^/\s?#]+\/api\/nft\/meta\//.test(uri)) {
    throw new HttpError(400, 'uri must be the fish metadata URL (/api/nft/meta/...)');
  }
  let path;
  try {
    path = new URL(uri).pathname;
  } catch {
    throw new HttpError(400, 'uri must be the fish metadata URL (/api/nft/meta/...)');
  }
  const meta = parseMetaPath(path);
  const expected = {
    id: facts.id,
    rarity: facts.rarity,
    depthM: facts.depth,
    value: facts.value,
    lengthCm: spec.lengthCm,
    weightKg: spec.weightKg,
    lookPath: fishLook(spec),
    name: spec.name,
    serial,
  };
  const wrong = !meta ? ['path'] : Object.keys(expected).filter((k) => meta[k] !== expected[k]);
  if (wrong.length) throw new HttpError(422, `The metadata URI does not match this fish (${wrong.join(', ')})`, { code: 'invalid-fish' });

  return {
    owner,
    payer,
    asset,
    name,
    uri,
    /** The fish as checked (depth and value as numbers): what cosignMintMessage signs. */
    fish: facts,
    fishId: facts.id,
    /** The catch value checkFish accepted: what record_catch adds to the owner's lifetime value. */
    value: facts.value,
    attributeList: [
      { key: 'rarity', value: facts.rarity },
      { key: 'species', value: facts.species },
      { key: 'depth', value: String(facts.depth) },
      { key: 'value', value: String(facts.value) },
      { key: 'seed', value: facts.id },
    ],
  };
}

// ---- Legacy migration ----------------------------------------------------------------------------

/** POST /api/market/cosign-migrate: { owner, payer, assetIds: [...], signature }. Throws HttpError(400). */
export function parseCosignMigrate(body, { market } = {}) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Expected a JSON object');
  const { owner, payer, assetIds } = body;
  if (!isAddress(owner)) throw new HttpError(400, 'owner must be a base58 address');
  if (!isAddress(payer)) throw new HttpError(400, 'payer must be a base58 address');
  if (payer === market || owner === market) throw new HttpError(400, 'The market wallet cannot pay for or own a migrated fish');
  if (!Array.isArray(assetIds) || !assetIds.length) throw new HttpError(400, 'assetIds must be a non-empty array');
  if (assetIds.length > MIGRATE_BATCH) throw new HttpError(400, `At most ${MIGRATE_BATCH} fish per request`);
  if (!assetIds.every(isAddress)) throw new HttpError(400, 'assetIds must be base58 addresses');
  if (new Set(assetIds).size !== assetIds.length) throw new HttpError(400, 'The same fish is listed twice');
  if (assetIds.includes(payer) || assetIds.includes(market)) throw new HttpError(400, 'assetIds must be fish');
  return { owner, payer, assetIds: [...assetIds] };
}

// ---- Who asks: the game wallet's signature on a co-sign request -----------------------------------

/**
 * Both co-sign routes charge a quota per game wallet (the session key named as `payer`: the fee
 * payer and a required signer of every transaction they return). So the request itself must be
 * signed by that key, or anyone could name someone else's key and spend their quota without
 * signing anything. The signed bytes are the UTF-8 of one of these strings: a domain tag naming
 * the route (a mint signature never verifies as a migration), then the request's fields joined by
 * `|`, each with `\` and `|` escaped by a `\`, so no field can spill into the next. The game builds
 * the same strings (game/src/fish-cosign.ts); sensor/test/fixtures/cosign-request-vector.json pins
 * both sides to one vector.
 *
 * No timestamp or nonce: a replayed request spends nothing new in the common case. A replayed mint
 * whose answer was issued finds its own asset in the registry (claim -> 'same': no quota taken); a
 * replayed migration finds its fish registered to the same assets (fresh = 0). Not airtight: the
 * game signs a fresh asset on each retry of a fish, so an older captured request for a fish that
 * never landed reads as 'free' again once the newer one's blockhash expired (one take per fish per
 * blockhash lifetime, ~1-2 minutes), and so does a request that failed between its quota take and
 * its registry write. Either way only the signer's own quota is spent, and only by whoever holds
 * its signed requests (sent over TLS to us). (Replays of one's own request for someone else's fish
 * id are another matter: see claim in fish-collection.mjs.)
 */
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

export const COSIGN_MINT_DOMAIN = 'breathless-cosign-mint';
export const COSIGN_MIGRATE_DOMAIN = 'breathless-cosign-migrate';

/** The string the payer signs for POST /cosign-mint (fields as parseCosignMint returns them). */
export function cosignMintMessage({ owner, payer, asset, name, uri, fish }) {
  return [COSIGN_MINT_DOMAIN, owner, payer, asset, name, uri, fish.id, fish.rarity, fish.species, fish.depth, fish.value].map(esc).join('|');
}

/** The string the payer signs for POST /cosign-migrate: the asset ids in request order, comma-separated (base58: no `,` or `|`). */
export function cosignMigrateMessage({ owner, payer, assetIds }) {
  return [COSIGN_MIGRATE_DOMAIN, owner, payer, assetIds.join(',')].map(esc).join('|');
}

/**
 * Encodings of the ed25519 points of small order (the identity, the point of order 2, the four of
 * order 4 and 8), and the non-canonical ones (y = p, p + 1), compared without the sign bit: the
 * blocklist libsodium uses (crypto_sign_verify_detached refuses these public keys). With one as the
 * public key, a signature like R = identity, S = 0 verifies for every message (node:crypto accepts
 * it), so a "signature" by such a key proves nothing. Refused before verifying.
 */
const SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map((h) => Buffer.from(h, 'hex'));

/** Is this 32-byte public key a small-order point (in any encoding, either sign)? */
export function isSmallOrderKey(bytes) {
  return SMALL_ORDER.some((b) => b.every((x, i) => (i === 31 ? (bytes[31] & 0x7f) === x : bytes[i] === x)));
}

/** A 64-byte ed25519 signature in standard base64. */
const SIGNATURE_B64 = /^[A-Za-z0-9+/]{86}==$/;

/** The HttpError code of a missing or bad request signature (a game bundle from before it, or a forger). */
export const BAD_SIGNATURE_CODE = 'bad-request-signature';

/**
 * Throws HttpError(401, code bad-request-signature) unless `signature` (base64) is `payer`'s
 * ed25519 signature of `message`. Pure (node:crypto). A game tab from before this check sends no
 * signature: the message says to refresh, and the game keeps the fish queued (game/src/market.ts
 * mintPauseOf, migrateBank: they match "not signed by its game wallet", keep that phrase).
 */
export function assertSignedByPayer(message, payer, signature) {
  let ok = false;
  if (typeof signature === 'string' && SIGNATURE_B64.test(signature)) {
    try {
      const key = publicKeyBytes(payer);
      const x = Buffer.from(key).toString('base64url');
      ok = !isSmallOrderKey(key) && ed25519Verify(null, Buffer.from(message, 'utf8'), { key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }, Buffer.from(signature, 'base64'));
    } catch {
      ok = false; // payer is not 32 bytes, or not a curve point
    }
  }
  if (ok) return;
  const why = signature === undefined ? 'no signature' : 'the signature does not match';
  throw new HttpError(401, `This market request is not signed by its game wallet (${why}): refresh the page to load the latest game. Your fish stay queued.`, {
    code: BAD_SIGNATURE_CODE,
  });
}

/**
 * Can this asset (fetched from chain) move into the collection, co-signed by `payer` (the game's
 * session key, which must be its update authority)? Returns a reason it cannot, or null.
 */
export function migrationProblem(asset, { owner, payer, collection }) {
  if (!asset) return 'Fish not found on-chain';
  const ua = asset.updateAuthority;
  if (ua?.type === 'Collection' && String(ua.address) === String(collection)) return 'Already in the Breathless Fish collection';
  if (String(asset.owner) !== owner) return 'This fish belongs to another wallet';
  if (ua?.type !== 'Address') return `Not a Breathless fish: ${NOT_SELLABLE}`;
  if (!hasFishFacts(asset)) return `Not a Breathless fish: ${NOT_SELLABLE}`;
  if (String(ua.address) !== payer) return 'Minted with this wallet\'s game key on another device or browser: open the game there to make it sellable';
  const plugin = pluginProblem(asset);
  if (plugin) return plugin;
  const check = checkFish(readFacts(asset.attributes?.attributeList), { legacy: true });
  return check.ok ? null : `Its attributes do not match the game: ${check.reason}`;
}

/** Created before the collection existed (plus a grace for old game tabs)? `firstSlot` null: no history left, so old. */
export const isLegacyEra = (firstSlot, collectionSlot, graceSlots) =>
  firstSlot === null || firstSlot === undefined || firstSlot < collectionSlot + graceSlots;

// ---- One mint per (owner, fish) ------------------------------------------------------------------

/**
 * Which asset each owner's fish was co-signed (or migrated) into: "<owner>/<fish id>" ->
 * { asset, lastValid, kind, at }. Stops one valid seed from being minted again and again, and lets
 * a retried mint whose first attempt never landed go through. `append(entry)` persists one line.
 */
export class FishRegistry {
  constructor(entries = [], append = () => {}) {
    this.map = new Map();
    for (const e of entries) if (e && typeof e.k === 'string') this.map.set(e.k, e);
    this.append = append;
  }

  static key = (owner, fishId) => `${owner}/${fishId}`;

  get(owner, fishId) {
    return this.map.get(FishRegistry.key(owner, fishId)) ?? null;
  }

  set(owner, fishId, { asset, lastValid = null, kind }, now = Date.now()) {
    const e = { k: FishRegistry.key(owner, fishId), asset, lastValid, kind, at: now };
    this.map.set(e.k, e);
    this.append(e);
    return e;
  }
}

/** Parse a JSON-lines registry file (bad lines are skipped). */
export function parseRegistry(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

// ---- Quotas (per game wallet: the co-sign routes key them by the signed payer) ----------------------

/** Fixed window per key that can say when it opens again. */
export class Quota {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.windows = new Map();
  }

  /** Take `n` (all or nothing): { ok: true } or { ok: false, retryAfterMs }. */
  take(key, n = 1, now = Date.now()) {
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, used: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 10_000) for (const [k, x] of this.windows) if (now - x.start >= this.windowMs) this.windows.delete(k);
    }
    if (w.used + n > this.limit) return { ok: false, retryAfterMs: Math.max(1000, w.start + this.windowMs - now) };
    w.used += n;
    return { ok: true };
  }
}

/** Compare-and-set tries before a KvQuota take gives up (other instances took from the same key each time). */
const QUOTA_CAS_TRIES = 8;

/** A KvQuota record ({ start, used }) or null when there is none or it is unreadable. */
function parseWindow(raw) {
  if (raw === null) return null;
  try {
    const w = JSON.parse(raw);
    return Number.isFinite(w?.start) && Number.isInteger(w?.used) ? w : null;
  } catch {
    return null;
  }
}

/**
 * Quota with its windows in the store's KV (market-store.mjs), for a serverless host: every
 * instance takes from one count per key, where a Quota per instance would let each cold start and
 * each concurrent instance mint its own full quota. Same answers as Quota, async. One JSON record
 * { start, used } per key under kv key quota:<name>:<key>, written only by compare-and-set with a
 * TTL of what is left of its window, so a record never lacks a TTL or outlives its window; a lost
 * race reads again. A KV error propagates and the take is refused (fail closed, like the link
 * relay's limits; the co-sign needs the store's registry anyway).
 */
export class KvQuota {
  constructor({ kv, name, limit, windowMs }) {
    this.kv = kv;
    this.name = name;
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Take `n` (all or nothing): { ok: true } or { ok: false, retryAfterMs }. */
  async take(key, n = 1, now = Date.now()) {
    const k = `quota:${this.name}:${key}`;
    for (let i = 0; i < QUOTA_CAS_TRIES; i++) {
      const raw = await this.kv.get(k);
      let w = parseWindow(raw);
      const fresh = !w || now - w.start >= this.windowMs;
      if (fresh) w = { start: now, used: 0 };
      const left = Math.max(1, w.start + this.windowMs - now); // > 0: a TTL of 0 would mean none
      if (w.used + n > this.limit) {
        // Quota opens the window even when it then refuses (n > limit); so does this.
        if (fresh && !(await this.kv.cas(k, raw, JSON.stringify(w), { ttlMs: left }))) continue;
        return { ok: false, retryAfterMs: Math.max(1000, w.start + this.windowMs - now) };
      }
      if (await this.kv.cas(k, raw, JSON.stringify({ start: w.start, used: w.used + n }), { ttlMs: left })) return { ok: true };
    }
    throw new HttpError(503, 'The mint quota is busy, retry in a few seconds');
  }
}

const clock = (ms) => new Date(ms).toISOString().slice(11, 16);

/** The 429 for a mint quota. */
export function mintLimitError(what, limit, retryAfterMs, now = Date.now()) {
  return new HttpError(
    429,
    `${what} limit reached: at most ${limit} per game wallet per hour. Your fish stay queued; this continues at ${clock(now + retryAfterMs)} UTC.`,
    { code: 'mint-limit', retryAfterMs },
  );
}

// ---- Daily payout cap ------------------------------------------------------------------------------

/**
 * Payments to `seller` in the window ending `now`, oldest first: [{ at, pearls }]. Every sale record
 * counts (paying, paid, burned); a fish the market sent back (refunding, refunded) was never paid.
 */
function recentPayments(records, seller, now, windowMs) {
  const out = [];
  for (const r of Object.values(records ?? {})) {
    if (r?.status === 'refunding' || r?.status === 'refunded') continue;
    if (r?.seller === seller && now - r.at < windowMs) out.push({ at: r.at, pearls: Number(r.pearls) || 0 });
  }
  return out.sort((x, y) => x.at - y.at);
}

export function paidInWindow(records, seller, now = Date.now(), windowMs = PAYOUT_WINDOW_MS) {
  return recentPayments(records, seller, now, windowMs).reduce((s, p) => s + p.pearls, 0);
}

/** Throws HttpError(429) if paying `pearls` more (after `pending` already promised) would take `seller` over the cap. */
export function checkPayoutCap(records, seller, pearls, { now = Date.now(), cap = DAILY_PEARL_CAP, windowMs = PAYOUT_WINDOW_MS, pending = 0 } = {}) {
  const recent = recentPayments(records, seller, now, windowMs);
  const total = recent.reduce((s, p) => s + p.pearls, 0) + pending;
  if (total + pearls <= cap) return;
  let paid = total;
  // When will enough of today's payments have aged out?
  let at = now;
  for (const p of recent) {
    paid -= p.pearls;
    at = p.at + windowMs;
    if (paid + pearls <= cap) break;
  }
  const fmt = (n) => n.toLocaleString('en-US');
  throw new HttpError(
    429,
    `Daily PEARL limit reached: this wallet was paid ${fmt(total)} of ${fmt(cap)} PEARL in the last 24 hours. ` +
      `Keep this fish (${fmt(pearls)} PEARL); it can be sold after ${clock(at)} UTC.`,
    { code: 'daily-cap', retryAfterMs: Math.max(1000, at - now) },
  );
}

/**
 * /quote-batch: each quote passed the cap alone; together they may not. Walk them in order and
 * refuse the ones that would go over, so the player never hands over a fish the market won't pay.
 */
export function capQuotes(records, seller, { quotes }, opts = {}) {
  let pending = 0;
  return {
    quotes: quotes.map((q) => {
      if (q.error || !Number.isFinite(q.pearls)) return q;
      try {
        checkPayoutCap(records, seller, q.pearls, { ...opts, pending });
        pending += q.pearls;
        return q;
      } catch (e) {
        return { ...e.extra, assetId: q.assetId, status: e.status, error: e.message }; // { code: 'daily-cap', retryAfterMs }
      }
    }),
  };
}
