// Fish NFTs go through the market's co-signature (sensor/fish-collection.mjs): the market only
// buys fish in its "Breathless Fish" collection, and only the market wallet can put a fish there.
//
//   mint     The game asks POST /api/market/cosign-mint with the fish. The server re-derives it
//            from its seed, builds the Core create (collection = its own) and signs as collection
//            authority; the session key signs as payer (the game wallet still pays the mint), the
//            new asset signs, and we send it.
//   migrate  Fish minted before the collection existed have the session key as update authority.
//            POST /api/market/cosign-migrate returns transactions that hand them to the market and
//            into the collection; the session key signs and pays. A fish whose session key lives on
//            another device can't be moved from here: it is marked not sellable, with the reason.
//
// The helpers at the top are pure (game/tests/fish-cosign.test.mjs loads this file on its own);
// the chain libraries are imported lazily inside the flows, as in pearl.ts.

import type { Signer, Umi } from '@metaplex-foundation/umi';

export const CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const API = '/api/market';
/** Fish per POST /cosign-migrate (the server's MIGRATE_BATCH). */
export const MIGRATE_BATCH = 12;

/** The parts of /api/market/info this file reads. */
export interface CosignInfo {
  mode: 'program' | 'server';
  market: string | null;
  /** Server mode: the collection every sellable fish is in (null until the market has created it). */
  fishCollection?: string | null;
  /** Server mode: the co-sign routes exist. Older servers and program mode mint without them. */
  cosign?: boolean;
}

/** A market answer that was not OK. `code`/`retryAfterMs`/`assetId` come from the server's JSON. */
export class CosignError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterMs?: number,
    readonly assetId?: string,
  ) {
    super(message);
    this.name = 'CosignError';
  }
}

/** A limit the market applies per wallet (mints per hour, PEARL per day): wait, don't retry now. */
export const isLimit = (e: unknown): e is CosignError => e instanceof CosignError && e.status === 429;

export async function cosignApi<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      `${API}${path}`,
      body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
  } catch {
    throw new CosignError('The PEARL market is offline, try again later', 0);
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: string; code?: string; retryAfterMs?: number; assetId?: string }) | null;
  if (!json || typeof json !== 'object') throw new CosignError('The PEARL market is offline, try again later', 0);
  if (!res.ok) throw new CosignError(json.error ?? `PEARL market error ${res.status}`, res.status, json.code, json.retryAfterMs, json.assetId);
  return json;
}

let cached: { at: number; info: Promise<CosignInfo> } | null = null;

/** /api/market/info, cached for a minute (the collection never changes once created). */
export function cosignInfo(maxAgeMs = 60_000): Promise<CosignInfo> {
  if (!cached || Date.now() - cached.at > maxAgeMs) {
    const info = cosignApi<CosignInfo>('/info');
    cached = { at: Date.now(), info };
    info.catch(() => (cached = null));
  }
  return cached.info;
}

/** How to mint with this market: co-signed into its collection, the old way (no collection), or wait for the collection. */
export function mintRoute(info: CosignInfo): 'cosign' | 'legacy' | 'wait' {
  if (!info.cosign) return 'legacy';
  return info.fishCollection ? 'cosign' : 'wait';
}

/** What the market needs to re-derive the fish: the facts written on-chain, the NFT name and URI. */
export interface MintFacts {
  id: string;
  rarity: string;
  species: string;
  /** Recorded depth (whole metres), and the catch value, exactly as the Attributes will say. */
  depth: number;
  value: number;
}

export function mintRequest(fish: MintFacts, a: { owner: string; payer: string; asset: string; name: string; uri: string }) {
  return { ...a, fish: { id: fish.id, rarity: fish.rarity, species: fish.species, depth: fish.depth, value: fish.value } };
}

interface MessageLike {
  accounts: readonly unknown[];
  header: { numRequiredSignatures: number };
  instructions: readonly { programIndex: number; accountIndexes?: readonly number[]; data?: Uint8Array }[];
}

/**
 * mpl-core's createV2 discriminator (a single u8). @metaplex-foundation/mpl-core 1.10.0's create()
 * builds createV2 (dist/src/generated/instructions/createV2.js: discriminator 20).
 */
