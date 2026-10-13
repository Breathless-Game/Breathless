import './polyfills';
import { createSignerFromKeypair, publicKey, transactionBuilder, type Signer, type TransactionBuilder, type TransactionSignature, type Umi } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { findWallet, waitForWallet, type OwnerWallet } from './owner-wallets';
import { markBalanceStale, readBalances } from './balance-api';
import { assertLanded } from './payment-safety';
import { expiryOf } from './blockhash-expiry';
import {
  SESSION_NAME,
  addressOfSecret,
  markLoggedIn,
  markLoggedOut,
  migrateLegacy,
  namespacedKey,
  parseSecretKey,
  restoreTarget,
} from './wallet-storage';

// The player's wallet (Phantom, MetaMask, Solflare, Backpack, …) is the
// account. Its address owns fish NFTs and PEARL; a per-owner session keypair in
// localStorage pays fees and signs mints without a prompt. The wallet only
// prompts for what the owner does: sell, spend, and topping up the session
// wallet. owner-wallets.ts hides which wallet it is.
//
// This module is loaded with the game, so everything heavy (web3.js, the RPC
// client, ed25519) is imported lazily on first use.

const RPC = (import.meta.env.VITE_SOLANA_RPC as string | undefined) ?? 'https://api.devnet.solana.com'; // as in chain.ts
const SYSTEM_PROGRAM = publicKey('11111111111111111111111111111111');
/** How long a page load waits for the last-used wallet's extension to register before giving up on a silent reconnect. */
const RESTORE_WAIT_MS = 1200;

export interface WalletState {
  owner: string | null;
  session: string | null;
  connected: boolean;
  /** The wallet app logged in with. `icon` is its own logo (data: URI), or '' when it has none. */
  wallet: { name: string; icon: string } | null;
}

let owner: string | null = null;
let secret: Uint8Array | null = null;
let current: OwnerWallet | null = null;
let unwatch: (() => void) | null = null;
const listeners = new Set<(s: WalletState) => void>();
// Connect, restore, account switches and disconnects run one at a time.
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export function walletState(): WalletState {
  return {
    owner,
    session: secret && addressOfSecret(secret),
    connected: owner !== null && secret !== null,
    wallet: owner && current ? { name: current.name, icon: current.icon } : null,
  };
}

