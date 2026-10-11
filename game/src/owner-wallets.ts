import { getWallets, type Wallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { publicKey, type Signer, type Transaction, type Umi } from '@metaplex-foundation/umi';
import { DEVNET, usableWallet } from './wallet-storage';

// Every wallet the player can log in with, behind one interface: Wallet
// Standard wallets (Phantom, MetaMask, Solflare, Backpack and any other that
// registers), plus Phantom's legacy window.phantom.solana, only when Phantom
// didn't register through the standard. wallet.ts sees an address, account
// changes and an umi Signer; it never touches a wallet directly.

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
  /** Signs as `address`: every signature is a prompt in this wallet. */
  signer(umi: Umi, address: string): Signer;
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
      const account = () => {
        const a = w.accounts.find((x) => x.address === address);
        if (!a) throw new Error(`${w.name} switched accounts. Reload the game to continue.`);
        return a;
      };
      // The game is devnet only: say so wherever the wallet lists devnet.
      const chain = (a: WalletAccount) => (a.chains.includes(DEVNET) || w.chains.includes(DEVNET) ? DEVNET : undefined);
      const sign = async (txs: Transaction[]) => {
        const a = account();
        const out = await f['solana:signTransaction'].signTransaction(
          ...txs.map((tx) => ({ account: a, chain: chain(a), transaction: umi.transactions.serialize(tx) })),
        );
        return out.map((o) => umi.transactions.deserialize(new Uint8Array(o.signedTransaction)));
      };
      return {
        publicKey: publicKey(address),
        async signMessage(message) {
          const sm = f['solana:signMessage'];
          if (!sm) throw new Error(`${w.name} can't sign messages`);
          const [out] = await sm.signMessage({ account: account(), message });
          return out.signature;
        },
        signTransaction: async (tx) => (await sign([tx]))[0],
        signAllTransactions: sign,
      };
    },
  };
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

/** Every wallet the player can log in with right now, one per name. Looked up on every call: extensions inject late. */
export function ownerWallets(): OwnerWallet[] {
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
