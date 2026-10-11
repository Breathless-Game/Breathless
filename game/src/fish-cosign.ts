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
  instructions: readonly { programIndex: number }[];
}

/**
 * Sign only what we asked for: the fee payer is our session key, the signers are exactly the
 * expected ones, and every instruction is a Core call. Returns why not, or null.
 */
export function cosignedTxProblem(m: MessageLike, expect: { payer: string; signers: string[]; program?: string }): string | null {
  const keys = m.accounts.map(String);
  if (keys[0] !== expect.payer) return 'its fee payer is not the game wallet';
  const signers = keys.slice(0, m.header.numRequiredSignatures);
  if (signers.length !== expect.signers.length || !expect.signers.every((s) => signers.includes(s))) return 'it asks for unexpected signatures';
  const program = expect.program ?? CORE_PROGRAM;
  if (!m.instructions.length || m.instructions.some((ix) => keys[ix.programIndex] !== program)) return 'it calls a program other than Metaplex Core';
  return null;
}

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
  const [{ generateSigner }, { base58 }] = await Promise.all([import('@metaplex-foundation/umi'), import('@metaplex-foundation/umi/serializers')]);
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
  const problem = cosignedTxProblem(tx.message, { payer, signers: [payer, asset.publicKey.toString(), String(args.info.market)] });
  if (problem) throw new Error(`The market sent an unexpected mint transaction (${problem}); not signing it`);
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
  const [{ fetchAsset }, { publicKey }] = await Promise.all([import('@metaplex-foundation/mpl-core'), import('@metaplex-foundation/umi')]);
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
          const problem = cosignedTxProblem(tx.message, { payer: ctx.session, signers: [ctx.session, String(info.market)] });
          if (problem) throw new Error(`The market sent an unexpected transaction (${problem}); not signing it`);
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
