import {
  GEAR_KINDS,
  GEAR_NAMES,
  gearAttributes,
  gearDebounceDue,
  gearJob,
  gearMetaPath,
  gearPathOfUri,
  gearRetryDelay,
  gearState,
  parseGearRecord,
  MAX_GEAR_FAILS,
  type GearAttribute,
  type GearFunds,
  type GearKind,
  type GearLevels,
  type GearRecord,
  type GearState,
} from './gear-nft';

// Keeps the player's Boat and Dive Kit NFTs (gear-nft.ts) in step with their upgrade levels, in the
// background. Gameplay never waits for it: levels apply locally at once, and this only ever reads
// them. It observes level changes (levelsChanged(), wired to gear-levels.ts), waits for them to
// settle (debounce), and then sends at most one transaction per NFT carrying the latest absolute
// levels. With no SOL or no network it waits and retries; after MAX_GEAR_FAILS failures in a row it
// pauses until the next level change. One worker per page: never two transactions at once.
//
// What has been synced lives per owner in storage (deepbreath.<owner>.gear-nft), so a page reload
// resumes whatever was left: the "queue" is simply the difference between the levels now and the
// levels last confirmed on chain. Dependencies are injected (no runtime imports but gear-nft.ts),
// so tests run this class with a fake chain and fake timers.

/** What the chain module (chain.ts, loaded lazily) provides. */
export interface GearChain {
  balanceSol(): Promise<number>;
  airdrop(amount?: number): Promise<void>;
  /** A fresh 64-byte secret for a new asset address. */
  newGearKey(): Uint8Array;
  /**
   * Mint one NFT to the owner, paid and update-authorised by the session key. If an asset already
   * exists at the secret's address (an earlier mint landed), it is adopted instead.
   */
  mintGear(req: GearMintRequest): Promise<{ asset: string; signature: string | null; uri: string }>;
  /** One transaction: the URI and the Attributes. 'missing'/'not-ours': mint a fresh one instead. */
  updateGear(req: GearUpdateRequest): Promise<{ status: 'updated' | 'ok' | 'missing' | 'not-ours'; signature?: string }>;
}

export interface GearMintRequest {
  kind: GearKind;
  name: string;
  path: string;
  attributes: GearAttribute[];
  secret: Uint8Array;
}

export interface GearUpdateRequest {
  asset: string;
  path: string;
  attributes: GearAttribute[];
}

export interface GearTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface GearSyncDeps {
  /** Storage key for this owner's record, or null with no wallet. */
  key(): string | null;
  store: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  /** The game (session) wallet's address, or null with no wallet. */
  session(): string | null;
  /** The levels now, or null while there are none (no wallet loaded). */
  snapshot(): GearLevels | null;
  loadChain(): Promise<GearChain>;
  isFundsError(message: string): boolean;
  timers: GearTimers;
  /** Status changed: redraw whatever shows it. */
  changed(): void;
  /** Hidden page: polls wait for it to come back. */
  hidden?(): boolean;
}

export interface GearSyncEvent {
  kind: GearKind;
  action: 'mint' | 'adopt' | 'update' | 'noop' | 'fail';
  path?: string;
  asset?: string;
  signature?: string | null;
  error?: string;
}

export interface GearNftStatus {
  kind: GearKind;
  state: GearState;
  asset?: string;
  tx?: string;
  /** Older assets this browser can no longer update (minted by another session key). */
  orphaned: string[];
}

