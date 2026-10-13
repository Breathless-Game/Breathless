// GET /api/market/fish?owner=<pubkey>: the game's fish NFTs a wallet owns on chain, each re-derived
// from its seed, so a browser that lost its local save (cleared storage, another device) can
// rebuild its aquarium from the chain. Read-only and stateless: the owner's Core assets (DAS when
// the RPC has it, else getProgramAccounts; see "Listing the assets" below), the market's own trust
// rules, and an in-memory cache for a few seconds.
// Nothing about the player is written anywhere; the chain is the record.
//
//   -> { owner, collection, at, fish: [{ assetId, name, uri, trust, version, facts, spec }] }
//      trust     'collection'  in the market's fish collection and the generator agrees (sellable)
//                'legacy'      minted by a game session key before the collection existed; passes
//                              the same generator check (the game moves it into the collection)
//      version   the generator version that grows this fish (fish-gen.mjs GENERATORS)
//      facts     the on-chain Attributes: { id, rarity, species, depth, value? }
//      spec      the fish as the game rolled it: that version's fishOf(seed, rarity), with the
//                recorded depth and catch value
//
// Anything else the wallet holds is left out: Boat / Dive Kit gear (no fish seed), NFTs from other
// collections, and fish whose attributes the generator cannot produce.

import { HttpError, singleFlight } from './market-rules.mjs';
import { assertTrustedFish, checkFish, pluginProblem, readFacts } from './fish-trust.mjs';
import { isPubkey } from './market-balance.mjs';

export const OWNED_FISH_TTL_MS = 8_000;
const MAX_ENTRIES = 2_000;

/** Validate the query. Throws HttpError(400). */
export function parseOwnedQuery(params) {
  const owner = params.get('owner');
  if (!isPubkey(owner)) throw new HttpError(400, 'owner must be a base58 public key');
  return { owner };
}

/**
 * One asset (as mpl-core deserialises it) -> an entry, or { skip: reason } for anything that is not
 * one of the game's fish. `collection`: the market's fish collection, or null (program mode, or not
 * created yet): then only the legacy path applies.
 */
export function classifyOwned(asset, { collection }) {
  const facts = readFacts(asset?.attributes?.attributeList);
  if (!facts.id) return { skip: 'not-a-fish' }; // gear, or a foreign NFT
  const ua = asset.updateAuthority;
  const inCollection = !!collection && ua?.type === 'Collection' && String(ua.address) === String(collection);
  let trust;
  if (inCollection) {
    try {
      assertTrustedFish(asset, { collection });
    } catch (e) {
      return { skip: e?.extra?.code ?? 'untrusted' };
    }
    trust = 'collection';
  } else if (ua?.type === 'Address') {
    if (pluginProblem(asset)) return { skip: 'plugin' };
    trust = 'legacy';
  } else {
    return { skip: 'not-a-fish' }; // another collection's NFT that happens to carry a seed
  }
  const check = checkFish(facts, { legacy: true });
  if (!check.ok) return { skip: 'generator' };
  const spec = { ...check.fish, depthM: facts.depth };
  if (facts.value === undefined) delete spec.value;
  else spec.value = facts.value;
  return {
    assetId: String(asset.publicKey),
    name: String(asset.name ?? ''),
    uri: String(asset.uri ?? ''),
    trust,
    version: check.version,
    facts,
    spec,
  };
}

/**
 * deps:
 *   fetchOwned(owner) -> assets[]   every Core asset the owner holds (createOwnedFetcher)
 *   collection() -> string | null   the market's fish collection
 */
export function createOwnedFishReader({ fetchOwned, collection, ttlMs = OWNED_FISH_TTL_MS, now = Date.now, maxEntries = MAX_ENTRIES }) {
  const cache = new Map(); // owner -> { at, value }
  const reading = new Map(); // owner -> { gen, reads } while a read is in flight (see market-balance.mjs)
  const flights = new Map();

  async function readChain(owner) {
    const [assets, coll] = await Promise.all([fetchOwned(owner), collection()]);
    const fish = [];
    for (const a of assets ?? []) {
      if (String(a?.owner) !== owner) continue; // the memcmp said so; check anyway
      const e = classifyOwned(a, { collection: coll ?? null });
      if (!e.skip) fish.push(e);
    }
    return { owner, collection: coll ?? null, at: now(), fish };
  }

  function store(owner, value) {
    cache.set(owner, { at: now(), value });
    if (cache.size <= maxEntries) return;
    const t = now();
    for (const [k, e] of cache) if (t - e.at >= ttlMs) cache.delete(k);
    for (const k of cache.keys()) {
      if (cache.size <= maxEntries) break;
      cache.delete(k);
    }
  }

  /** A sale moved fish out of this wallet: the next read goes to the chain. */
  function invalidate(owner) {
    if (!owner) return;
    const r = reading.get(owner);
    if (r) r.gen += 1; // a read already in flight will not store its (older) answer
    cache.delete(owner);
  }

  async function read({ owner }) {
    const hit = cache.get(owner);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    let r = reading.get(owner);
    if (!r) reading.set(owner, (r = { gen: 0, reads: 0 }));
    r.reads += 1;
    const gen = r.gen;
    return singleFlight(flights, `${owner}:${gen}`, async () => {
      const value = await readChain(owner);
      if (r.gen === gen) store(owner, value);
      return value;
    }).finally(() => {
      if (--r.reads === 0) reading.delete(owner);
    });
  }

  return { read, invalidate, size: () => cache.size, pending: () => reading.size };
}

