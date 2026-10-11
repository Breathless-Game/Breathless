/**
 * The game's side of the on-chain `player_state` program: reads the Config, PlayerState and
 * Aquarium accounts, sends the owner's purchases (one wallet prompt each, PEARL burned by the
 * program in the same instruction) and the session key's silent events (shark_bite, set_path).
 *
 * The chain is the source of truth for gear levels, module paths, synthesis materials and
 * aquarium growth: after anything lands, the accounts are read again and the game renders from
 * them (main.ts). Nothing here bumps a level locally.
 *
 * Payment safety (payment-safety.ts) is kept: one owner payment at a time (paymentLock), every
 * confirmation is checked for an on-chain error, and a payment whose confirmation was lost stays
 * in the per-wallet journal (purchases locked) until its signature settles it, or its blockhash
 * expired and the re-read accounts break the tie. Nothing is ever re-sent.
 *
 * The chain libraries load lazily (chain.ts), like the rest of the wallet code.
 */
import { publicKey, transactionBuilder, type PublicKey, type Signer, type TransactionBuilder, type Umi } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { ownerSigner, sessionSigner, storageKey, walletState } from './wallet';
import { markBalanceStale } from './balance-api';
import {
  addPending,
  createPurchaseStore,
  neverBroadcast,
  PaymentInProgressError,
  paymentLock,
  PaymentPendingError,
  PENDING_MAX_AGE_MS,
  PENDING_PURCHASES,
  takePending,
  TxFailedError,
  waitForSignature,
  type ReconcileReport,
  type SigVerdict,
  type StatusDeps,
  verdictOf,
} from './payment-safety';
import {
  decodeAquarium,
  decodeConfig,
  decodePlayerState,
  findAquariumPda,
  findConfigPda,
  findPlayerStatePda,
  initPlayer,
  playerStateProgramId,
  setSession,
  sharkBite,
  SLOT_ORDER,
  type AquariumAccount,
  type PearlAccounts,
  type PlayerStateAccount,
  type PlayerStateConfig,
} from './player-state';
import { biteSettled, chainLevels, isChainPurchase, purchaseVisible, settleRecord, type ChainPurchase } from './player-sync';
import { sessionFailureFinal } from './player-state-errors';
import type { UpgradeSlot } from './equipment';

export interface PlayerChainSnapshot {
  owner: string;
  config: PlayerStateConfig;
  /** Null until the player's first purchase creates it (init_player is batched into that transaction). */
  player: PlayerStateAccount | null;
  aquarium: AquariumAccount | null;
  /** When it was read (ms). */
  at: number;
}

export type PlayerChainStatus = 'idle' | 'loading' | 'ready' | 'error';

let snapshot: PlayerChainSnapshot | null = null;
let status: PlayerChainStatus = 'idle';
let lastError: string | null = null;
let reading: Promise<PlayerChainSnapshot> | null = null;
const listeners = new Set<() => void>();

/** The last successful read for the connected owner, or null. */
export function playerChain(): PlayerChainSnapshot | null {
  const owner = walletState().owner;
  return snapshot && snapshot.owner === owner ? snapshot : null;
}

export function playerChainStatus(): { status: PlayerChainStatus; error: string | null } {
  return { status: playerChain() ? 'ready' : status === 'ready' ? 'idle' : status, error: lastError };
}

/** Called after every read and every status change. */
export function onPlayerChainChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit() {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (e) {
      console.error(e);
    }
  }
}

async function umi(): Promise<Umi> {
  return (await import('./chain')).getUmi();
}

/** Forget the cached accounts (logout / owner switch). */
export function resetPlayerChain(): void {
  snapshot = null;
  status = 'idle';
  lastError = null;
  emit();
}

/**
 * Read the Config, PlayerState and Aquarium in one RPC call. Concurrent calls share one read.
 * Throws (and sets status 'error') when the Config is missing or the RPC fails.
 */
export function refreshPlayerChain(): Promise<PlayerChainSnapshot> {
  reading ??= read().finally(() => {
    reading = null;
  });
  return reading;
}