export const CORE_CREATE_V2_DISCRIMINATOR = 20;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * The one Core instruction a co-signed mint may carry: createV2 of our new asset into the
 * Breathless collection, owned by this player, paid by our session key, the market signing as the
 * collection's update authority. Account order from mpl-core 1.10.0 createV2.js: asset,
 * collection, authority, payer, owner, updateAuthority, systemProgram, logWrapper; the two it
 * leaves unset (no update authority inside a collection, no log wrapper) are Core's own id.
 */
export interface ExpectedCreate {
  asset: string;
  collection: string;
  /** The market wallet. */
  authority: string;
  /** Our session key. */
  payer: string;
  owner: string;
}

/** Why this Core instruction is not exactly the create we expect, or null. */
function coreCreateProblem(keys: string[], ix: MessageLike['instructions'][number], want: ExpectedCreate): string | null {
  if (!ix.data || ix.data[0] !== CORE_CREATE_V2_DISCRIMINATOR) return 'its Core call is not a create';
  const accounts = (ix.accountIndexes ?? []).map((i) => keys[i]);
  if (accounts[0] !== want.asset) return 'it creates another asset';
  if (accounts[1] !== want.collection) return 'it creates the fish outside the Breathless collection';
  if (accounts[2] !== want.authority) return 'its create authority is not the market';
  if (accounts[3] !== want.payer) return 'its create payer is not the game wallet';
  if (accounts[4] !== want.owner) return 'it creates the fish for another owner';
  const expected = [want.asset, want.collection, want.authority, want.payer, want.owner, CORE_PROGRAM, SYSTEM_PROGRAM, CORE_PROGRAM];
  if (accounts.length !== expected.length || accounts.some((a, i) => a !== expected[i])) return 'its create has unexpected accounts';
  return null;
}

/** player_state record_catch's discriminator (game/src/idl/player_state.json; player-state.ts INSTRUCTION_DISCRIMINATORS). */
export const RECORD_CATCH_DISCRIMINATOR: readonly number[] = Object.freeze([36, 14, 58, 242, 96, 105, 45, 233]);

/**
 * The one player_state instruction a co-signed mint may carry: record_catch for this player's
 * fish, signed by the market as oracle and paid by our session key (sensor/fish-collection.mjs
 * buildMintTx). Every address is what we derived ourselves.
 */
export interface ExpectedRecordCatch {
  program: string;
  /** The market wallet (Config.oracle). */
  oracle: string;
  /** Our session key. */
  payer: string;
  /** player_state Config PDA ["config"]. */
  config: string;
  owner: string;
  /** This owner's Progress PDA ["progress", owner]. */
  progress: string;
  /** The fish's seed key and its catch value, as the mint request said. */
  fish: bigint;
  value: number;
}

const u64At = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);

/** Why this player_state instruction is not exactly the record_catch we expect, or null. */
function recordCatchProblem(keys: string[], ix: MessageLike['instructions'][number], want: ExpectedRecordCatch): string | null {
  const data = ix.data;
  if (!data || data.length !== 24 || RECORD_CATCH_DISCRIMINATOR.some((b, i) => data[i] !== b)) return 'it calls a player_state instruction other than record_catch';
  const accounts = (ix.accountIndexes ?? []).map((i) => keys[i]);
  const expected = [want.oracle, want.payer, want.config, want.owner, want.progress, SYSTEM_PROGRAM];
  if (accounts.length !== expected.length) return 'its record_catch has unexpected accounts';
  if (accounts[0] !== want.oracle) return 'its record_catch oracle is not the market';
  if (accounts[1] !== want.payer) return 'its record_catch payer is not the game wallet';
  if (accounts[3] !== want.owner || accounts[4] !== want.progress) return 'its record_catch is for another player';
  if (accounts.some((a, i) => a !== expected[i])) return 'its record_catch has unexpected accounts';
  if (u64At(data, 8) !== want.fish || u64At(data, 16) !== BigInt(want.value)) return 'its record_catch is for another fish or value';
  return null;
}

/**
 * mpl-core's updateV2 discriminator (a single u8). @metaplex-foundation/mpl-core 1.10.0's update()
 * builds updateV2 (dist/src/instructions/update.js; generated/instructions/updateV2.js: discriminator 30).
 */
