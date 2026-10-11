// Pure helpers behind the wallet login: per-wallet localStorage keys, the
// one-time move of pre-login progress into the first wallet that signs in,
// the logout flag, and which wallets the picker offers.
// No imports, so tests can load this file straight from its TypeScript source.

export const PREFIX = 'deepbreath.';

/** Device-wide: set once pre-login progress has been copied into a wallet. Holds that owner. */
export const MIGRATED_KEY = 'deepbreath.migratedTo';

/** Device-wide: '0' after the player logged out, so page loads stop reconnecting silently. */
export const AUTOCONNECT_KEY = 'deepbreath.autoConnect';

/** Device-wide: the name of the wallet app the player last connected with ("Phantom"). Never anything secret. */
export const LAST_WALLET_KEY = 'deepbreath.lastWallet';

/** Before the picker existed, Phantom was the only wallet: restore it for players who logged in back then. */
export const DEFAULT_WALLET = 'Phantom';

/** Per-wallet name of the in-game session keypair (pays fees, signs mints). */
export const SESSION_NAME = 'session';

/** The pre-login burner. It becomes the first owner's session wallet so its devnet SOL isn't stranded. */
export const LEGACY_WALLET_KEY = 'deepbreath.wallet';

/**
 * Every per-player key the game wrote before Phantom login, by bare name. Device
 * preferences (`deepbreath.settings`) are not progress and stay where they are.
 */
export const LEGACY_PROGRESS = ['bank', 'equipment', 'rod', 'pearls', 'pearl', 'maps', 'health', 'pearl.pending'] as const;

/** `bank` and `deepbreath.bank` both name the same per-wallet entry. */
export function bareName(name: string): string {
  const bare = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
  if (!bare) throw new Error('Storage key name is empty');
  return bare;
}