async function read(): Promise<PlayerChainSnapshot> {
  const owner = walletState().owner;
  if (!owner) throw new Error('Connect a wallet first');
  if (!playerChain()) {
    status = 'loading';
    emit();
  }
  try {
    const u = await umi();
    const programId = playerStateProgramId();
    const ownerKey = publicKey(owner);
    const [configAcc, playerAcc, aquariumAcc] = await u.rpc.getAccounts([
      findConfigPda(u, programId)[0],
      findPlayerStatePda(u, ownerKey, programId)[0],
      findAquariumPda(u, ownerKey, programId)[0],
    ]);
    const ours = (a: (typeof configAcc)) => a.exists && a.owner.toString() === programId.toString();
    if (!configAcc.exists) throw new Error('player_state Config not found on chain');
    if (!ours(configAcc)) throw new Error('player_state Config has the wrong owner');
    const next: PlayerChainSnapshot = {
      owner,
      config: decodeConfig(configAcc.data),
      player: ours(playerAcc) ? decodePlayerState((playerAcc as { data: Uint8Array }).data) : null,
      aquarium: ours(aquariumAcc) ? decodeAquarium((aquariumAcc as { data: Uint8Array }).data) : null,
      at: Date.now(),
    };
    if (next.player && next.player.owner.toString() !== owner) throw new Error('PlayerState belongs to another owner');
    if (walletState().owner !== owner) throw new Error('Wallet changed while reading');
    snapshot = next;
    status = 'ready';
    lastError = null;
    emit();
    return next;
  } catch (e) {
    if (walletState().owner === owner) {
      lastError = e instanceof Error ? e.message : String(e);
      if (!playerChain()) status = 'error';
      emit();
    }
    throw e;
  }
}

// ---- Shark bite still owed to the chain (per wallet, this device) ----------------------

const BITE_KEY = 'player-state.bite.pending';

/**
 * null: nothing owed. 'owed': a bite happened in a dive and no shark_bite is in flight.
 * { sig, lastValid }: a session-signed shark_bite was sent and its outcome is not known yet.
 * While one is in flight no other shark_bite is sent and no purchase goes out: landing late,
 * after a purchase, it would take that purchase's level back.
 */
type BiteFlag = null | 'owed' | { sig: string; lastValid: number };

function biteFlag(): BiteFlag {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(BITE_KEY));
  } catch {
    return null;
  }
  if (raw == null) return null;
  if (raw === '1') return 'owed';
  try {
    const v = JSON.parse(raw) as { sig?: unknown; lastValid?: unknown };
    return typeof v?.sig === 'string' && typeof v.lastValid === 'number' ? { sig: v.sig, lastValid: v.lastValid } : 'owed';
  } catch {
    return 'owed';
  }
}

function setBiteFlag(flag: BiteFlag) {
  try {
    if (flag === null) localStorage.removeItem(storageKey(BITE_KEY));
    else localStorage.setItem(storageKey(BITE_KEY), flag === 'owed' ? '1' : JSON.stringify(flag));
  } catch (e) {
    console.warn('could not save the shark-bite flag', e);
  }
}

const journalHasBite = () => purchases.load().some((r) => isChainPurchase(r.what) && r.what.bite === true);

/**
 * A shark bite happened in a dive and the chain may not show it yet (owed, in flight, or riding
 * in a purchase whose confirmation was lost): the game shows the dive gear reset meanwhile.
 */
export function biteUnsettled(): boolean {
  return biteFlag() !== null || journalHasBite();
}

/** Drop an owed bite once the chain shows nothing left to reset. True when it cleared. */
export function settleBiteFromState(snap: PlayerChainSnapshot | null = playerChain()): boolean {
  if (biteFlag() !== 'owed' || !snap || !biteSettled(snap.player)) return false;
  setBiteFlag(null);
  return true;
}