export const CORE_UPDATE_V2_DISCRIMINATOR = 30;
/** BaseUpdateAuthority's variants (mpl-core 1.10.0 generated/types/baseUpdateAuthority.js): None, Address, Collection. */
const UA_ADDRESS = 1;
const UA_COLLECTION = 2;

/**
 * The only Core calls a migration may carry (sensor/fish-collection.mjs cosignMigrate): for each
 * fish, in order, two updateV2s. First the session key, its update authority, hands it to the
 * market; then the market, now its authority and the collection's, moves it into the collection.
 * The session key pays both. Account order from mpl-core 1.10.0 updateV2.js: asset, collection,
 * payer, authority, newCollection, systemProgram, logWrapper; the unset ones (no current
 * collection, no new one in the hand-over, no log wrapper) are Core's own id. Data: discriminator,
 * newName None, newUri None, newUpdateAuthority Some(Address(market) | Collection(collection)).
 */
export interface ExpectedMigrate {
  /** The fish this transaction moves, as the market lists them; each must be one of `requested`. */
  assetIds: string[];
  /** The fish we sent in this /cosign-migrate request. */
  requested: string[];
  /** Our session key. */
  session: string;
  market: string;
  collection: string;
  /** The market's and the collection's 32 bytes, as the new update authority carries them. */
  marketBytes: Uint8Array;
  collectionBytes: Uint8Array;
}

const sameBytes = (a: Uint8Array, at: number, b: Uint8Array) => b.every((x, i) => a[at + i] === x);

/** Why the `n`th Core call of a migration is not exactly the update we expect there, or null. */
function coreMigrateProblem(keys: string[], ix: MessageLike['instructions'][number], want: ExpectedMigrate, n: number): string | null {
  const data = ix.data;
  if (!data || data[0] !== CORE_UPDATE_V2_DISCRIMINATOR) return 'its Core call is not a fish update';
  const asset = want.assetIds[n >> 1];
  const handOver = n % 2 === 0;
  const accounts = (ix.accountIndexes ?? []).map((i) => keys[i]);
  if (accounts[0] !== asset) return 'it updates another asset than the fish it moves';
  if (data[1] !== 0 || data[2] !== 0) return 'its update renames the fish or changes its URI';
  const to = handOver ? want.marketBytes : want.collectionBytes;
  const newAuthority = data.length === 5 + to.length && data[3] === 1 && data[4] === (handOver ? UA_ADDRESS : UA_COLLECTION) && sameBytes(data, 5, to);
  if (handOver && !newAuthority) return 'its update hands the fish to someone other than the market';
  if (!handOver && (!newAuthority || accounts[4] !== want.collection)) return 'it moves the fish outside the Breathless collection';
  const expected = handOver
    ? [asset, CORE_PROGRAM, want.session, want.session, CORE_PROGRAM, SYSTEM_PROGRAM, CORE_PROGRAM]
    : [asset, CORE_PROGRAM, want.session, want.market, want.collection, SYSTEM_PROGRAM, CORE_PROGRAM];
  if (accounts.length !== expected.length || accounts.some((a, i) => a !== expected[i])) return 'its update has unexpected accounts';
  return null;
}

/**
 * Sign only what we asked for: the fee payer is our session key, the signers are exactly the
 * expected ones, and every instruction is a Core call. For a mint (`create` and `recordCatch`
 * given) that is exactly one Core create, exactly the expected one, plus exactly one player_state
 * record_catch, exactly the expected one. For a migration (`migrate`) it is exactly the two
 * updates per fish listed, each listed fish one we asked to move. Anything else from player_state
 * or any other program, or a Core call with neither to check it against, is refused. Returns why
 * not, or null.
 */
