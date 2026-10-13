import { getWallets, type Wallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { publicKey, type Signer, type Transaction, type Umi } from '@metaplex-foundation/umi';
import { DEVNET, usableWallet } from './wallet-storage';
import { isDesktop } from './desktop';
import { browserWallet } from './desktop-wallet';

// Every wallet the player can log in with, behind one interface: Wallet
// Standard wallets (Phantom, MetaMask, Solflare, Backpack and any other that
// registers), plus Phantom's legacy window.phantom.solana, only when Phantom
// didn't register through the standard. wallet.ts sees an address, account
// changes and an umi Signer; it never touches a wallet directly.
//
// In the desktop app (desktop.ts isDesktop) there are no extensions: the one wallet is the
// "Browser wallet" (desktop-wallet.ts), which relays to the player's wallet in their normal
// browser. The link page it opens there (link.ts) signs raw bytes through the same wallets here.

export interface OwnerWallet {
  readonly name: string;
  /** The wallet's own logo (a data: URI), or '' when it has none: the picker then uses its bundled one. */
  readonly icon: string;
  /** The wallet lists Solana devnet among its chains. */
  readonly devnet: boolean;
  /** Connect. `silent`: only take an account this site already holds, without a prompt. The Solana address, or null. */
  connect(silent: boolean): Promise<string | null>;
  disconnect(): Promise<void>;
  /** The wallet's accounts for this site changed: their addresses, [] once it disconnected the site. Returns the unsubscribe. */
  watch(cb: (addresses: string[]) => void): () => void;
  /**
   * Signs as `address`: every signature is a prompt in this wallet. `local`: signers this device
   * holds (the session key), which the desktop Browser wallet signs with again when it swaps the
   * blockhash; other wallets ignore it.
   */
  signer(umi: Umi, address: string, local?: readonly Signer[]): Signer;
  /** The link page: sign serialized transactions as `address` (one prompt), returned serialized. */
  signTransactionBytes?(address: string, txs: Uint8Array[]): Promise<Uint8Array[]>;
  /** The link page: sign a message as `address`. */
  signMessageBytes?(address: string, message: Uint8Array): Promise<Uint8Array>;
}

// ---- Wallet Standard ---------------------------------------------------------

type Signed = { readonly signedTransaction: Uint8Array };

/** The slice of the standard and Solana features the game uses. */
interface Features {
  'standard:connect': { connect(input?: { silent?: boolean }): Promise<{ readonly accounts: readonly WalletAccount[] }> };
  'standard:disconnect'?: { disconnect(): Promise<void> };
  'standard:events'?: {
    on(event: 'change', listener: (props: { accounts?: readonly WalletAccount[] }) => void): () => void;
  };
  'solana:signTransaction': {
    signTransaction(
      ...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]
    ): Promise<readonly Signed[]>;
  };
  'solana:signMessage'?: {
    signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<readonly { signature: Uint8Array }[]>;
  };
}

const isSolana = (a: WalletAccount) => a.chains.length === 0 || a.chains.some((c) => c.startsWith('solana:'));
const solanaAddresses = (accounts: readonly WalletAccount[]) => accounts.filter(isSolana).map((a) => a.address);

function standardWallet(w: Wallet): OwnerWallet {
  const f = w.features as unknown as Features;
  return {
    name: w.name,
    icon: w.icon,
    devnet: w.chains.includes(DEVNET),
    async connect(silent) {
      const { accounts } = await f['standard:connect'].connect(silent ? { silent: true } : undefined);
      return solanaAddresses(accounts)[0] ?? null;
    },
    async disconnect() {
      await f['standard:disconnect']?.disconnect();
    },
    watch(cb) {
      const events = f['standard:events'];
      if (!events) return () => {};
      // Only account changes matter here; a change to chains or features comes without `accounts`.
      return events.on('change', ({ accounts }) => accounts && cb(solanaAddresses(accounts)));
    },
    signer(umi, address) {
      const sign = async (txs: Transaction[]) =>
        (await signBytes(address, txs.map((tx) => umi.transactions.serialize(tx)))).map((b) => umi.transactions.deserialize(b));
      return {
        publicKey: publicKey(address),
        signMessage: (message) => signText(address, message),
        signTransaction: async (tx) => (await sign([tx]))[0],
        signAllTransactions: sign,
      };
    },
    signTransactionBytes: (address, txs) => signBytes(address, txs),
    signMessageBytes: (address, message) => signText(address, message),
  };

  function account(address: string) {
    const a = w.accounts.find((x) => x.address === address);
    if (!a) throw new Error(`${w.name} switched accounts. Reload the game to continue.`);
    return a;
  }
  async function signBytes(address: string, txs: Uint8Array[]): Promise<Uint8Array[]> {
    const a = account(address);
    // The game is devnet only: say so wherever the wallet lists devnet.
    const chain = a.chains.includes(DEVNET) || w.chains.includes(DEVNET) ? DEVNET : undefined;
    const out = await f['solana:signTransaction'].signTransaction(...txs.map((transaction) => ({ account: a, chain, transaction })));
    return out.map((o) => new Uint8Array(o.signedTransaction));
  }
  async function signText(address: string, message: Uint8Array): Promise<Uint8Array> {
    const sm = f['solana:signMessage'];
    if (!sm) throw new Error(`${w.name} can't sign messages`);
    const [out] = await sm.signMessage({ account: account(address), message });
    return out.signature;
  }
}

// ---- Phantom's legacy provider (fallback) -----------------------------------

interface PhantomKey {
  toString(): string;
  toBase58?(): string;
}