export const GEAR_QUIET_MS = 2500; // upgrades closer together than this become one update
export const GEAR_MAX_WAIT_MS = 15_000; // … but a steady stream still lands this often
export const GEAR_START_DELAY_MS = 6000; // after login, once the fish queue has had its turn
export const MIN_GEAR_MINT_SOL = 0.01; // a Core asset with Attributes: rent ~0.004 SOL plus fees
export const MIN_GEAR_UPDATE_SOL = 0.001;
const POLL_MS = 60_000;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class GearSync {
  funds: GearFunds = 'unknown';
  balance: number | null = null;
  /** The NFT with a transaction in flight. */
  active: GearKind | null = null;
  /** Everything sent, newest last (for the console and tests). */
  readonly log: GearSyncEvent[] = [];

  private rec: GearRecord = { boat: {}, kit: {} };
  private recKey: string | null = null;
  private stopped = true;
  private busy = false;
  private again = false;
  private airdropTried = false;
  private firstChangeAt = 0;
  private lastChangeAt = 0;
  private debounceTimer = 0;
  private pollTimer = 0;
  private wakeTimer = 0;
  private startTimer = 0;
  /** The worker's current run, for tests and logout. */
  running: Promise<void> = Promise.resolve();

  constructor(public deps: GearSyncDeps) {}

  /** A wallet's progress is loaded: read its record and catch up after a short delay. */
  start(delay = GEAR_START_DELAY_MS) {
    this.stopped = false;
    this.load();
    this.clearTimer('startTimer');
    this.startTimer = this.deps.timers.setTimeout(() => {
      this.startTimer = 0;
      this.kick();
    }, delay);
    this.deps.changed();
  }

  /** Logging out: send nothing new. A transaction already sent finishes (or is found next login). */
  stop() {
    this.stopped = true;
    for (const t of ['startTimer', 'debounceTimer', 'pollTimer', 'wakeTimer'] as const) this.clearTimer(t);
  }

  /**
   * The hook: any level changed (bought, branch switched, ship equipped, or reset by a penalty).
   * Cheap and safe to call often; nothing is sent until the changes settle, and nothing at all if
   * the levels end up where the chain already is.
   */
  levelsChanged() {
    if (this.stopped) return;
    const now = this.deps.timers.now();
    if (!this.debounceTimer) this.firstChangeAt = now;
    this.lastChangeAt = now;
    // A level change gives a paused or backing-off NFT one more try now.
    for (const kind of GEAR_KINDS) {
      const r = this.rec[kind];
      if (r.retryAt !== undefined || (r.fails ?? 0) >= MAX_GEAR_FAILS) {
        delete r.retryAt;
        if ((r.fails ?? 0) >= MAX_GEAR_FAILS) r.fails = MAX_GEAR_FAILS - 1;
      }
    }
    this.clearTimer('debounceTimer');
    const due = gearDebounceDue(this.firstChangeAt, this.lastChangeAt, GEAR_QUIET_MS, GEAR_MAX_WAIT_MS);
    this.debounceTimer = this.deps.timers.setTimeout(() => {
      this.debounceTimer = 0;
      this.kick();
    }, Math.max(0, due - now));
    this.deps.changed();
  }

  /** Check again now (e.g. the game wallet was just topped up). */
  recheck() {
    this.clearTimer('pollTimer');
    this.kick();
  }

  status(kind: GearKind): GearNftStatus {
    const levels = this.deps.snapshot();
    const r = this.rec[kind];
    const state = gearState({
      rec: r,
      desired: levels && !this.stopped ? gearMetaPath(kind, levels) : null,
      session: this.deps.session(),
      funds: this.funds,
      active: this.active === kind,
      pending: this.debounceTimer !== 0,
      now: this.deps.timers.now(),
    });
    return { kind, state, asset: r.asset, tx: r.tx, orphaned: r.orphaned ?? [] };
  }

  kick() {
    if (this.stopped) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    this.running = this.run();
  }

  private async run() {
    this.busy = true;
    try {
      do {
        this.again = false;
        await this.pass();
      } while (this.again && !this.stopped && !this.debounceTimer);
    } catch (e) {
      console.warn('gear NFT sync stopped', e); // never into gameplay
    } finally {
      this.busy = false;
      this.deps.changed();
    }
  }

  /** One look at both NFTs: mint or update whichever is out of step. */
  private async pass() {
    for (const kind of GEAR_KINDS) {
      // Changes still settling: the debounce timer runs the next pass with the final levels.
      if (this.stopped || this.debounceTimer) return;
      const session = this.deps.session();
      const levels = this.deps.snapshot();
      if (!session || !levels || this.deps.key() !== this.recKey) return;
      const job = gearJob(this.rec[kind], gearMetaPath(kind, levels), session, this.deps.timers.now());
      if (job === null || job === 'paused') continue;
      if (job === 'wait') {
        this.scheduleWake(this.rec[kind].retryAt!);
        continue;
      }
      if (!(await this.ensureFunds(job === 'mint' ? MIN_GEAR_MINT_SOL : MIN_GEAR_UPDATE_SOL))) return;
      if (this.stopped || this.debounceTimer) return;
      if (job === 'mint') await this.mint(kind, session);
      else await this.update(kind, session);
    }
  }

  private async mint(kind: GearKind, session: string) {
    const r = this.rec[kind];
    if (r.asset) {
      // Recorded as minted by another session key: this one cannot update it. Keep a note, mint our own.
      r.orphaned = [...(r.orphaned ?? []), r.asset].slice(-8);
      delete r.asset;
      delete r.authority;
      delete r.synced;
      delete r.tx;
    }
    let path = '';
    this.active = kind;
    this.deps.changed();
    try {
      const c = await this.deps.loadChain();
      if (!r.pendingKey) {
        r.pendingKey = Array.from(c.newGearKey());
        this.save(); // before sending: a retry reuses this address, so a landed mint is found, not repeated
      }
      // Read the levels at the last moment: whatever changed meanwhile goes in this mint.
      const levels = this.deps.snapshot();
      if (!levels || this.stopped) return;
      path = gearMetaPath(kind, levels);
      const res = await c.mintGear({ kind, name: GEAR_NAMES[kind], path, attributes: gearAttributes(kind, levels), secret: Uint8Array.from(r.pendingKey) });
      const adopted = res.signature === null;
      r.asset = res.asset;
      r.authority = session;
      // Adopted: what it holds on chain is what is synced (an update follows if that is behind).
      r.synced = adopted ? (gearPathOfUri(res.uri) ?? undefined) : path;
      if (res.signature) r.tx = res.signature;
      delete r.pendingKey;
      this.succeeded(kind);
      this.record({ kind, action: adopted ? 'adopt' : 'mint', path, asset: res.asset, signature: res.signature });
      if (adopted) this.again = true;
    } catch (e) {
      await this.failed(kind, e, MIN_GEAR_MINT_SOL, path);
    } finally {
      this.active = null;
      this.save();
      this.deps.changed();
    }
  }

  private async update(kind: GearKind, session: string) {
    const r = this.rec[kind];
    let path = '';
    this.active = kind;
    this.deps.changed();
    try {
      const c = await this.deps.loadChain();
      const levels = this.deps.snapshot();
      if (!levels || this.stopped || !r.asset) return;
      path = gearMetaPath(kind, levels);
      const res = await c.updateGear({ asset: r.asset, path, attributes: gearAttributes(kind, levels) });
      if (res.status === 'missing' || res.status === 'not-ours') {
        // Burned, or not this session key's to update (another browser minted it): mint a fresh one next.
        console.info(`gear NFT ${r.asset} is ${res.status}; minting a fresh ${kind}`);
        this.record({ kind, action: 'noop', path, asset: r.asset, error: res.status });
        r.orphaned = [...(r.orphaned ?? []), r.asset].slice(-8);
        delete r.asset;
        delete r.authority;
        delete r.synced;
        delete r.tx;
        this.again = true;
        return;
      }
      r.synced = path;
      r.authority = session;
      if (res.signature) r.tx = res.signature;
      this.succeeded(kind);
      this.record({ kind, action: res.status === 'updated' ? 'update' : 'noop', path, asset: r.asset, signature: res.signature ?? null });
    } catch (e) {
      await this.failed(kind, e, MIN_GEAR_UPDATE_SOL, path);
    } finally {
      this.active = null;
      this.save();
      this.deps.changed();
    }
  }

  private succeeded(kind: GearKind) {
    const r = this.rec[kind];
    delete r.fails;
    delete r.retryAt;
  }

  private async failed(kind: GearKind, e: unknown, min: number, path: string) {
    const msg = errorText(e);
    console.warn(`gear NFT ${kind} sync failed`, e);
    this.record({ kind, action: 'fail', path, error: msg.slice(0, 200) });
    // Short of SOL is not a failure of the NFT: wait for a top-up without counting it.
    if (this.deps.isFundsError(msg) && (await this.balanceBelow(min))) {
      this.setFunds('needs-sol');
      this.schedulePoll();
      return;
    }
    const r = this.rec[kind];
    r.fails = (r.fails ?? 0) + 1;
    if (r.fails < MAX_GEAR_FAILS) {
      r.retryAt = this.deps.timers.now() + gearRetryDelay(r.fails);
      this.scheduleWake(r.retryAt);
    } else delete r.retryAt; // paused: the next level change (or reload) tries again
  }

  private record(e: GearSyncEvent) {
    this.log.push(e);
    if (this.log.length > 50) this.log.shift();
  }

  // ---- Funds (the game wallet pays every transaction) --------------------------------

  private setFunds(funds: GearFunds) {
    if (funds === 'ok') this.airdropTried = false; // a later shortfall earns another airdrop try
    if (funds === this.funds) return;
    this.funds = funds;
    this.deps.changed();
  }

  private async ensureFunds(min: number): Promise<boolean> {
    try {
      const c = await this.deps.loadChain();
      this.balance = await c.balanceSol();
      if (this.stopped) return false;
      if (this.balance < min && !this.airdropTried) {
        this.airdropTried = true;
        try {
          await c.airdrop(1);
          this.balance = await c.balanceSol();
        } catch (e) {
          console.warn('devnet airdrop failed', e);
        }
      }
      if (this.balance >= min) {
        this.setFunds('ok');
        return true;
      }
      this.setFunds('needs-sol');
    } catch (e) {
      console.warn('Solana unavailable for the gear NFTs', e);
      this.setFunds('offline');
    }
    this.schedulePoll();
    return false;
  }

  private async balanceBelow(min: number): Promise<boolean> {
    try {
      this.balance = await (await this.deps.loadChain()).balanceSol();
      return this.balance < min;
    } catch {
      return false;
    }
  }

  // ---- Timers and storage -----------------------------------------------------------

  private clearTimer(name: 'startTimer' | 'debounceTimer' | 'pollTimer' | 'wakeTimer') {
    if (this[name]) this.deps.timers.clearTimeout(this[name]);
    this[name] = 0;
  }

  private schedulePoll() {
    if (this.stopped || this.pollTimer) return;
    this.pollTimer = this.deps.timers.setTimeout(() => {
      this.pollTimer = 0;
      if (this.deps.hidden?.()) this.schedulePoll();
      else this.kick();
    }, POLL_MS);
  }

  private scheduleWake(at: number) {
    if (this.stopped) return;
    this.clearTimer('wakeTimer');
    this.wakeTimer = this.deps.timers.setTimeout(() => {
      this.wakeTimer = 0;
      this.kick();
    }, Math.max(1000, at - this.deps.timers.now()));
  }

  private load() {
    this.recKey = this.deps.key();
    let raw: string | null = null;
    try {
      raw = this.recKey ? this.deps.store.getItem(this.recKey) : null;
    } catch {}
    this.rec = parseGearRecord(raw);
  }

  private save() {
    // Only ever under the owner it was loaded for: an account switch reloads the page anyway.
    if (!this.recKey || this.deps.key() !== this.recKey) return;
    try {
      this.deps.store.setItem(this.recKey, JSON.stringify(this.rec));
    } catch {}
  }
}