// ---- Listing the assets ------------------------------------------------------------------------
//
// getProgramAccounts over the whole Core program is the heaviest call the market makes, and the
// first one a public RPC throttles. An RPC with the Metaplex DAS API keeps an owner index, so when
// the configured RPC has it:
//   1. getAssetsByOwner lists the owner's asset ids (paged; Core assets only, burnt ones dropped);
//   2. getMultipleAccounts reads those accounts, decoded exactly as getProgramAccounts' are.
// DAS is only the index: every field the trust rules look at (plugins, attributes, update
// authority, owner) still comes from the account bytes, so classifyOwned sees the same assets.
// Legacy fish sit outside the collection, so the listing cannot filter by collection. The index
// can lag a fresh mint by a few seconds; a sold fish it still lists fails readChain's owner check.
//
// No DAS (JSON-RPC "method not found"): getProgramAccounts for the rest of this instance's life.
// Any other DAS failure (429, timeout, a bad page): getProgramAccounts for that read only.

export const DAS_PAGE = 1000; // getAssetsByOwner's largest page
const DAS_MAX_PAGES = 10; // 10,000 assets; past that, getProgramAccounts
const ACCOUNTS_PER_CALL = 100; // getMultipleAccounts' limit
const DAS_TIMEOUT_MS = 10_000;

/** The RPC does not have this method at all (JSON-RPC -32601), as opposed to failing this time. */
export function isMethodNotFound(e) {
  return e?.code === -32601 || /method not found/i.test(String(e?.message ?? ''));
}

/**
 * One JSON-RPC call with named params, over plain fetch: umi's rpc.call resolves `undefined` for a
 * JSON-RPC error response, which would hide "method not found". Throws with .status (HTTP, so
 * rpc-guard's 429 backoff sees it) or .code (JSON-RPC).
 */
export function jsonRpc(url, { fetch = globalThis.fetch, timeoutMs = DAS_TIMEOUT_MS } = {}) {
  return async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw Object.assign(new Error(`${method}: HTTP ${res.status}`), { status: res.status });
    const body = await res.json();
    if (body?.error) throw Object.assign(new Error(`${method}: ${body.error.message ?? 'error'}`), { code: body.error.code });
    return body?.result;
  };
}

/** Every Core asset id the DAS index has for `owner`, page by page. Throws on anything odd. */
export async function listOwnedIds(call, owner, { pageSize = DAS_PAGE, maxPages = DAS_MAX_PAGES } = {}) {
  const ids = new Set(); // an index may list one asset twice; getProgramAccounts never does
  for (let page = 1; ; page++) {
    if (page > maxPages) throw new Error(`getAssetsByOwner: more than ${maxPages} pages`);
    const r = await call('getAssetsByOwner', { ownerAddress: owner, page, limit: pageSize });
    if (!Array.isArray(r?.items)) throw new Error('getAssetsByOwner: no items in the answer');
    for (const a of r.items) if (a?.interface === 'MplCoreAsset' && !a.burnt && typeof a.id === 'string') ids.add(a.id);
    if (r.items.length < pageSize) return [...ids];
  }
}

/**
 * Read these asset accounts, ACCOUNTS_PER_CALL at a time. getAccounts(ids) -> [{ exists, ... }] in
 * order; decode(account) -> asset (mpl-core's deserializeAssetV1, as getProgramAccounts uses). An
 * account that is gone, or no longer an asset (burnt since the index saw it), is skipped.
 */
export async function fetchAssetsByIds(ids, { getAccounts, decode }) {
  const out = [];
  for (let i = 0; i < ids.length; i += ACCOUNTS_PER_CALL) {
    for (const acc of await getAccounts(ids.slice(i, i + ACCOUNTS_PER_CALL))) {
      if (!acc?.exists) continue;
      try {
        out.push(decode(acc));
      } catch {}
    }
  }
  return out;
}

/**
 * fetchOwned for createOwnedFishReader. deps:
 *   das(method, params) -> result   a JSON-RPC call to the RPC (jsonRpc), or null: never try DAS
 *   fetchByIds(ids) -> assets[]     fetchAssetsByIds over the market's RPC
 *   fetchByGpa(owner) -> assets[]   the getProgramAccounts read
 *   label                           the RPC for logs, already redacted (a URL may hold an API key)
 * The first read is the probe; its verdict lives in memory only, per instance.
 */
export function createOwnedFetcher({ das, fetchByIds, fetchByGpa, label = 'the RPC', log = console.log, now = Date.now, pageSize = DAS_PAGE }) {
  let supported = das ? null : false; // null: not known yet
  let lastFailLog = -Infinity;

  return async function fetchOwned(owner) {
    if (supported === false) return fetchByGpa(owner);
    try {
      const assets = await fetchByIds(await listOwnedIds(das, owner, { pageSize }));
      if (supported === null) log(`[market] owned fish: ${label} has the DAS API, listing by owner index`);
      supported = true;
      return assets;
    } catch (e) {
      if (isMethodNotFound(e)) {
        supported = false;
        log(`[market] owned fish: ${label} has no DAS API, using getProgramAccounts`);
      } else if (now() - lastFailLog >= 60_000) {
        lastFailLog = now();
        log(`[market] owned fish: DAS read failed, getProgramAccounts this time: ${String(e?.message ?? e).split('\n')[0].slice(0, 160)}`);
      }
      return fetchByGpa(owner);
    }
  };
}
