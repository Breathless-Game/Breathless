import type { Archetype, FishSpec, Rarity } from './fish';
import type { BankedFish } from './market';

// Rebuilding the bank from the chain: the fish NFTs a wallet owns are the record of what it caught,
// so a browser without the local save (cleared storage, another device) gets its aquarium back.
// This file is the pure part, with no runtime imports (tests/chain-fish.test.mjs loads it as is):
//   bankedFromChain()  one owned NFT -> the bank entry it was minted from
//   entryFromAsset()   the direct-RPC fallback's check of one Core asset (collection fish only)
//   mergeChainFish()   add what the local bank lacks; never removes anything
// chain-fish-sync.ts fetches (our stateless relay first, the RPC as a fallback) and schedules it.

const RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
const ARCHETYPES: readonly Archetype[] = ['slim', 'perch', 'disc', 'long', 'bulky'];
const MAX_DEPTH_M = 1000; // MAX_RECORDED_DEPTH_M in fish.ts

/** One owned fish NFT, as GET /api/market/fish returns it (sensor/fish-owned.mjs). */
export interface OwnedFish {
  assetId: string;
  name: string;
  uri: string;
  /** 'collection': in the market's collection (sellable). 'legacy': minted before it, by a session key. */
  trust: 'collection' | 'legacy';
  /** The fish as the game rolled it (the generator version that grows it), with its recorded depth and value. */
  spec: FishSpec;
}

