import { rollFish } from './fish';
import { cosignInfo } from './fish-cosign';
import { MAPS } from './maps';
import type { BankedFish } from './market';
import { bankedFromChain, entryFromAsset, mergeChainFish, type CoreAssetLike, type MergeResult, type OwnedFish } from './chain-fish';

// Brings the wallet's fish NFTs from the chain into the local bank (chain-fish.ts has the rules),
// so the aquarium and the collection are never empty just because this browser lost its save.
// The chain is the record; nothing about the player is stored on our server. Where the list
// comes from:
//   1. GET /api/market/fish (sensor/fish-owned.mjs): a stateless relay that reads the chain for us,
//      checks every NFT with the market's own trust rules and both generator versions, and caches
//      the answer a few seconds in memory. One read for every player instead of each browser
//      hammering the rate-limited public devnet RPC.
//   2. If the relay is unavailable (offline, or an older server without the route): the RPC
//      directly, with a short backoff on 429, taking only fish in the market's collection.
// Runs in the background after login and when the aquarium opens; it never blocks the game and
// fails quietly (a console.warn). It only ever adds fish: it never removes one.

const RELAY = '/api/market/fish';
/** After login, once the fish queue (4 s) and the gear sync (6 s) have had their turn. */
export const CHAIN_FISH_START_DELAY_MS = 9000;
/** Opening the aquarium again within this re-uses the last read. */
const MIN_INTERVAL_MS = 60_000;
/** The queue is minting or selling: look again after this. */
const BUSY_RETRY_MS = 20_000;
/** Backoff between direct RPC attempts when the RPC answers 429. */
const RPC_BACKOFF_MS = [4000, 12_000];

type ChainModule = { listOwnedAssets(owner: string): Promise<unknown[]> };

export interface ChainFishDeps {
  bank: BankedFish[];
  owner(): string | null;
  /** The fish queue is minting or selling right now. */
  busy(): boolean;
  /** The queue has this fish in hand. */
  holds(f: BankedFish): boolean;
  /** Fish were added or adopted: save and redraw. */
  changed(res: MergeResult): void;
  loadChain?(): Promise<ChainModule>;
}

/** The relay could not answer at all (as opposed to answering "slow down"). */
class RelayDown extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (e: unknown) => /\b429\b|too many requests/i.test(e instanceof Error ? e.message : String(e));

async function fromRelay(owner: string): Promise<OwnedFish[]> {
  let res: Response;
  try {
    res = await fetch(`${RELAY}?owner=${encodeURIComponent(owner)}`);
  } catch (e) {
    throw new RelayDown(String(e));
  }
  if (res.status === 429) throw new Error('fish relay: slow down');
  const body = (await res.json().catch(() => null)) as { owner?: unknown; fish?: unknown } | null;
  if (!res.ok || !body || body.owner !== owner || !Array.isArray(body.fish)) throw new RelayDown(`fish relay answered ${res.status}`);
  return (body.fish as OwnedFish[]).filter((f) => f && (f.trust === 'collection' || f.trust === 'legacy'));
}

async function fromRpc(owner: string, loadChain: () => Promise<ChainModule>): Promise<OwnedFish[]> {
  const collection = (await cosignInfo()).fishCollection ?? null;
  if (!collection) return [];
  const chain = await loadChain();
  let assets: unknown[] = [];
  for (let attempt = 0; ; attempt++) {
    try {
      assets = await chain.listOwnedAssets(owner);
      break;
    } catch (e) {
      if (!isRateLimit(e) || attempt >= RPC_BACKOFF_MS.length) throw e;
      await sleep(RPC_BACKOFF_MS[attempt]);
    }
  }
  const grow = (seed: number, rarity: BankedFish['rarity']) => rollFish(seed, 0, [[rarity, 1]]);
  return assets.map((a) => entryFromAsset(a as CoreAssetLike, { collection, grow })).filter((x): x is OwnedFish => x !== null);
}

export class ChainFishSync {
  private running: Promise<void> | null = null;
  private lastAt = 0;
  private timer = 0;
  private stopped = true;
  /** NFTs this page sold: the chain (or a cached read) may list them for a moment longer. */
  private readonly gone = new Set<string>();

  constructor(private deps: ChainFishDeps) {}

  /** A wallet's bank is loaded: sync once things have settled. */
  start(delay = CHAIN_FISH_START_DELAY_MS) {
    this.stopped = false;
    this.schedule(delay, true);
  }

  stop() {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.timer = 0;
  }

  /** Fish sold from this page left the wallet: never bring them back. */
  departed(assetIds: readonly (string | undefined)[]) {
    for (const id of assetIds) if (id) this.gone.add(id);
  }

  /** Sync now, unless one is running or ran in the last minute (force: ignore that). Never throws. */
  run(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    if (!force && Date.now() - this.lastAt < MIN_INTERVAL_MS) return Promise.resolve();
    this.running = this.sync()
      .catch((e) => console.warn('chain fish sync skipped', e))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private schedule(ms: number, force = false) {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      void this.run(force);
    }, ms);
  }

  private async sync() {
    const owner = this.deps.owner();
    if (!owner) return;
    if (this.deps.busy()) return this.schedule(BUSY_RETRY_MS, true);
    this.lastAt = Date.now();
    let owned: OwnedFish[];
    try {
      owned = await fromRelay(owner);
    } catch (e) {
      if (!(e instanceof RelayDown)) throw e;
      console.warn('fish relay unavailable, reading the chain directly', e.message);
      owned = await fromRpc(owner, this.deps.loadChain ?? (() => import('./chain')));
    }
    if (this.stopped || this.deps.owner() !== owner) return;
    // A sale may have started while we read: its fish are leaving the wallet. Look again later.
    if (this.deps.busy()) return this.schedule(BUSY_RETRY_MS, true);
    const incoming = owned.map((o) => bankedFromChain({ ...o, trusted: o.trust === 'collection' }, MAPS)).filter((f): f is BankedFish => f !== null);
    const res = mergeChainFish(this.deps.bank, incoming, { skip: (id) => this.gone.has(id), busy: (f) => this.deps.holds(f) });
    if (res.missing.length) console.info(`chain fish sync: ${res.missing.length} minted fish not listed for this wallet (kept)`, res.missing);
    if (res.added.length || res.adopted.length) this.deps.changed(res);
  }
}
