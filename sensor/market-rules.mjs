// Pure rules for the PEARL market, shared by both sell modes: what a fish NFT
// is worth, request validation, rate limiting, and (server mode) the transfer
// check and the ledger that makes a sale idempotent. No chain or file imports,
// so `node --test` covers all of it.

// Mirror of RARITY[*].value, ZONES and rewardMultiplierAt() in game/src/fish.ts
// (market-rules.test.mjs fails if the two drift apart).
export const RARITY_VALUE = Object.freeze({
  common: 1,
  uncommon: 3,
  rare: 10,
  epic: 35,
  legendary: 150,
  mythic: 800,
});

export const ZONES = Object.freeze([
  { name: 'Shallows', top: 0, bottom: 18, rewardMultiplier: 1 },
  { name: 'Coral Reef', top: 18, bottom: 38, rewardMultiplier: 1.6 },
  { name: 'The Abyss', top: 38, bottom: 60, rewardMultiplier: 2.5 },
]);

/** Where the trench multiplier stops growing (reached at 235 m); a claimed catch value above rarity value x this is rejected. */
export const MAX_MULTIPLIER = 6;
/** Below the last zone (The Trench) the multiplier gains 1 every this many metres. */
export const TRENCH_STEP_M = 50;
/**
 * The sea has no bottom, so the game clamps the depth it records on a fish (and writes
 * on-chain) to this: MAX_RECORDED_DEPTH_M in game/src/fish.ts, kept equal by the tests.
 * Odds and value stop changing well above it (350 m and 235 m).
 */
export const MAX_DEPTH_M = 1000;

export const MPL_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const TRANSFER_V1 = 14; // mpl-core TransferV1 discriminator; accounts: asset, collection, payer, authority, newOwner, ...

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function maxPearls(rarity) {
  return RARITY_VALUE[rarity] * MAX_MULTIPLIER;
}

export function zoneForDepth(depthM) {
  return ZONES.find((z) => depthM >= z.top && depthM < z.bottom) ?? ZONES[ZONES.length - 1];
}

/** Same as rewardMultiplierAt() in fish.ts: the zone's multiplier, then +1 per TRENCH_STEP_M below the last zone, capped. */
export function rewardMultiplierAt(depthM) {
  const last = ZONES[ZONES.length - 1];
  if (depthM < last.bottom) return zoneForDepth(depthM).rewardMultiplier;
  return Math.min(MAX_MULTIPLIER, last.rewardMultiplier + (depthM - last.bottom) / TRENCH_STEP_M);
}

/** Same formula as rollFish(): rarity value x the depth's reward multiplier. */
export function catchValue(rarity, depthM) {
  return Math.round(RARITY_VALUE[rarity] * rewardMultiplierAt(depthM));
}