export function cosignedTxProblem(
  m: MessageLike,
  expect: { payer: string; signers: string[]; program?: string; create?: ExpectedCreate; recordCatch?: ExpectedRecordCatch; migrate?: ExpectedMigrate },
): string | null {
  const keys = m.accounts.map(String);
  if (keys[0] !== expect.payer) return 'its fee payer is not the game wallet';
  const signers = keys.slice(0, m.header.numRequiredSignatures);
  if (signers.length !== expect.signers.length || !expect.signers.every((s) => signers.includes(s))) return 'it asks for unexpected signatures';
  const mig = expect.migrate;
  if (mig) {
    if (!mig.assetIds.length) return 'it moves no fish';
    if (new Set(mig.assetIds).size !== mig.assetIds.length || !mig.assetIds.every((id) => mig.requested.includes(id))) return 'it moves a fish we did not ask to move';
  }
  const program = expect.program ?? CORE_PROGRAM;
  const rc = expect.recordCatch;
  let catches = 0;
  let core = 0;
  for (const ix of m.instructions) {
    const p = keys[ix.programIndex];
    if (p === program) {
      if (mig && core >= 2 * mig.assetIds.length) return 'it makes more Core calls than the fish it moves';
      if (++core > 1 && expect.create) return 'it makes more than one Core call';
      const problem = expect.create ? coreCreateProblem(keys, ix, expect.create) : mig ? coreMigrateProblem(keys, ix, mig, core - 1) : null;
      if (problem) return problem;
      continue;
    }
    if (!rc || p !== rc.program) return OTHER_PROGRAM;
    if (++catches > 1) return 'it records the catch more than once';
    const problem = recordCatchProblem(keys, ix, rc);
    if (problem) return problem;
  }
  if (!core) return 'it makes no Core call';
  if (rc && catches !== 1) return NO_RECORD_CATCH;
  if (mig && core !== 2 * mig.assetIds.length) return 'it does not move exactly the fish we asked for';
  if (!expect.create && !mig) return 'it is neither our mint nor our migration';
  return null;
}

const OTHER_PROGRAM = 'it calls a program other than Metaplex Core';
const NO_RECORD_CATCH = 'it does not record the catch';
/**
 * The game and the market speak different versions of the co-sign protocol: a tab older than the
 * server (it sees record_catch, or another new instruction) or newer (the server sends no
 * record_catch). Reloading the page fixes the first; the second clears when the server catches up.
 */
export const staleProtocol = (problem: string | null) => problem === OTHER_PROGRAM || problem === NO_RECORD_CATCH;

/** Where a minted fish stands with the market. */
export type FishTrust =
  | { state: 'trusted' }
  | { state: 'migrate' }
  /** This market doesn't check collections (older server, program mode): sell as before. */
  | { state: 'unchecked' }
  /** It can never be sold from this device (reason shown on the card). */
  | { state: 'blocked'; reason: string }
  /** Something temporary (offline, a limit): try again later. */
  | { state: 'error'; reason: string; retryAfterMs?: number };

export const OTHER_DEVICE = 'Minted by your game wallet on another device or browser: open the game there once to make it sellable.';