/** The parts of an mpl-core AssetV1 the fallback reads. */
export interface CoreAssetLike {
  publicKey: unknown;
  owner: unknown;
  name: string;
  uri: string;
  updateAuthority: { type: string; address?: unknown };
  attributes?: { authority?: { type?: string }; attributeList?: { key: string; value: string }[] };
  [plugin: string]: unknown;
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The look and numbers a fish needs to render and be valued; anything else is not a fish. */
export function validSpec(s: unknown): s is FishSpec {
  const f = s as FishSpec | null;
  return (
    !!f &&
    typeof f === 'object' &&
    typeof f.id === 'string' &&
    /^[0-9a-f]{8}$/.test(f.id) &&
    f.seed === Number.parseInt(f.id, 16) &&
    RARITIES.includes(f.rarity) &&
    ARCHETYPES.includes(f.archetype) &&
    typeof f.species === 'string' &&
    !!f.species &&
    typeof f.name === 'string' &&
    !!f.name &&
    Number.isInteger(f.depthM) &&
    f.depthM >= 0 &&
    f.depthM <= MAX_DEPTH_M &&
    (f.value === undefined || (Number.isSafeInteger(f.value) && f.value >= 1)) &&
    [f.lengthCm, f.weightKg, f.hue, f.sat, f.light, f.accentHue, f.stripes, f.scale].every(finite)
  );
}

/** The fish's number: "… #0042" in the NFT name, else the v2/<serial>/ segment of its metadata URI. */
export function serialOf(name: string, uri: string): number | undefined {
  const m = / #(\d{4,9})$/.exec(name ?? '') ?? /\/api\/nft\/meta\/v2\/(\d{1,9})\//.exec(uri ?? '');
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** The zone label the metadata URI recorded (chain.ts zoneLabel), or null. */
export function zoneOf(uri: string): string | null {
  const m = /\/api\/nft\/meta\/(?:v1|v2\/\d+)\/[0-9a-f]{8}\/[a-z]+\/[^/]+\/[^/]+\/([^/]+)\/[^/]+\.json$/.exec(uri ?? '');
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** The map a zone label belongs to, when exactly one map uses it ("Sunken Forest"); else undefined. */
export function mapOfZone(zone: string | null, maps: Record<string, { zoneLabels: readonly string[] }>): string | undefined {
  if (!zone) return undefined;
  const hits = Object.keys(maps).filter((id) => maps[id].zoneLabels.includes(zone));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * The bank entry an owned fish NFT was minted from, as closely as the chain records it: the
 * generator's fish for its seed and rarity, the recorded depth and catch value, its number, and
 * where it was caught when the zone says. It is minted (nft 'minted', its assetId); `trusted` only
 * for fish in the market's collection, so the queue still moves an older fish in (or marks it
 * blocked). Its mint transaction is not known. Null if the spec is not a fish.
 */
export function bankedFromChain(
  o: Pick<OwnedFish, 'assetId' | 'name' | 'uri' | 'spec'> & { trusted: boolean },
  maps: Record<string, { zoneLabels: readonly string[] }> = {},
): BankedFish | null {
  if (!o || typeof o.assetId !== 'string' || !o.assetId || !validSpec(o.spec)) return null;
  const s = o.spec;
  const f: BankedFish = {
    id: s.id,
    seed: s.seed,
    rarity: s.rarity,
    species: s.species,
    name: s.name,
    archetype: s.archetype,
    lengthCm: s.lengthCm,
    weightKg: s.weightKg,
    depthM: s.depthM,
    hue: s.hue,
    sat: s.sat,
    light: s.light,
    accentHue: s.accentHue,
    stripes: s.stripes,
    scale: s.scale,
    assetId: o.assetId,
    nft: 'minted',
  };
  if (s.value !== undefined) f.value = s.value;
  const map = mapOfZone(zoneOf(o.uri), maps);
  if (map) f.map = map;
  const serial = serialOf(o.name, o.uri);
  if (serial !== undefined) f.serial = serial;
  // Same flags the queue would have set: a URI on our host needs no repair, nor a name with its number.
  if (typeof o.uri === 'string' && o.uri.includes('/api/nft/meta/')) f.metaFixed = true;
  if (serial !== undefined && / #\d{4,9}$/.test(o.name ?? '')) f.nameFixed = true;
  if (o.trusted) f.trusted = true;
  return f;
}

// ---- The direct-RPC fallback ----------------------------------------------------------------

/** Fields of a deserialised asset that are not plugins (sensor/fish-trust.mjs BASE_FIELDS). */
const BASE_FIELDS = new Set(['publicKey', 'header', 'pluginHeader', 'key', 'owner', 'updateAuthority', 'name', 'uri', 'seq', 'attributes']);
const normKey = (k: unknown) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

/** The fish facts chain.ts writes as Attributes (sensor/fish-trust.mjs readFacts). */
export function readFacts(list: readonly { key: string; value: string }[] | undefined) {
  const attrs = new Map<string, string>();
  for (const a of list ?? []) if (a && a.key != null) attrs.set(normKey(a.key), String(a.value ?? '').trim());
  const raw = attrs.get('catchvalue') ?? attrs.get('value');
  const depth = attrs.get('depth');
  return {
    id: attrs.get('seed') ?? '',
    rarity: (attrs.get('rarity') ?? '').toLowerCase(),
    species: attrs.get('species') ?? '',
    depth: depth !== undefined && depth !== '' ? Number(depth) : NaN,
    value: raw === undefined ? undefined : Number(raw),
  };
}

/**
 * Without our server, only fish in the market's collection are taken: the market admitted each
 * one after checking it against the generator (a co-signed mint or a migration), and only it can.
 * The asset must still look like a game fish (Attributes held by the collection, no other plugin)
 * and the game's own generator (`grow`, rollFish with the rarity fixed) must give its species for
 * its seed. Older fish outside the collection, and fish from an earlier generator, wait for the
 * server. Returns the owned fish, or null.
 */
export function entryFromAsset(
  asset: CoreAssetLike,
  { collection, grow }: { collection: string | null; grow: (seed: number, rarity: Rarity) => FishSpec },
): OwnedFish | null {
  if (!collection || !asset) return null;
  const ua = asset.updateAuthority;
  if (ua?.type !== 'Collection' || String(ua.address) !== collection) return null;
  if (asset.attributes?.authority?.type !== 'UpdateAuthority') return null;
  for (const [k, v] of Object.entries(asset)) {
    if (BASE_FIELDS.has(k) || v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
    return null;
  }
  const facts = readFacts(asset.attributes.attributeList);
  if (!/^[0-9a-f]{8}$/.test(facts.id) || !RARITIES.includes(facts.rarity as Rarity)) return null;
  if (!Number.isInteger(facts.depth) || facts.depth < 0 || facts.depth > MAX_DEPTH_M) return null;
  if (facts.value !== undefined && (!Number.isSafeInteger(facts.value) || facts.value < 1)) return null;
  const grown = grow(Number.parseInt(facts.id, 16) >>> 0, facts.rarity as Rarity);
  if (grown.species !== facts.species || grown.id !== facts.id) return null;
  const spec: FishSpec = { ...grown, depthM: facts.depth };
  delete spec.value;
  delete spec.map;
  delete spec.assetId;
  if (facts.value !== undefined) spec.value = facts.value;
  return { assetId: String(asset.publicKey), name: String(asset.name ?? ''), uri: String(asset.uri ?? ''), trust: 'collection', spec };
}

// ---- Merge ------------------------------------------------------------------------------------

export interface MergeResult {
  /** New bank entries (pushed onto the end of the bank). */
  added: BankedFish[];
  /** Local fish that were waiting to mint and turn out to be minted already: given their asset. */
  adopted: BankedFish[];
  /** Minted local fish the chain did not list for this wallet: kept (an RPC can be stale), reported only. */
  missing: string[];
}

/**
 * Bring the chain's fish into the bank, in place (the vault, the aquarium and the queue share the
 * array). Idempotent: a fish is matched by its assetId and never added twice. A local fish still
 * waiting to mint (no assetId) with the same seed and rarity is that NFT, minted earlier with the
 * answer lost (the market mints one asset per wallet and fish), so it is adopted instead of
 * duplicated; one the queue is minting or selling right now is left alone. Nothing is ever
 * removed: a fish missing on chain may be unminted, mid-sale, or the read may be stale.
 *   skip(assetId)  true for NFTs this page just sold (the chain may still list them for a moment)
 *   busy(fish)     true while the queue has the fish in hand
 */
export function mergeChainFish(
  bank: BankedFish[],
  incoming: readonly BankedFish[],
  { skip = () => false, busy = () => false }: { skip?: (assetId: string) => boolean; busy?: (f: BankedFish) => boolean } = {},
): MergeResult {
  const known = new Set<string>();
  for (const f of bank) if (f.assetId) known.add(f.assetId);
  const added: BankedFish[] = [];
  const adopted: BankedFish[] = [];
  for (const c of incoming) {
    const id = c?.assetId;
    if (!id || known.has(id) || skip(id)) continue;
    known.add(id);
    const twins = bank.filter((f) => !f.assetId && f.id === c.id && f.rarity === c.rarity);
    if (twins.length) {
      const twin = twins.find((f) => f.nft !== 'minting' && !busy(f));
      if (!twin) continue; // the queue is on it: its mint adopts this asset itself
      twin.assetId = id;
      twin.nft = 'minted';
      delete twin.mintTries;
      delete twin.mintError;
      delete twin.retryAt;
      if (c.serial !== undefined && twin.serial === undefined) twin.serial = c.serial;
      if (c.metaFixed) twin.metaFixed = true;
      if (c.nameFixed) twin.nameFixed = true;
      if (c.trusted) twin.trusted = true;
      adopted.push(twin);
      continue;
    }
    bank.push(c);
    added.push(c);
  }
  const onChain = new Set(incoming.map((c) => c?.assetId).filter(Boolean));
  const missing = bank.filter((f) => f.assetId && !onChain.has(f.assetId) && !skip(f.assetId)).map((f) => f.assetId!);
  return { added, adopted, missing };
}