const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Price a fish from its on-chain Core Attributes ([{ key, value }]).
 * chain.ts writes rarity / species / depth / value / seed. The on-chain catch value
 * ("Catch value" or "value") is used, so the sale pays what the game showed; fish
 * minted without one are recomputed from rarity and depth. It must be a whole number in [1, rarity value x 6], or the fish is
 * rejected. `maxValue` (the program's config.max_value) then clamps the price.
 */
export function appraise(attributeList, { maxValue } = {}) {
  const attrs = new Map();
  for (const a of attributeList ?? []) if (a && a.key != null) attrs.set(normKey(a.key), String(a.value ?? '').trim());

  const rarity = (attrs.get('rarity') ?? '').toLowerCase();
  if (!Object.hasOwn(RARITY_VALUE, rarity)) return { ok: false, reason: `Unknown rarity "${rarity || '(missing)'}"` };

  const depthRaw = attrs.get('depth');
  const depth = depthRaw === undefined || depthRaw === '' ? NaN : Number(depthRaw);
  if (!Number.isFinite(depth) || depth < 0 || depth > MAX_DEPTH_M) {
    return { ok: false, reason: `Bad depth "${depthRaw ?? '(missing)'}"` };
  }

  const cap = maxPearls(rarity);
  const claimedRaw = attrs.get('catchvalue') ?? attrs.get('value');
  let pearls;
  if (claimedRaw !== undefined) {
    const claimed = Number(claimedRaw);
    if (!Number.isSafeInteger(claimed) || claimed < 1) return { ok: false, reason: `Bad catch value "${claimedRaw}"` };
    if (claimed > cap) return { ok: false, reason: `Catch value ${claimed} is over the ${rarity} cap of ${cap}` };
    pearls = claimed;
  } else {
    pearls = Math.min(catchValue(rarity, depth), cap);
  }
  if (maxValue !== undefined && maxValue !== null) pearls = Math.min(pearls, Number(maxValue));
  if (pearls < 1) return { ok: false, reason: 'The market is not buying fish right now (max value is 0)' };
  return { ok: true, pearls, rarity, depth, cap };
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export const isAddress = (s) => typeof s === 'string' && s.length >= 32 && s.length <= 44 && BASE58.test(s);
const isSignature = (s) => typeof s === 'string' && s.length >= 64 && s.length <= 90 && BASE58.test(s);

/** Validate the POST /api/market/quote body. Throws HttpError(400). */
export function parseQuoteBody(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Expected a JSON object');
  const { assetId, seller } = body;
  if (!isAddress(assetId)) throw new HttpError(400, 'assetId must be a base58 address');
  if (!isAddress(seller)) throw new HttpError(400, 'seller must be a base58 address');
  return { assetId, seller };
}

/** Validate the POST /api/market/sell body (server mode). Throws HttpError(400). */
export function parseSellBody(body) {
  const { assetId, seller } = parseQuoteBody(body);
  if (!isSignature(body.transferTx)) throw new HttpError(400, 'transferTx must be a base58 signature');
  return { assetId, seller, transferTx: body.transferTx };
}

/**
 * Most fish in one /quote-batch or /sell-batch request. A Core transfer costs 44 bytes, so one
 * 1232-byte transaction carries at most 23; the client packs 20 per transaction, so this is a
 * little more than one full transaction's worth.
 */
export const MAX_BATCH = 24;

function parseBatchList(list, name) {
  if (!Array.isArray(list) || list.length < 1) throw new HttpError(400, `${name} must be a non-empty array`);
  if (list.length > MAX_BATCH) throw new HttpError(400, `At most ${MAX_BATCH} fish per request`);
  return list;
}

function noDuplicates(ids) {
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'The same fish is listed twice');
}

/** Validate POST /api/market/quote-batch: { seller, assetIds: [...] }. Throws HttpError(400). */
export function parseQuoteBatchBody(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Expected a JSON object');
  if (!isAddress(body.seller)) throw new HttpError(400, 'seller must be a base58 address');
  const assetIds = parseBatchList(body.assetIds, 'assetIds');
  for (const id of assetIds) if (!isAddress(id)) throw new HttpError(400, 'assetIds must be base58 addresses');
  noDuplicates(assetIds);
  return { seller: body.seller, assetIds: [...assetIds] };
}

/**
 * Validate POST /api/market/sell-batch (server mode): { seller, sales: [{ assetId, transferTx }] }.
 * Several sales may name the same transferTx (one transaction moved several fish). Prices are
 * never part of the body: the server appraises every fish from its on-chain attributes.
 */
export function parseSellBatchBody(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Expected a JSON object');
  if (!isAddress(body.seller)) throw new HttpError(400, 'seller must be a base58 address');
  const sales = parseBatchList(body.sales, 'sales').map((s) => {
    if (!s || typeof s !== 'object') throw new HttpError(400, 'Each sale must be { assetId, transferTx }');
    if (!isAddress(s.assetId)) throw new HttpError(400, 'assetId must be a base58 address');
    if (!isSignature(s.transferTx)) throw new HttpError(400, 'transferTx must be a base58 signature');
    return { assetId: s.assetId, transferTx: s.transferTx };
  });
  noDuplicates(sales.map((s) => s.assetId));
  return { seller: body.seller, sales };
}

/**
 * Server mode: check a fetched transaction (umi TransactionWithMeta, keys as
 * base58 strings) contains a successful mpl-core transfer of `assetId` to
 * `market` whose authority is `seller`, and that `seller` signed it. Returns
 * null when it does, else a reason string. The transaction may move other
 * fish too (a batch sale): only the instruction for `assetId` is looked at.
 */
export function checkTransferTx(tx, { assetId, seller, market }) {
  if (!tx) return 'Transfer transaction not found (not confirmed yet?)';
  if (tx.meta?.err) return 'Transfer transaction failed on-chain';
  const msg = tx.message;
  const keys = [
    ...msg.accounts,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ].map(String);
  const signers = keys.slice(0, msg.header.numRequiredSignatures);
  if (!signers.includes(seller)) return 'Transfer was not signed by the seller';
  const moves = msg.instructions.filter(
    (ix) =>
      keys[ix.programIndex] === MPL_CORE_PROGRAM &&
      ix.data?.[0] === TRANSFER_V1 &&
      keys[ix.accountIndexes[0]] === assetId &&
      keys[ix.accountIndexes[4]] === market,
  );
  if (!moves.length) return 'Transaction is not a transfer of this asset to the market';
  // TransferV1's authority (account 3) is the owner who let the fish go; Core fills an omitted
  // authority with its own program id and then uses the payer (account 2) instead.
  const authorityOf = (ix) => {
    const a = keys[ix.accountIndexes[3]];
    return a === MPL_CORE_PROGRAM || a === undefined ? keys[ix.accountIndexes[2]] : a;
  };
  return moves.some((ix) => authorityOf(ix) === seller) ? null : 'The seller did not transfer this fish';
}

/**
 * Server mode's sold set, keyed by asset id. A record moves paying -> paid ->
 * burned and is persisted after every step (via `persist`), so a retried
 * request returns the stored result instead of paying again.
 *
 * record: { seller, transferTx, pearls, status, payTx?, payLastValid?, burnTx?, at }
 */
export class SoldLedger {
  constructor(records = {}, persist = () => {}) {
    this.records = { ...records };
    this.persist = persist;
  }

  get(assetId) {
    return this.records[assetId] ?? null;
  }

  /**
   * What to do with a sell request:
   *   new      - never seen: verify, then pay
   *   resume   - paying but not confirmed paid (re-check the pay tx)
   *   burn     - paid, burn still pending
   *   done     - paid and burned: return the stored result
   *   conflict - sold by a different wallet
   */
  plan(assetId, seller) {
    const r = this.get(assetId);
    if (!r) return 'new';
    if (r.seller !== seller) return 'conflict';
    if (r.status === 'paying') return 'resume';
    if (r.status === 'paid') return 'burn';
    return 'done';
  }

  begin(assetId, { seller, transferTx, pearls }, now = Date.now()) {
    if (this.records[assetId]) throw new Error(`Asset ${assetId} already in the ledger`);
    this.records[assetId] = { seller, transferTx, pearls, status: 'paying', at: now };
    this.persist();
  }

  /** Persist the pay tx signature BEFORE sending it, so a crash can be resolved by looking it up. */
  payPending(assetId, payTx, payLastValid) {
    Object.assign(this.records[assetId], { payTx, payLastValid });
    this.persist();
  }

  /** The pay tx is known not to have landed (failed, or its blockhash expired): safe to pay again. */
  payDropped(assetId) {
    const r = this.records[assetId];
    delete r.payTx;
    delete r.payLastValid;
    this.persist();
  }

  paid(assetId) {
    this.records[assetId].status = 'paid';
    delete this.records[assetId].payLastValid;
    this.persist();
  }

  burned(assetId, burnTx) {
    Object.assign(this.records[assetId], { status: 'burned', burnTx });
    this.persist();
  }

  /** The client-facing SellResult: tx = the PEARL pay tx, extra = [transfer, burn]. */
  result(assetId) {
    const r = this.records[assetId];
    return { pearls: r.pearls, tx: r.payTx ?? '', extra: [r.transferTx, r.burnTx ?? ''] };
  }

  toJSON() {
    return this.records;
  }
}

/** Collapse concurrent calls for the same key onto one promise. */
export function singleFlight(map, key, fn) {
  const running = map.get(key);
  if (running) return running;
  const p = Promise.resolve()
    .then(fn)
    .finally(() => map.delete(key));
  map.set(key, p);
  return p;
}

/**
 * Run `fn` with `key` held: calls for the same key run one after another, never at once, each
 * with its own arguments (unlike singleFlight, a later caller is never handed an earlier caller's
 * outcome). The server sells every fish under its asset id, so a sale's ledger steps can't interleave.
 */
export function withLock(map, key, fn) {
  const prev = map.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  map.set(key, tail);
  void tail.then(() => {
    if (map.get(key) === tail) map.delete(key);
  });
  return run;
}

/** Map over `items` with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Fixed-window limiter per key (client IP). */
export class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** `cost`: how many hits this request counts as (a batch of fish costs more than one). */
  allow(key, now = Date.now(), cost = 1) {
    let w = this.hits.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.hits.set(key, w);
      if (this.hits.size > 10_000) this.prune(now);
    }
    w.count += cost;
    return w.count <= this.limit;
  }

  prune(now) {
    for (const [k, w] of this.hits) if (now - w.start >= this.windowMs) this.hits.delete(k);
  }
}
