// GET /api/market/fish?owner=<pubkey>: the game's fish NFTs a wallet owns on chain, each re-derived
// from its seed, so a browser that lost its local save (cleared storage, another device) can
// rebuild its aquarium from the chain. Read-only and stateless: one getProgramAccounts on the Core
// program (owner memcmp), the market's own trust rules, and an in-memory cache for a few seconds.
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
 *   fetchOwned(owner) -> assets[]   every Core asset the owner holds (one getProgramAccounts)
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
