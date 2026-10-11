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
//   checkMigratable(asset, ...)    whether a fish minted before the collection may move into it.
//   payout cap helpers             DAILY_PEARL_CAP per wallet per 24 h, from the sale ledger.
//
// Boat / Dive Kit gear NFTs (and anything else the session key mints) are never in the fish
// collection, so assertTrustedFish refuses them: the market can never buy one.

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
 * the same top value (a mythic below 235 m); the per-wallet limits bound what a forger can take.
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
 * POST /api/market/cosign-mint: { owner, payer, asset, name, uri, fish: { id, rarity, species, depth, value } }.
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
  const meta = parseMetaPath(new URL(uri).pathname);
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

/** POST /api/market/cosign-migrate: { owner, payer, assetIds: [...] }. Throws HttpError(400). */
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

// ---- Per-owner quota ---------------------------------------------------------------------------

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

const clock = (ms) => new Date(ms).toISOString().slice(11, 16);

/** The 429 for a mint quota. */
export function mintLimitError(what, limit, retryAfterMs, now = Date.now()) {
  return new HttpError(
    429,
    `${what} limit reached: at most ${limit} per wallet per hour. Your fish stay queued; this continues at ${clock(now + retryAfterMs)} UTC.`,
    { code: 'mint-limit', retryAfterMs },
  );
}

// ---- Daily payout cap ------------------------------------------------------------------------------

/** Payments to `seller` in the window ending `now`, oldest first: [{ at, pearls }]. Every ledger record counts (paying, paid, burned). */
function recentPayments(records, seller, now, windowMs) {
  const out = [];
  for (const r of Object.values(records ?? {})) {
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
        return { assetId: q.assetId, status: e.status, error: e.message };
      }
    }),
  };
}