/** Look an in-flight session bite up: landed -> cleared, failed or expired -> owed again, unknown -> kept. */
async function resolveBiteInFlight(u: Umi): Promise<BiteFlag> {
  const flag = biteFlag();
  if (!flag || flag === 'owed') return flag;
  const deps = statusDeps(u);
  const [st] = await deps.statuses([flag.sig]);
  const height = st ? undefined : await deps.blockHeight().catch(() => undefined);
  const verdict = verdictOf(st, height, flag.lastValid);
  if (verdict === 'ok') setBiteFlag(null);
  else if (verdict === 'failed') setBiteFlag('owed');
  return biteFlag();
}

function sessionRegistered(snap: PlayerChainSnapshot | null): boolean {
  const session = walletState().session;
  return !!snap?.player && !!session && snap.player.session?.toString() === session;
}

/**
 * The shark reached the diver: reset the dive gear on chain with the session key (no wallet
 * prompt; the session key pays the fee). Never throws and never blocks the dive: the bite is
 * remembered first, and if the session key is not registered, has no SOL or the send fails, it
 * is retried at the next login, or batched (signed by the owner) into the next purchase.
 */
export async function recordSharkBite(): Promise<'sent' | 'deferred' | 'nothing'> {
  if (!walletState().owner) return 'nothing';
  // One already in flight covers this one: no purchase can raise a level until it settles.
  if (biteFlag() === null) setBiteFlag('owed');
  return sendBiteWithSession();
}

async function sendBiteWithSession(): Promise<'sent' | 'deferred' | 'nothing'> {
  try {
    return await paymentLock.run(async () => {
      // A journaled purchase may carry this very bite, or have raised a level after it: a bite
      // sent now could land after it and take that level back. Settle the journal first.
      if (purchases.load().length) return 'deferred';
      const u = await umi();
      const flag = await resolveBiteInFlight(u);
      if (flag && flag !== 'owed') return 'deferred'; // the last one is still confirming
      if (!flag) return 'nothing';
      const snap = await refreshPlayerChain();
      if (settleBiteFromState(snap)) return 'nothing';
      if (!sessionRegistered(snap)) {
        console.info('shark_bite deferred: the session key is not registered for this player yet (it goes with the next purchase)');
        return 'deferred';
      }
      const session = sessionSigner(u);
      try {
        await sendTracked(u, session, sharkBite(u, { authority: session, owner: publicKey(snap.owner) }), null, 0, 'Shark bite', (sig, lastValid) =>
          setBiteFlag({ sig, lastValid }),
        );
      } catch (e) {
        if (!(e instanceof PaymentPendingError)) setBiteFlag('owed'); // never landed: still owed
        throw e;
      }
      setBiteFlag(null);
      void refreshPlayerChain().catch(() => {});
      return 'sent';
    });
  } catch (e) {
    console.warn('shark_bite not settled on chain yet; retried at the next login or with the next purchase', e);
    return 'deferred';
  }
}

/** Login: settle a bite owed from an earlier dive (session-signed, no prompt). */
export async function settleOwedBite(): Promise<void> {
  if (biteFlag() === null) return;
  await sendBiteWithSession();
}

// ---- Owner transactions ------------------------------------------------------------------

const TX_BYTE_BUDGET = 1232 - 150; // leave room for what a wallet may add before signing (as pearl.ts)

const purchases = createPurchaseStore(() => storageKey(PENDING_PURCHASES));
export const pendingPlayerPurchases = () => purchases.load();

function statusDeps(u: Umi): StatusDeps {
  return {
    statuses: async (sigs) =>
      (await u.rpc.getSignatureStatuses(sigs.map((s) => base58.serialize(s)), { searchTransactionHistory: true })).map((st) =>
        st ? { error: st.error, commitment: st.commitment } : null,
      ),
    blockHeight: () => u.rpc.call<number>('getBlockHeight', [{ commitment: 'confirmed' }]),
  };
}

/**
 * What goes in front of the owner's next instruction so it needs no extra prompt: init_player
 * (with this device's session key) for a new player, set_session when this device's key is not
 * the registered one, and a shark bite the session key could not settle.
 */