/** `deepbreath.<owner>.<name>`. Base58 addresses never contain '.', so keys can't collide. */
export function namespacedKey(owner: string, name: string): string {
  if (!owner) throw new Error('Connect Phantom first: per-wallet storage needs an owner');
  if (owner.includes('.')) throw new Error(`Not a wallet address: ${owner}`);
  return `${PREFIX}${owner}.${bareName(name)}`;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RemovableStore extends KeyValueStore {
  removeItem(key: string): void;
}

/**
 * Which wallet a page load may reconnect without asking, or null. Only the one
 * the player last used, and never after they logged out: an explicit logout
 * sticks across reloads until they connect again.
 */
export function restoreTarget(store: Pick<KeyValueStore, 'getItem'>): string | null {
  if (store.getItem(AUTOCONNECT_KEY) === '0') return null;
  return store.getItem(LAST_WALLET_KEY) || DEFAULT_WALLET;
}

/** The player logged out (or disconnected inside their wallet): stop reconnecting on page load. */
export function markLoggedOut(store: KeyValueStore) {
  store.setItem(AUTOCONNECT_KEY, '0');
}

/** The player connected `wallet` themselves: page loads may reconnect it silently again. */
export function markLoggedIn(store: RemovableStore, wallet: string) {
  store.removeItem(AUTOCONNECT_KEY);
  store.setItem(LAST_WALLET_KEY, wallet);
}

export interface MigrationStep {
  from: string;
  to: string;
}

/**
 * What moving pre-login data into `owner` would copy, or null when some wallet
 * already received it. A destination that already holds data is never overwritten.
 */
export function planMigration(store: Pick<KeyValueStore, 'getItem'>, owner: string): MigrationStep[] | null {
  if (store.getItem(MIGRATED_KEY) != null) return null;
  const pairs: MigrationStep[] = [
    { from: LEGACY_WALLET_KEY, to: namespacedKey(owner, SESSION_NAME) },
    ...LEGACY_PROGRESS.map((name) => ({ from: PREFIX + name, to: namespacedKey(owner, name) })),
  ];
  return pairs.filter(({ from, to }) => store.getItem(from) != null && store.getItem(to) == null);
}

/**
 * Copy pre-login data into the first wallet that logs in, once per browser.
 * Each copy is read back before the next; the marker is written only after all
 * of them succeed. Nothing is deleted: the old keys simply stop being read.
 */
export function migrateLegacy(store: KeyValueStore, owner: string): MigrationStep[] | null {
  const plan = planMigration(store, owner);
  if (!plan) return null;
  for (const { from, to } of plan) {
    const value = store.getItem(from)!;
    store.setItem(to, value);
    if (store.getItem(to) !== value) throw new Error(`Could not copy ${from} to ${to}`);
  }
  store.setItem(MIGRATED_KEY, owner);
  return plan;
}

/** A stored 64-byte ed25519 secret key (JSON number array, as the burner used), or null. */
export function parseSecretKey(raw: string | null): Uint8Array | null {
  if (raw == null) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || arr.length !== 64) return null;
    if (!arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
    return Uint8Array.from(arr as number[]);
  } catch {
    return null;
  }
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

/** The address of a 64-byte secret key: its last 32 bytes are the public key. */
export function addressOfSecret(secret: Uint8Array): string {
  return base58(secret.subarray(32, 64));
}

export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** An address on Solana Explorer (devnet). Pure, so UI can link an address without chain code. */
export const explorerAddress = (a: string) => `https://explorer.solana.com/address/${encodeURIComponent(a)}?cluster=devnet`;
/** A transaction on Solana Explorer (devnet). */
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=devnet`;

// ---- Wallet picker ----------------------------------------------------------

/** The game runs on Solana devnet, as Wallet Standard names the chain. */
export const DEVNET = 'solana:devnet';

/** Wallets the picker always shows, installed or not, in this order. */
export const KNOWN_WALLETS = [
  { name: 'Phantom', url: 'https://phantom.com/download' },
  { name: 'MetaMask', url: 'https://metamask.io/download/' },
  { name: 'Solflare', url: 'https://solflare.com/download' },
  { name: 'Backpack', url: 'https://backpack.app/download' },
] as const;

export interface WalletInfo {
  name: string;
  chains: readonly string[];
  features: readonly string[];
}

/**
 * Can the game log in with this Wallet Standard wallet? It must connect, hold a
 * Solana account, and sign a transaction without sending it: mints, sales and
 * top-ups are signed first and sent by the game (a sale is co-signed by the
 * market too), so a sign-and-send-only wallet couldn't finish them.
 */
export function usableWallet(w: Pick<WalletInfo, 'chains' | 'features'>): boolean {
  return (
    w.features.includes('standard:connect') &&
    w.features.includes('solana:signTransaction') &&
    w.chains.some((c) => c.startsWith('solana:'))
  );
}

export interface WalletTile {
  name: string;
  installed: boolean;
  lastUsed: boolean;
  /** The wallet lists Solana devnet (unknown, so true, for wallets that aren't installed). */
  devnet: boolean;
  /** Where to get it, for a known wallet. */
  url: string | null;
}

const known = (name: string) => KNOWN_WALLETS.findIndex((k) => k.name.toLowerCase() === name.toLowerCase());

/**
 * The picker's tiles: installed wallets first (the last used one leading, then
 * the known ones in order, then the rest by name), then the known wallets that
 * aren't installed, to install. One tile per name.
 */
export function walletTiles(installed: readonly { name: string; devnet: boolean }[], lastUsed: string | null): WalletTile[] {
  const seen = new Set<string>();
  const last = lastUsed?.toLowerCase() ?? null;
  const rank = (name: string) => {
    if (name.toLowerCase() === last) return -1;
    const i = known(name);
    return i < 0 ? KNOWN_WALLETS.length : i;
  };
  const tiles: WalletTile[] = [];
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  // Stable: of two registrations with one name, the first keeps the tile.
  for (const w of [...installed].sort((a, b) => rank(a.name) - rank(b.name) || byName(a.name, b.name))) {
    const id = w.name.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const k = known(w.name);
    tiles.push({
      name: w.name,
      installed: true,
      lastUsed: id === last,
      devnet: w.devnet,
      url: k < 0 ? null : KNOWN_WALLETS[k].url,
    });
  }
  for (const k of KNOWN_WALLETS) {
    if (seen.has(k.name.toLowerCase())) continue;
    tiles.push({ name: k.name, installed: false, lastUsed: k.name.toLowerCase() === last, devnet: true, url: k.url });
  }
  return tiles;
}

/** One line on getting a wallet onto devnet, where the game's fish and PEARL live. */
export function devnetHint(name: string): string {
  if (name.toLowerCase() === 'phantom') return 'Devnet only. Phantom → Settings → Developer Settings → Testnet Mode → Solana Devnet';
  return `Devnet only. Switch ${name} to Solana Devnet in its network settings.`;
}

/** Phantom reports a declined prompt as code 4001 (EIP-1193 style). */
export function isUserRejection(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  if (err?.code === 4001) return true;
  return typeof err?.message === 'string' && /user rejected|rejected the request|cancel/i.test(err.message);
}

/**
 * Which of these keys hold health data: `deepbreath.<owner>.health` / `.trips` for any owner,
 * plus the legacy unscoped `deepbreath.health` / `deepbreath.trips`. Nothing else, never `.session`.
 */
export function healthDataKeys(keys: string[]): string[] {
  const names = ['health', 'trips'];
  return keys.filter((k) => {
    if (!k.startsWith(PREFIX)) return false;
    const rest = k.slice(PREFIX.length);
    const dot = rest.lastIndexOf('.');
    const name = dot < 0 ? rest : rest.slice(dot + 1);
    if (!names.includes(name)) return false;
    return dot < 0 || (dot > 0 && !rest.slice(0, dot).includes('.'));
  });
}

function allStorageKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null) keys.push(k);
    }
  } catch {}
  return keys;
}

/** Is there any health or trip data on this device, for any wallet? */
export function hasHealthData(): boolean {
  return healthDataKeys(allStorageKeys()).length > 0;
}

/** Remove every health and trip record on this device, for all wallets. */
export function clearAllHealthData(): void {
  for (const k of healthDataKeys(allStorageKeys())) {
    try {
      localStorage.removeItem(k);
    } catch {}
  }
}
