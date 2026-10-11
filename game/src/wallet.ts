import './polyfills';
import { createSignerFromKeypair, publicKey, transactionBuilder, type Signer, type Umi } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import {
  AUTOCONNECT_KEY,
  SESSION_NAME,
  addressOfSecret,
  migrateLegacy,
  namespacedKey,
  parseSecretKey,
} from './wallet-storage';

// Phantom is the account. The connected Phantom address owns fish NFTs and
// PEARL; a per-owner session keypair in localStorage pays fees and signs mints
// without a prompt. Phantom only prompts for what the owner does: sell, spend,
// and topping up the session wallet.
//
// This module is loaded with the game, so everything heavy (web3.js, the RPC
// client, ed25519) is imported lazily on first use.

const RPC = (import.meta.env.VITE_SOLANA_RPC as string | undefined) ?? 'https://api.devnet.solana.com'; // as in chain.ts
const SYSTEM_PROGRAM = publicKey('11111111111111111111111111111111');

interface PhantomKey {
  toString(): string;
  toBase58?(): string;
}

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: PhantomKey | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PhantomKey }>;
  disconnect(): Promise<void>;
  signTransaction<T>(tx: T): Promise<T>;
  signAllTransactions<T>(txs: T[]): Promise<T[]>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  on(event: 'accountChanged' | 'disconnect', cb: (arg?: PhantomKey | null) => void): void;
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
  }
}

export interface WalletState {
  owner: string | null;
  session: string | null;
  connected: boolean;
}

let owner: string | null = null;
let secret: Uint8Array | null = null;
const listeners = new Set<(s: WalletState) => void>();
let hooked: PhantomProvider | null = null;
// Connect, restore, account switches and disconnects run one at a time.
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/** Phantom's injected provider. Looked up on every call: extensions can inject late. */
function phantom(): PhantomProvider | null {
  const p = window.phantom?.solana;
  return p?.isPhantom ? p : null;
}

export const phantomInstalled = () => phantom() !== null;

const keyString = (k: PhantomKey) => k.toBase58?.() ?? k.toString();

export function walletState(): WalletState {
  return { owner, session: secret && addressOfSecret(secret), connected: owner !== null && secret !== null };
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

/** Per-wallet localStorage key, e.g. `deepbreath.<owner>.bank`. Throws until Phantom is connected. */
export function storageKey(name: string): string {
  if (!owner) throw new Error('Connect Phantom first');
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

async function adopt(next: string): Promise<WalletState> {
  if (next === owner && secret) return walletState();
  try {
    migrateLegacy(localStorage, next);
  } catch (e) {
    console.warn('Could not move pre-login progress into this wallet; will retry next login', e);
  }
  const s = await loadSession(next);
  owner = next;
  secret = s;
  emit();
  return walletState();
}

function drop() {
  if (!owner && !secret) return;
  owner = null;
  secret = null; // the key itself stays in storage: it may hold SOL
  emit();
}

function hook(p: PhantomProvider) {
  if (hooked === p) return;
  hooked = p;
  p.on('accountChanged', (pk) => void serial(() => accountChanged(p, pk ?? null)));
  p.on('disconnect', () => void serial(async () => drop()));
}

async function accountChanged(p: PhantomProvider, pk: PhantomKey | null) {
  if (!owner) return; // not logged in: the next connect picks up whatever account is active
  if (pk) {
    await adopt(keyString(pk));
    return;
  }
  // Phantom switched to an account that hasn't approved this site yet.
  try {
    const res = await p.connect({ onlyIfTrusted: true });
    await adopt(keyString(res.publicKey));
  } catch {
    drop();
  }
}

/** Ask Phantom to connect (shows its prompt the first time). */
export function connectWallet(): Promise<WalletState> {
  return serial(async () => {
    const p = phantom();
    if (!p) throw new Error('Phantom is not installed');
    hook(p);
    const { publicKey: pk } = await p.connect();
    try {
      localStorage.removeItem(AUTOCONNECT_KEY);
    } catch {}
    return adopt(keyString(pk));
  });
}

/** Silent reconnect on page load, if this site is already trusted and the player didn't disconnect. */
export function restoreWallet(): Promise<WalletState> {
  return serial(async () => {
    const p = phantom();
    if (!p || owner) return walletState();
    hook(p);
    try {
      if (localStorage.getItem(AUTOCONNECT_KEY) === '0') return walletState();
      const { publicKey: pk } = await p.connect({ onlyIfTrusted: true });
      return await adopt(keyString(pk));
    } catch {
      return walletState();
    }
  });
}

export function disconnectWallet(): Promise<void> {
  return serial(async () => {
    try {
      localStorage.setItem(AUTOCONNECT_KEY, '0');
    } catch {}
    try {
      await phantom()?.disconnect();
    } catch {}
    drop();
  });
}

// ---- Signers (the seam chain.ts and the sell / PEARL code build on) -------

function requireOwner(): string {
  if (!owner) throw new Error('Connect Phantom first');
  return owner;
}

/** The Phantom address: owns fish NFTs and PEARL. */
export function ownerAddress(_umi: Umi): string {
  return requireOwner();
}

/** Owner actions (sell, spend PEARL, top up): every signature is a Phantom prompt. */
export function ownerSigner(_umi: Umi): Signer {
  const key = requireOwner();
  const p = phantom();
  if (!p) throw new Error('Phantom is not available');
  const provider = p;
  const adapters = () => import('@metaplex-foundation/umi-web3js-adapters');
  const sameAccount = () => {
    if (provider.publicKey && keyString(provider.publicKey) !== key) {
      throw new Error('Phantom switched accounts. Reload the game to continue.');
    }
  };
  return {
    publicKey: publicKey(key),
    async signMessage(message) {
      sameAccount();
      return (await provider.signMessage(message)).signature;
    },
    async signTransaction(tx) {
      sameAccount();
      const { toWeb3JsTransaction, fromWeb3JsTransaction } = await adapters();
      return fromWeb3JsTransaction(await provider.signTransaction(toWeb3JsTransaction(tx)));
    },
    async signAllTransactions(txs) {
      sameAccount();
      const { toWeb3JsTransaction, fromWeb3JsTransaction } = await adapters();
      return (await provider.signAllTransactions(txs.map(toWeb3JsTransaction))).map(fromWeb3JsTransaction);
    },
  };
}

/** Silent signer for mints and fees: this owner's session keypair. */
export function sessionSigner(umi: Umi): Signer {
  if (!secret) throw new Error('Connect Phantom first');
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
  if (!secret) throw new Error('Connect Phantom first');
  return addressOfSecret(secret);
}

/** Session wallet balance in SOL. */
export async function sessionBalance(): Promise<number> {
  const session = requireSession();
  const u = await solanaUmi();
  const bal = await u.rpc.getBalance(publicKey(session));
  return Number(bal.basisPoints) / 1e9;
}

/** Phantom sends `sol` from the owner to the session wallet (one prompt). Returns the signature. */
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
  const { signature } = await transactionBuilder()
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
    .setFeePayer(payer)
    .sendAndConfirm(u);
  return base58.deserialize(signature)[0];
}