function prelude(u: Umi, owner: Signer, snap: PlayerChainSnapshot): { builder: TransactionBuilder; bite: boolean } {
  const session = walletState().session;
  const sessionKey = session ? publicKey(session) : null;
  let builder = transactionBuilder();
  if (!snap.player) return { builder: builder.add(initPlayer(u, { owner, session: sessionKey })), bite: false };
  if (sessionKey && snap.player.session?.toString() !== session) builder = builder.add(setSession(u, { owner, session: sessionKey }));
  const bite = biteFlag() === 'owed' && !biteSettled(snap.player);
  if (bite) builder = builder.add(sharkBite(u, { authority: owner, owner: owner.publicKey }));
  return { builder, bite };
}

/**
 * Sign (one wallet prompt), journal, send and confirm one transaction paid by `payer`. Resolves
 * with the signature once it landed without error. Throws TxFailedError when it failed on chain,
 * PaymentPendingError when its outcome is still unknown (a purchase stays journaled), or the
 * send's error when it was refused before broadcast. Call inside paymentLock.
 */
async function sendTracked(
  u: Umi,
  payer: Signer,
  builder: TransactionBuilder,
  what: ChainPurchase | null,
  cost: number,
  label: string,
  onSigned?: (signature: string, lastValid: number) => void,
): Promise<string> {
  const blockhash = await u.rpc.getLatestBlockhash({ commitment: 'confirmed' });
  const tx = await builder.setFeePayer(payer).setBlockhash(blockhash).buildAndSign(u);
  const signature = base58.deserialize(tx.signatures[0])[0];
  const record = what !== null;
  if (record) addPending(purchases, { signature, what, cost, ts: Date.now(), lastValid: blockhash.lastValidBlockHeight });
  onSigned?.(signature, blockhash.lastValidBlockHeight);
  const forget = () => record && takePending(purchases, signature);
  let verdict: SigVerdict;
  let chainErr: unknown = `transaction ${signature} did not land`;
  try {
    try {
      await u.rpc.sendTransaction(tx, { preflightCommitment: 'confirmed' });
    } catch (e) {
      if (neverBroadcast(e)) {
        forget(); // refused in preflight: never broadcast, nothing burned
        throw e;
      }
      console.warn(`${label} ${signature}: send failed, looking it up`, e);
    }
    try {
      const res = await u.rpc.confirmTransaction(tx.signatures[0], { commitment: 'confirmed', strategy: { type: 'blockhash', ...blockhash } });
      verdict = res.value.err ? 'failed' : 'ok';
      if (res.value.err) chainErr = res.value.err;
    } catch (e) {
      console.warn(`${label} ${signature}: confirmation lost, looking it up`, e);
      verdict = await waitForSignature(signature, blockhash.lastValidBlockHeight, statusDeps(u));
    }
  } finally {
    if (cost > 0) markBalanceStale(); // a burn the market never saw: the next balance read skips its cache
  }
  if (verdict === 'unknown') throw new PaymentPendingError(signature);
  forget();
  if (verdict === 'failed') {
    console.error(`${label} ${signature} failed on chain: nothing was burned or changed`, chainErr);
    throw new TxFailedError(label, chainErr);
  }
  return signature;
}

/** A payment confirmed while this purchase waited for it: the screen may be out of date, so ask again. */
export class PreviousPaymentSettledError extends Error {
  constructor() {
    super('A previous payment just settled');
    this.name = 'PreviousPaymentSettledError';
  }
}

export interface OwnerTxContext {
  u: Umi;
  owner: Signer;
  pearl: PearlAccounts;
  snap: PlayerChainSnapshot;
  /** Levels the instruction will see: Lv1 everywhere when an owed shark bite rides in front of it. */
  levels: Record<UpgradeSlot, number>;
}

/** The instruction to send, what it buys (with the state before it, to recognise it later) and its PEARL cost. */
export interface PurchasePlan {
  builder: TransactionBuilder;
  what: ChainPurchase;
  cost: number;
}