export function onWalletChange(cb: (s: WalletState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit() {
  const s = walletState();
  for (const cb of [...listeners]) {
    try {
      cb(s);
    } catch (e) {
      console.error(e);
    }
  }
}

/** Per-wallet localStorage key, e.g. `deepbreath.<owner>.bank`. Throws until a wallet is connected. */
export function storageKey(name: string): string {
  if (!owner) throw new Error('Connect a wallet first');
  return namespacedKey(owner, name);
}

/** This owner's session keypair on this device, created on first login. */
async function loadSession(forOwner: string): Promise<Uint8Array> {
  const key = namespacedKey(forOwner, SESSION_NAME);
  const raw = localStorage.getItem(key);
  const stored = parseSecretKey(raw);
  if (stored) return stored;
  if (raw != null) localStorage.setItem(`${key}.unreadable`, raw); // keep whatever was there
  const { ed25519 } = await import('@noble/curves/ed25519');
  const seed = ed25519.utils.randomSecretKey();
  const fresh = new Uint8Array(64);
  fresh.set(seed);
  fresh.set(ed25519.getPublicKey(seed), 32);
  const json = JSON.stringify(Array.from(fresh));
  localStorage.setItem(key, json);
  // SOL sent to a key that isn't saved would be lost on reload: refuse to log in instead.
  if (localStorage.getItem(key) !== json) throw new Error('Browser storage is unavailable');
  return fresh;
}

async function adopt(w: OwnerWallet, next: string): Promise<WalletState> {
  if (next === owner && w === current && secret) return walletState();
  try {
    migrateLegacy(localStorage, next);
  } catch (e) {
    console.warn('Could not move pre-login progress into this wallet; will retry next login', e);
  }
  const s = await loadSession(next);
  stopWatching();
  owner = next;
  secret = s;
  current = w;
  unwatch = w.watch((addresses) => void serial(async () => accountsChanged(w, addresses)));
  emit();
  return walletState();
}

function stopWatching() {
  try {
    unwatch?.();
  } catch {}
  unwatch = null;
}

function drop() {
  stopWatching();
  if (!owner && !secret) return;
  owner = null;
  secret = null; // the key itself stays in storage: it may hold SOL
  current = null;
  emit();
}

/**
 * The wallet's accounts changed. Still holding the owner: nothing to do.
 * Disconnected this site (no accounts): a logout, so page loads don't
 * reconnect. Switched to another account: nothing is adopted in place. The
 * old owner is dropped first (so a save still in flight can't land in the new
 * owner's storage), main.ts reloads, and that page load silently reconnects
 * whichever account the wallet now has for this site, or shows the gate.
 */
async function accountsChanged(w: OwnerWallet, addresses: string[]) {
  if (!owner || w !== current || addresses.includes(owner)) return;
  if (!addresses.length) {
    try {
      markLoggedOut(localStorage);
    } catch {}
  }
  drop();
}

/** Connect the wallet called `name` (it shows its own prompt the first time). */
export function connectWallet(name: string): Promise<WalletState> {
  return serial(async () => {
    const w = findWallet(name);
    if (!w) throw new Error(`${name} is not installed`);
    const address = await w.connect(false);
    if (!address) throw new Error(`${name} didn't share a Solana account`);
    try {
      markLoggedIn(localStorage, w.name);
    } catch {}
    return adopt(w, address);
  });
}

/** Silent reconnect on page load: only the wallet last used, only if it already trusts this site and the player didn't log out. */
export function restoreWallet(): Promise<WalletState> {
  return serial(async () => {
    if (owner) return walletState();
    try {
      const target = restoreTarget(localStorage);
      if (!target) return walletState();
      const w = await waitForWallet(target, RESTORE_WAIT_MS);
      const address = w && (await w.connect(true));
      return w && address ? await adopt(w, address) : walletState();
    } catch {
      return walletState();
    }
  });
}

/**
 * Log out: forget the owner in memory and stop listening to the wallet. Their
 * progress and session key stay in storage for the next login, and page loads
 * stop reconnecting until the player connects again.
 */
export function disconnectWallet(): Promise<void> {
  return serial(async () => {
    try {
      markLoggedOut(localStorage);
    } catch {}
    const w = current;
    stopWatching(); // first, so our own disconnect isn't handled as an event
    try {
      await w?.disconnect();
    } catch {}
    drop();
  });
}

// ---- Signers (the seam chain.ts and the sell / PEARL code build on) -------

function requireOwner(): string {
  if (!owner) throw new Error('Connect a wallet first');
  return owner;
}

/** The player's wallet address: owns fish NFTs and PEARL. */
export function ownerAddress(_umi: Umi): string {
  return requireOwner();
}

/** Owner actions (sell, spend PEARL, burn, top up): every signature is a prompt in the player's wallet. */
export function ownerSigner(umi: Umi): Signer {
  const key = requireOwner();
  if (!current) throw new Error('Connect a wallet first');
  // The session key too: the desktop Browser wallet signs with it again if it swaps the blockhash.
  return current.signer(umi, key, secret ? [sessionSigner(umi)] : []);
}

/**
 * Sign, send and confirm a transaction the owner signs, throwing if it failed on chain. Like
 * umi's sendAndConfirm, except that it confirms against the blockhash the transaction was
 * actually signed with (blockhash-expiry.ts): the desktop Browser wallet may have swapped it.
 */
export async function sendOwnerTx(u: Umi, builder: TransactionBuilder, label: string): Promise<TransactionSignature> {
  const fetched = await u.rpc.getLatestBlockhash();
  const tx = await builder.setBlockhash(fetched).buildAndSign(u);
  const signature = await u.rpc.sendTransaction(tx);
  const result = await u.rpc.confirmTransaction(signature, { strategy: { type: 'blockhash', ...expiryOf(tx, fetched) } });
  assertLanded(result, label);
  return signature;
}

/** Silent signer for mints and fees: this owner's session keypair. */
export function sessionSigner(umi: Umi): Signer {
  if (!secret) throw new Error('Connect a wallet first');
  return createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(secret));
}

// ---- Session wallet funding --------------------------------------------

let rpcUmi: Promise<Umi> | null = null;

function solanaUmi(): Promise<Umi> {
  rpcUmi ??= import('@metaplex-foundation/umi-bundle-defaults')
    .then(({ createUmi }) => createUmi(RPC, 'confirmed'))
    .catch((e) => {
      rpcUmi = null;
      throw e;
    });
  return rpcUmi;
}

function requireSession(): string {
  if (!secret) throw new Error('Connect a wallet first');
  return addressOfSecret(secret);
}

/** Session wallet balance in SOL. */
export async function sessionBalance(): Promise<number> {
  const session = requireSession();
  // The market reads it for us without the Solana client; an older or offline market: ask the RPC.
  if (owner) {
    try {
      const b = await readBalances(owner, session);
      if (b?.sessionSol != null) return b.sessionSol;
    } catch {}
  }
  const u = await solanaUmi();
  const bal = await u.rpc.getBalance(publicKey(session));
  return Number(bal.basisPoints) / 1e9;
}

/** The player's wallet sends `sol` from the owner to the session wallet (one prompt). Returns the signature. */
export async function topUpSession(sol: number): Promise<string> {
  const session = requireSession();
  if (!Number.isFinite(sol) || sol <= 0) throw new Error('Top-up must be a positive amount of SOL');
  const u = await solanaUmi();
  const payer = ownerSigner(u);
  // System program Transfer: u32 instruction index 2, then u64 lamports, little-endian.
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, BigInt(Math.round(sol * 1e9)), true);
  const topUp = transactionBuilder()
    .add({
      instruction: {
        programId: SYSTEM_PROGRAM,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: publicKey(session), isSigner: false, isWritable: true },
        ],
        data,
      },
      signers: [payer],
      bytesCreatedOnChain: 0,
    })
    .setFeePayer(payer);
  const signature = await sendOwnerTx(u, topUp, 'Session top-up').finally(markBalanceStale); // the market's cached session SOL is now old
  return base58.deserialize(signature)[0];
}