type PhantomEvent = 'accountChanged' | 'disconnect';

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: PhantomKey | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PhantomKey }>;
  disconnect(): Promise<void>;
  signTransaction<T>(tx: T): Promise<T>;
  signAllTransactions<T>(txs: T[]): Promise<T[]>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  on(event: PhantomEvent, cb: (arg?: PhantomKey | null) => void): void;
  off?(event: PhantomEvent, cb: (arg?: PhantomKey | null) => void): void;
  removeListener?(event: PhantomEvent, cb: (arg?: PhantomKey | null) => void): void;
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
  }
}

const keyString = (k: PhantomKey) => k.toBase58?.() ?? k.toString();

function legacyPhantom(p: PhantomProvider): OwnerWallet {
  return {
    name: 'Phantom',
    icon: '',
    devnet: false, // the legacy provider doesn't say: keep showing how to switch
    async connect(silent) {
      const { publicKey: pk } = await p.connect(silent ? { onlyIfTrusted: true } : undefined);
      return keyString(pk);
    },
    async disconnect() {
      await p.disconnect();
    },
    watch(cb) {
      // accountChanged(null): Phantom moved to an account that hasn't approved this site.
      const changed = (pk?: PhantomKey | null) => cb(pk ? [keyString(pk)] : []);
      const gone = () => cb([]);
      p.on('accountChanged', changed);
      p.on('disconnect', gone);
      return () => {
        const off = (p.off ?? p.removeListener)?.bind(p);
        off?.('accountChanged', changed);
        off?.('disconnect', gone);
      };
    },
    signer(_umi, address) {
      const adapters = () => import('@metaplex-foundation/umi-web3js-adapters');
      const sameAccount = () => {
        if (p.publicKey && keyString(p.publicKey) !== address) {
          throw new Error('Phantom switched accounts. Reload the game to continue.');
        }
      };
      return {
        publicKey: publicKey(address),
        async signMessage(message) {
          sameAccount();
          return (await p.signMessage(message)).signature;
        },
        async signTransaction(tx) {
          sameAccount();
          const { toWeb3JsTransaction, fromWeb3JsTransaction } = await adapters();
          return fromWeb3JsTransaction(await p.signTransaction(toWeb3JsTransaction(tx)));
        },
        async signAllTransactions(txs) {
          sameAccount();
          const { toWeb3JsTransaction, fromWeb3JsTransaction } = await adapters();
          return (await p.signAllTransactions(txs.map(toWeb3JsTransaction))).map(fromWeb3JsTransaction);
        },
      };
    },
    async signTransactionBytes(address, txs) {
      if (p.publicKey && keyString(p.publicKey) !== address) throw new Error('Phantom switched accounts. Reload to continue.');
      const { VersionedTransaction } = await import('@solana/web3.js');
      const signed = await p.signAllTransactions(txs.map((b) => VersionedTransaction.deserialize(b)));
      return signed.map((tx) => tx.serialize());
    },
    async signMessageBytes(address, message) {
      if (p.publicKey && keyString(p.publicKey) !== address) throw new Error('Phantom switched accounts. Reload to continue.');
      return (await p.signMessage(message)).signature;
    },
  };
}

// ---- Discovery -----------------------------------------------------------------

let registry: Wallets | null = null;
/** Created on first use: that dispatches the standard's app-ready event, so wallets already loaded register. */
const wallets = () => (registry ??= getWallets());

const wrapped = new WeakMap<object, OwnerWallet>();
function wrap<T extends object>(source: T, make: (s: T) => OwnerWallet): OwnerWallet {
  let w = wrapped.get(source);
  if (!w) wrapped.set(source, (w = make(source)));
  return w;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function standardWallets(): OwnerWallet[] {
  const list: OwnerWallet[] = [];
  for (const w of wallets().get()) {
    if (!usableWallet({ chains: w.chains, features: Object.keys(w.features) })) continue;
    if (list.some((o) => sameName(o.name, w.name))) continue;
    list.push(wrap(w, standardWallet));
  }
  return list;
}

/**
 * Every wallet the player can log in with right now, one per name. Looked up on every call:
 * extensions inject late. In the desktop app, only the Browser wallet.
 */
export function ownerWallets(): OwnerWallet[] {
  if (isDesktop()) return [browserWallet()];
  const list = standardWallets();
  const p = window.phantom?.solana;
  if (p?.isPhantom && !list.some((o) => sameName(o.name, 'Phantom'))) list.push(wrap(p, legacyPhantom));
  return list;
}

export function findWallet(name: string): OwnerWallet | null {
  return ownerWallets().find((w) => sameName(w.name, name)) ?? null;
}

/** Calls back whenever a wallet registers or unregisters. Returns the unsubscribe. */
export function onWalletsChange(cb: () => void): () => void {
  const offs = [wallets().on('register', cb), wallets().on('unregister', cb)];
  return () => offs.forEach((off) => off());
}

/**
 * The wallet called `name`, waiting up to `ms` for it to register through the
 * standard; then Phantom's legacy provider, if that is what is asked for.
 */
export function waitForWallet(name: string, ms: number): Promise<OwnerWallet | null> {
  if (isDesktop()) return Promise.resolve(findWallet(name));
  const registered = () => standardWallets().find((w) => sameName(w.name, name)) ?? null;
  const now = registered();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      off();
      clearTimeout(timer);
      resolve(findWallet(name));
    };
    const off = onWalletsChange(() => registered() && done());
    const timer = setTimeout(done, ms);
  });
}