/**
 * One owner-signed player_state purchase (buy_upgrade, craft, synth_upgrade, feed, set_path):
 * one payment at a time, one wallet prompt (a new player's init_player, this device's session
 * key and an owed shark bite ride along in the same transaction), journaled until confirmed.
 * `plan` builds the instruction from freshly read accounts; a throw from it sends nothing.
 * Resolves with the signature after the accounts were read again.
 */
export function sendPlayerPurchase(plan: (ctx: OwnerTxContext) => PurchasePlan, label: string): Promise<string> {
  return paymentLock.run(async () => {
    const u = await umi();
    // A payment still confirming from before: settle it first, and never stack a second payment
    // on a state it may still change (it could be this very upgrade).
    if (purchases.load().length) {
      const report = await settlePending(u);
      if (report.kept.length) throw new PaymentInProgressError();
      throw new PreviousPaymentSettledError();
    }
    const inFlight = await resolveBiteInFlight(u);
    if (inFlight && inFlight !== 'owed') throw new PaymentInProgressError(); // a shark bite still confirming
    const snap = await refreshPlayerChain();
    settleBiteFromState(snap);
    const owner = ownerSigner(u);
    const pre = prelude(u, owner, snap);
    const levels = pre.bite ? (Object.fromEntries(SLOT_ORDER.map((s) => [s, 1])) as Record<UpgradeSlot, number>) : chainLevels(snap.player);
    const { builder: main, what, cost } = plan({ u, owner, pearl: { pearlMint: snap.config.pearlMint, tokenProgram: snap.config.tokenProgram }, snap, levels });
    let builder = pre.builder.add(main);
    let record: ChainPurchase = pre.bite ? { ...what, bite: true } : what;
    const blockhash = await u.rpc.getLatestBlockhash({ commitment: 'confirmed' });
    if (pre.builder.items.length && builder.setFeePayer(owner).setBlockhash(blockhash).getTransactionSize(u) > TX_BYTE_BUDGET) {
      // Too big together (a first feed over a full tank): set the player up first, then pay. The
      // setup is journaled too, so nothing else goes out while its outcome is unknown.
      const setup: ChainPurchase = pre.bite ? { v: 1, kind: 'setup', bite: true } : { v: 1, kind: 'setup' };
      await sendCarryingBite(u, owner, pre.builder, setup, 0, 'Player setup');
      builder = main;
      record = what;
    }
    const signature = await sendCarryingBite(u, owner, builder, record, cost, label);
    await rereadUntilVisible(what);
    return signature;
  });
}

/**
 * sendTracked for a transaction that may carry an owed shark bite. From the moment it is signed
 * the bite flag names this signature (in flight, never 'owed'), so no other shark_bite can be
 * sent while it may still land: one landing after it would take its purchase back. Landed ->
 * settled; refused or failed -> owed again; unknown -> stays in flight until its signature (or
 * the journal) settles it.
 */
async function sendCarryingBite(u: Umi, owner: Signer, builder: TransactionBuilder, what: ChainPurchase, cost: number, label: string): Promise<string> {
  if (!what.bite) return sendTracked(u, owner, builder, what, cost, label);
  let signature: string;
  try {
    signature = await sendTracked(u, owner, builder, what, cost, label, (sig, lastValid) => setBiteFlag({ sig, lastValid }));
  } catch (e) {
    if (!(e instanceof PaymentPendingError)) setBiteFlag('owed');
    throw e;
  }
  setBiteFlag(null);
  return signature;
}

/**
 * Read the accounts again after a purchase landed; an RPC node a slot behind may not show it yet,
 * so try a few times. The latest read is what the game renders either way.
 */