/** Classify a fetched asset by its update authority and owner. */
export function classifyFish(
  a: { owner: unknown; updateAuthority: { type: string; address?: unknown } },
  ctx: { owner: string; session: string; collection: string },
): FishTrust {
  const ua = a.updateAuthority;
  if (ua.type === 'Collection' && String(ua.address) === ctx.collection) return { state: 'trusted' };
  if (String(a.owner) !== ctx.owner) return { state: 'blocked', reason: 'This NFT is no longer in your wallet.' };
  if (ua.type !== 'Address') return { state: 'blocked', reason: 'Not a Breathless fish NFT: the market only buys fish minted by the game.' };
  return String(ua.address) === ctx.session ? { state: 'migrate' } : { state: 'blocked', reason: OTHER_DEVICE };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

type PlayerStateModule = typeof import('./player-state');
type Pk = Parameters<PlayerStateModule['findProgressPda']>[1];

/**
 * Everything a co-signed mint may contain, derived here from what we asked for (never from the
 * market's answer): the Core create of our asset into the Breathless collection, and the market's
 * record_catch of this fish's value onto this owner's lifetime banked value. Pure given the
 * player-state module, so tests feed sensor/fish-collection.mjs buildMintTx through it.
 */
export function mintExpectation(
  ps: Pick<PlayerStateModule, 'playerStateProgramId' | 'findConfigPda' | 'findProgressPda' | 'fishSeedKey'>,
  u: Umi,
  a: { market: string; collection: string; owner: Pk; payer: string; asset: string; fish: { id: string; value: number } },
) {
  const program = ps.playerStateProgramId();
  const owner = a.owner.toString();
  const create: ExpectedCreate = { asset: a.asset, collection: a.collection, authority: a.market, payer: a.payer, owner };
  const recordCatch: ExpectedRecordCatch = {
    program: program.toString(),
    oracle: a.market,
    payer: a.payer,
    config: ps.findConfigPda(u, program)[0].toString(),
    owner,
    progress: ps.findProgressPda(u, a.owner, program)[0].toString(),
    fish: ps.fishSeedKey(a.fish.id),
    value: a.fish.value,
  };
  return { payer: a.payer, signers: [a.payer, a.asset, a.market], create, recordCatch };
}

/**
 * Everything one of the market's migration transactions may contain, from what we asked for: the
 * fish it lists must be among `requested` (the ids we sent), and the new authorities are the
 * market and the collection we already know. Pure given publicKeyBytes (umi's), so tests feed the
 * server's update() calls through it.
 */
export function migrateExpectation(
  publicKeyBytes: (key: string) => Uint8Array,
  a: { session: string; market: string; collection: string; requested: string[]; assetIds: string[] },
) {
  const migrate: ExpectedMigrate = {
    assetIds: a.assetIds,
    requested: a.requested,
    session: a.session,
    market: a.market,
    collection: a.collection,
    marketBytes: publicKeyBytes(a.market),
    collectionBytes: publicKeyBytes(a.collection),
  };
  return { payer: a.session, signers: [a.session, a.market], migrate };
}

/** The error for a transaction we won't sign; a protocol mismatch asks the player to reload. */
async function unexpectedTx(what: string, problem: string): Promise<string> {
  const { t } = await import('./i18n');
  if (staleProtocol(problem)) {
    return t(
      `The game and the market are on different versions (${problem}). Refresh the page and try again; nothing was signed`,
      `游戏和市场版本不一致（${problem}）。请刷新页面后重试；没有签署任何交易`,
    );
  }
  return t(`The market sent an unexpected ${what} (${problem}); not signing it`, `市场发来了异常的交易（${problem}），未签署`);
}

// ---- Chain flows --------------------------------------------------------------------------------

export interface CosignedMint {
  asset: string;
  /** '' when an earlier attempt already minted it and we adopted that asset. */
  signature: string;
  collection: string;
}

/** Mint one fish into the market's collection: the market co-signs, the session key pays and sends. */
export async function cosignMint(
  u: Umi,
  args: { info: CosignInfo; owner: string; session: Signer; fish: MintFacts; name: string; uri: string },
): Promise<CosignedMint> {
  const [{ generateSigner, publicKey }, { base58 }] = await Promise.all([import('@metaplex-foundation/umi'), import('@metaplex-foundation/umi/serializers')]);
  const collection = args.info.fishCollection as string;
  const asset = generateSigner(u);
  const payer = args.session.publicKey.toString();
  let res: { tx: string; lastValidBlockHeight: number };
  try {
    res = await cosignApi('/cosign-mint', mintRequest(args.fish, { owner: args.owner, payer, asset: asset.publicKey.toString(), name: args.name, uri: args.uri }));
  } catch (e) {
    // An earlier attempt landed after all (its confirmation was lost): that asset is this fish.
    if (e instanceof CosignError && e.code === 'already-minted' && e.assetId) return { asset: e.assetId, signature: '', collection };
    throw e;
  }
  const tx = u.transactions.deserialize(fromBase64(res.tx));
  const ps = await import('./player-state');
  const expect = mintExpectation(ps, u, { market: String(args.info.market), collection, owner: publicKey(args.owner), payer, asset: asset.publicKey.toString(), fish: args.fish });
  const problem = cosignedTxProblem(tx.message, expect);
  if (problem) throw new Error(await unexpectedTx('mint transaction', problem));
  const signed = await asset.signTransaction(await args.session.signTransaction(tx));
  const sig = await u.rpc.sendTransaction(signed, { preflightCommitment: 'confirmed' });
  const done = await u.rpc.confirmTransaction(sig, {
    commitment: 'confirmed',
    strategy: { type: 'blockhash', blockhash: tx.message.blockhash, lastValidBlockHeight: res.lastValidBlockHeight },
  });
  if (done.value.err) throw new Error(`Mint failed on-chain: ${JSON.stringify(done.value.err)}`);
  return { asset: asset.publicKey.toString(), signature: base58.deserialize(sig)[0], collection };
}

/**
 * Make minted fish sellable: those already in the collection are fine, those this device's session
 * key minted before the collection are migrated (one co-sign request per MIGRATE_BATCH fish), the
 * rest are blocked with a reason. Every asset id gets an answer; nothing throws for one fish.
 */
export async function makeSellable(
  u: Umi,
  args: { info: CosignInfo; owner: string; session: Signer; assetIds: string[] },
): Promise<Map<string, FishTrust>> {
  const out = new Map<string, FishTrust>();
  const { info, owner, session, assetIds } = args;
  if (!info.cosign) {
    for (const id of assetIds) out.set(id, { state: 'unchecked' }); // this market does not check collections
    return out;
  }
  if (!info.fishCollection) {
    for (const id of assetIds) out.set(id, { state: 'error', reason: 'The market is still creating its fish collection, try again shortly' });
    return out;
  }
  const [{ fetchAsset }, { publicKey, publicKeyBytes }] = await Promise.all([import('@metaplex-foundation/mpl-core'), import('@metaplex-foundation/umi')]);
  const ctx = { owner, session: session.publicKey.toString(), collection: info.fishCollection };
  const toMove: string[] = [];
  await Promise.all(
    assetIds.map(async (id) => {
      try {
        const t = classifyFish(await fetchAsset(u, publicKey(id)), ctx);
        if (t.state === 'migrate') toMove.push(id);
        else out.set(id, t);
      } catch (e) {
        const gone = /not found|AccountNotFound|does not exist/i.test(messageOf(e));
        out.set(id, gone ? { state: 'blocked', reason: 'This NFT no longer exists (sold or burned).' } : { state: 'error', reason: messageOf(e).slice(0, 160) });
      }
    }),
  );
  toMove.sort((a, b) => assetIds.indexOf(a) - assetIds.indexOf(b));

  for (let i = 0; i < toMove.length; i += MIGRATE_BATCH) {
    const ids = toMove.slice(i, i + MIGRATE_BATCH);
    let res: { txs: { tx: string; assetIds: string[]; lastValidBlockHeight: number }[]; rejected: { assetId: string; status: number; error: string }[] };
    try {
      res = await cosignApi('/cosign-migrate', { owner, payer: ctx.session, assetIds: ids });
    } catch (e) {
      const c = e instanceof CosignError ? e : null;
      for (const id of ids) out.set(id, { state: 'error', reason: messageOf(e), retryAfterMs: c?.retryAfterMs });
      continue;
    }
    // A fish the market checked and refused (e.g. attributes the game could not have rolled) stays unsellable.
    for (const r of res.rejected) out.set(r.assetId, r.status === 422 ? { state: 'blocked', reason: r.error } : { state: 'error', reason: r.error });
    await Promise.all(
      res.txs.map(async (t) => {
        try {
          const tx = u.transactions.deserialize(fromBase64(t.tx));
          const expect = migrateExpectation(publicKeyBytes, { session: ctx.session, market: String(info.market), collection: ctx.collection, requested: ids, assetIds: t.assetIds });
          const problem = cosignedTxProblem(tx.message, expect);
          if (problem) throw new Error(await unexpectedTx('transaction', problem));
          const sig = await u.rpc.sendTransaction(await session.signTransaction(tx), { preflightCommitment: 'confirmed' });
          const done = await u.rpc.confirmTransaction(sig, {
            commitment: 'confirmed',
            strategy: { type: 'blockhash', blockhash: tx.message.blockhash, lastValidBlockHeight: t.lastValidBlockHeight },
          });
          if (done.value.err) throw new Error(`Moving the fish into the collection failed: ${JSON.stringify(done.value.err)}`);
          for (const id of t.assetIds) out.set(id, { state: 'trusted' });
        } catch (e) {
          for (const id of t.assetIds) out.set(id, { state: 'error', reason: messageOf(e).slice(0, 200) });
        }
      }),
    );
  }
  for (const id of assetIds) if (!out.has(id)) out.set(id, { state: 'error', reason: 'Not checked, try again' });
  return out;
}
