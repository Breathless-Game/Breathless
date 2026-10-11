// Pure helpers behind the Phantom login: per-wallet localStorage keys and the
// one-time move of pre-login progress into the first wallet that signs in.
// No imports, so tests can load this file straight from its TypeScript source.

export const PREFIX = 'deepbreath.';

/** Device-wide: set once pre-login progress has been copied into a wallet. Holds that owner. */
export const MIGRATED_KEY = 'deepbreath.migratedTo';

/** Device-wide: '0' after the player pressed Disconnect, so page loads stop reconnecting silently. */
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

/** Phantom reports a declined prompt as code 4001 (EIP-1193 style). */
export function isUserRejection(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  if (err?.code === 4001) return true;
  return typeof err?.message === 'string' && /user rejected|rejected the request|cancel/i.test(err.message);
}