async function rereadUntilVisible(what: ChainPurchase, tries = 4): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const snap = await refreshPlayerChain();
      settleBiteFromState(snap);
      if (purchaseVisible(what, snap.player, snap.aquarium)) return;
    } catch (e) {
      console.warn('player_state re-read failed', e);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

/**
 * Switch a module path. Free, so the session key signs it silently when it is registered (and
 * pays the fee); otherwise, or if that fails before reaching the program, the owner signs (one
 * prompt, registering this device's session key in the same transaction).
 */
export async function sendSetPath(
  build: (authority: Signer, owner: PublicKey, u: Umi) => TransactionBuilder,
  what: Extract<ChainPurchase, { kind: 'path' }>,
): Promise<void> {
  const snap = playerChain() ?? (await refreshPlayerChain());
  if (sessionRegistered(snap)) {
    try {
      await paymentLock.run(async () => {
        const u = await umi();
        const session = sessionSigner(u);
        await sendTracked(u, session, build(session, publicKey(snap.owner), u), null, 0, 'Path switch');
      });
      await rereadUntilVisible(what);
      return;
    } catch (e) {
      // The program refused it, in preflight or on chain (the owner would be refused too), another
      // payment is running, or it may still land: never ask the wallet for a second one on top.
      if (sessionFailureFinal(e)) throw e;
      console.warn('session-signed set_path did not go through; asking the wallet instead', e);
    }
  }
  await sendPlayerPurchase(({ u, owner }) => ({ builder: build(owner, owner.publicKey, u), what, cost: 0 }), 'Path switch');
}

// ---- Lost confirmations ------------------------------------------------------------------

/**
 * Settle this wallet's journaled payments (inside paymentLock), signature first (settleRecord):
 * landed -> delivered, failed -> dropped, not found -> kept until its blockhash expired, and only
 * then the re-read accounts decide delivered or dropped. Nothing is granted or re-sent: the chain
 * already has whatever landed. A bite riding in a record settles with it (landed -> settled, never
 * landed -> owed again). Records from before player_state (bare PEARL burns) are only logged.
 */
async function settlePending(u: Umi): Promise<ReconcileReport> {
  const report: ReconcileReport = { delivered: [], dropped: [], kept: [] };
  const records = purchases.load();
  if (!records.length) return report;
  const deps = statusDeps(u);
  const statuses = await deps.statuses(records.map((r) => r.signature));
  const height = await deps.blockHeight().catch(() => undefined);
  // The accounts only break the tie for a record that can no longer land (settleRecord).
  const snap = await refreshPlayerChain();
  const now = Date.now();
  for (const [i, rec] of records.entries()) {
    const verdict = settleRecord(rec, statuses[i] ?? null, height, now, snap.player, snap.aquarium, PENDING_MAX_AGE_MS);
    if (verdict === 'kept') {
      report.kept.push(rec.signature);
      continue;
    }
    // Re-read: the payment itself may have taken it meanwhile.
    if (!takePending(purchases, rec.signature)) continue;
    report[verdict].push(rec.signature);
    const what = rec.what;
    if (!isChainPurchase(what)) {
      if (verdict === 'delivered') console.warn(`A PEARL burn from before on-chain player state (${rec.signature}) landed; its local grant is not applied any more`, rec);
      continue;
    }
    if (!what.bite) continue;
    const flag = biteFlag();
    if (flag && flag !== 'owed' && flag.sig === rec.signature) setBiteFlag(verdict === 'delivered' ? null : 'owed');
    else if (verdict === 'dropped' && flag === null) setBiteFlag('owed'); // the bite it carried never landed
  }
  if (report.delivered.length || report.dropped.length) await refreshPlayerChain().catch(() => {});
  return report;
}

/** Settle this wallet's journaled payments (see settlePending). Skipped (all kept) while a payment is in flight. */
export async function reconcilePlayerPurchases(): Promise<ReconcileReport> {
  const pendingNow = purchases.load();
  if (!pendingNow.length) return { delivered: [], dropped: [], kept: [] };
  if (paymentLock.busy) return { delivered: [], dropped: [], kept: pendingNow.map((r) => r.signature) };
  return paymentLock.run(async () => settlePending(await umi()));
}
