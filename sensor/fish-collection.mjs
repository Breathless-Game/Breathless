// Server mode's fish collection: the Metaplex Core collection "Breathless Fish" whose update
// authority is the market wallet, and the two co-signed routes that are the only way into it.
//
//   POST /api/market/cosign-mint     { owner, payer, asset, name, uri, fish }
//       The game asks before minting a fish. We re-derive the fish from its seed (fish-trust.mjs),
//       build the Core create with collection = ours plus player_state record_catch (the fish's
//       value onto the owner's lifetime banked value, buildMintTx), and sign it as collection
//       authority and player_state oracle. The
//       game's session key (payer) and the new asset sign and send it, so the game wallet still
//       pays the mint; the market only signs. -> { tx (base64), lastValidBlockHeight, collection }
//   POST /api/market/cosign-migrate  { owner, payer, assetIds }
//       Fish minted before the collection (update authority = the game's session key). Each one is
//       checked like a new mint, then one transaction per few fish: the session key hands its
//       update authority to the market, and the market moves the fish into the collection. The
//       session key pays. -> { txs: [{ tx, assetIds, lastValidBlockHeight }], rejected: [{ assetId, error }] }
//
// State: the collection address and its creation slot in .market-state.json (beside the PEARL
// mint), and <dir>/.market-fish.jsonl, the (owner, fish id) -> asset registry (fish-trust.mjs
// FishRegistry), one JSON line per co-signed mint or migration. A deploy must never touch .market-*.
// Both come from the store (market-store.mjs): those files, or Redis on a serverless host.

import { createNoopSigner, generateSigner, publicKey, transactionBuilder } from '@metaplex-foundation/umi';
import { create, createCollection, fetchAsset, fetchCollection, update, updateAuthority } from '@metaplex-foundation/mpl-core';
import {
  DAILY_PEARL_CAP,
  FISH_COLLECTION_NAME,
  HttpError,
  LEGACY_GRACE_SLOTS,
  MIGRATIONS_PER_HOUR,
  MINTS_PER_HOUR,
  MINT_WINDOW_MS,
  MPL_CORE_PROGRAM,
} from './market-rules.mjs';
import {
  Quota,
  assertTrustedFish,
  capQuotes,
  checkPayoutCap,
  isLegacyEra,
  migrationProblem,
  mintLimitError,
  parseCosignMigrate,
  parseCosignMint,
  readFacts,
} from './fish-trust.mjs';
import { fishSeedKey, playerStateProgramId, recordCatch } from './player-state-ix.mjs';
import { isTransientRpcError } from './rpc-guard.mjs';
import { REGISTRY_FILE, createFileStore } from './market-store.mjs';

export { REGISTRY_FILE };
const COLLECTION_NEEDS_SOL = 0.005; // ~0.0014 SOL rent + fee, measured on a local validator
const TX_LIMIT = 1232;
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160);

/**
 * An account as umi's rpc.getAccount returns it -> 'missing' | 'live' | 'burned'. mpl-core's burn
 * keeps the address: a 1-byte account (Key::Uninitialized = 0) still owned by Core, so it can never
 * be created again (devnet: owner CoREENxT…, space 1, data 00). 'missing': no account, or one Core
 * does not own (stray lamports): no mint ever landed there. Any other Core account is 'live'.
 */
export function assetState(acct) {
  if (!acct?.exists || String(acct.owner) !== MPL_CORE_PROGRAM) return 'missing';
  return acct.data?.length && acct.data[0] !== 0 ? 'live' : 'burned';
}

/**
 * The co-signed mint: the Core create into our collection, then player_state record_catch
 * (player-state-ix.mjs), which adds the validated value to the owner's lifetime banked value
 * once per fish (the seed key). Oracle = the market (already a signer here as the collection's
 * authority), payer = the session key (already the fee payer): no new signature. A retried mint
 * of the same fish is a no-op on chain. The game's cosignedTxProblem (game/src/fish-cosign.ts)
 * accepts exactly this pair. Throws when it would not fit in one transaction.
 */
export function buildMintTx(u, { m, collection, blockhash, programId = playerStateProgramId() }) {
  const payer = createNoopSigner(publicKey(m.payer));
  const builder = create(u, {
    asset: createNoopSigner(publicKey(m.asset)),
    collection,
    owner: publicKey(m.owner),
    payer,
    authority: u.identity, // the collection's update authority: the only signature that admits a fish
    name: m.name,
    uri: m.uri,
    plugins: [{ type: 'Attributes', attributeList: m.attributeList }],
  })
    .add(recordCatch(u, { oracle: u.identity, payer, owner: m.owner, fish: fishSeedKey(m.fishId), value: m.value, programId }))
    .setFeePayer(payer)
    .setBlockhash(blockhash)
    .useLegacyVersion();
  const size = builder.getTransactionSize(u);
  if (size > TX_LIMIT) throw new HttpError(422, `This fish's mint transaction is too large (${size} > ${TX_LIMIT} bytes)`);
  return builder.build(u);
}

/**
 * Whether a pending PEARL mint / fish collection (saved, with its time `at`, right before its
 * create transaction is sent) that hasn't landed may still land, so must not be replaced yet. Its
 * sender holds the setup lock (market-server-mode.mjs) for at most waitMs = SETUP_LOCK_MS, and a
 * transaction's blockhash expires ~90 s after it is built: once the address is older than the
 * lock, its transaction landed (and was adopted before this check) or expired, so a new signer is
 * safe. The one leftover case, a sender frozen between saving and sending for longer than the
 * lock, lands a second account later, but the store never replaces a saved mint or collection
 * (write-once fields, market-store.mjs), so that one stays unused. waitMs 0 (one process): never.
 */
export function pendingIsLive(at, waitMs, now = Date.now()) {
  return waitMs > 0 && Number.isFinite(at) && now - at < waitMs;
}

/**
 * deps: u (umi, identity = market wallet, mplCore installed), state + save (the server mode's
 * persisted state object), registry (the store's FishRegistry; default: the file in `dir`),
 * setupStep(name, fn) (runs the collection's creation once across instances), pendingWaitMs (see
 * pendingIsLive; 0, one process: a pending collection that hasn't landed is replaced), ledger (SoldLedger,
 * for the payout cap), balanceSol(maxAgeMs), log.
 * opts: legacyGraceSlots, limits ({ mintsPerHour, migrationsPerHour, dailyPearls }) for tests.
 */
export function createFishCollection({
  u,
  state,
  save,
  dir,
  registry = createFileStore({ dir }).openRegistry(),
  setupStep = (_name, fn) => fn(),
  pendingWaitMs = 0,
  ledger,
  balanceSol,
  log,
  legacyGraceSlots = LEGACY_GRACE_SLOTS,
  limits = {},
  playerStateProgram = playerStateProgramId(),
}) {
  const market = u.identity.publicKey.toString();
  const mintsPerHour = limits.mintsPerHour ?? MINTS_PER_HOUR;
  const migrationsPerHour = limits.migrationsPerHour ?? MIGRATIONS_PER_HOUR;
  const capOpts = limits.dailyPearls ? { cap: limits.dailyPearls } : {};
  const mintQuota = new Quota({ limit: mintsPerHour, windowMs: MINT_WINDOW_MS });
  const migrateQuota = new Quota({ limit: migrationsPerHour, windowMs: MINT_WINDOW_MS });

  log(`[market] fish collection ${state.fishCollection ?? '(not created yet)'}`);

  // ---- The collection: created once, lazily, like the PEARL mint.
  let creating = null;
  let collectionAccount = null; // { publicKey, oracles, lifecycleHooks } for create()/update()

  function ensureCollection() {
    if (state.fishCollection) return Promise.resolve(state.fishCollection);
    creating ??= setupStep('fish collection', createFishCollectionOnce).finally(() => {
      creating = null;
    });
    return creating;
  }

  async function createFishCollectionOnce() {
    if (state.fishCollection) return state.fishCollection; // another instance made it (refreshed under the setup lock)
    // A crash between send and save leaves a pending address: adopt it if it landed.
    if (state.pendingFishCollection && (await u.rpc.accountExists(publicKey(state.pendingFishCollection)))) {
      state.fishCollection = state.pendingFishCollection;
      state.fishCollectionSlot ??= Number(await u.rpc.getSlot({ commitment: 'confirmed' }));
      delete state.pendingFishCollection;
      delete state.pendingFishCollectionAt;
      await save();
      return state.fishCollection;
    }
    // Not landed (yet): a sender that just failed to confirm, or lost the lock, may still land it.
    if (state.pendingFishCollection && pendingIsLive(state.pendingFishCollectionAt, pendingWaitMs)) {
      throw new HttpError(503, 'The fish collection is still being created, retry in a few minutes');
    }
    if ((await balanceSol(0)) < COLLECTION_NEEDS_SOL) {
      throw new HttpError(503, `The fish collection is not created yet: the market wallet ${market} needs devnet SOL`);
    }
    const signer = generateSigner(u);
    const address = signer.publicKey.toString(); // not state.pendingFishCollection: kept even if `state` is reloaded
    state.pendingFishCollection = address;
    if (pendingWaitMs) state.pendingFishCollectionAt = Date.now();
    await save();
    await createCollection(u, { collection: signer, name: FISH_COLLECTION_NAME, uri: '' }).sendAndConfirm(u);
    state.fishCollection = address;
    // Fish created before this slot (plus a grace) are "legacy" and may migrate in.
    state.fishCollectionSlot = Number(await u.rpc.getSlot({ commitment: 'confirmed' }));
    delete state.pendingFishCollection;
    delete state.pendingFishCollectionAt;
    await save(); // shared store: if another instance saved a collection first, `state` now holds that one
    if (state.fishCollection !== address) log(`[market] fish collection ${address} landed after ${state.fishCollection} was saved: left unused`);
    else log(`[market] created fish collection ${state.fishCollection} (slot ${state.fishCollectionSlot})`);
    return state.fishCollection;
  }

  async function readyCollection() {
    const address = await ensureCollection();
    if (!collectionAccount || collectionAccount.publicKey.toString() !== address) {
      collectionAccount = await fetchCollection(u, publicKey(address));
    }
    return collectionAccount;
  }

  // ---- Prices: the one trust gate plus the daily cap.

  /**
   * Quote / sell price of a fetched asset, for `seller`. Synchronous on purpose: the sale desk
   * calls it right before ledger.begin (under the seller's lock on a shared store), so two sales
   * for one seller can't both pass the cap.
   */
  function price(asset, seller) {
    const pearls = assertTrustedFish(asset, { collection: state.fishCollection });
    checkPayoutCap(ledger.records, seller, pearls, capOpts);
    return pearls;
  }

  /** /quote-batch: refuse the fish that together would go over the cap. */
  const capBatch = (seller, result) => capQuotes(ledger.records, seller, result, capOpts);

  // ---- Chain helpers.
  /**
   * The asset, or null when it does not exist or is burned (cosignMigrate then refuses it). An RPC
   * failure (429, timeout) throws instead of reading as "gone".
   */
  async function loadAsset(id) {
    try {
      return await fetchAsset(u, publicKey(id));
    } catch (e) {
      if (isTransientRpcError(e)) throw e;
      return null;
    }
  }

  /**
   * What is at an earlier co-signed asset address: 'live', 'burned' or 'missing' (assetState).
   * Any RPC failure throws: read as "missing", it would co-sign a second mint of a fish that
   * already has, or had, an NFT.
   */
  async function priorAssetState(id) {
    return assetState(await u.rpc.getAccount(publicKey(id)));
  }

  async function blockHeight() {
    return u.rpc.call('getBlockHeight', [{ commitment: 'confirmed' }]);
  }

  /** The slot of an account's oldest transaction, or null when the node has no history for it. */
  async function firstSlot(address) {
    let before;
    let oldest = null;
    for (let page = 0; page < 5; page++) {
      const sigs = await u.rpc.call('getSignaturesForAddress', [address, { limit: 1000, commitment: 'confirmed', ...(before ? { before } : {}) }]);
      if (!sigs.length) break;
      oldest = sigs[sigs.length - 1].slot;
      if (sigs.length < 1000) break;
      before = sigs[sigs.length - 1].signature;
    }
    return oldest;
  }

  /**
   * Has this owner's fish already got an asset? 'free' (never, or a co-signed tx that expired
   * unsent), 'same' (this very asset: a retry, sign again; a burned address can't be created
   * again, so that mint fails on chain), or throws 409: already-minted (the NFT exists),
   * already-burned (it existed and was sold or burned: the fish is spent for good), mint-in-flight.
   */
  async function claim(owner, fishId, asset) {
    const prior = await registry.get(owner, fishId);
    if (!prior || prior.asset === asset) return prior ? 'same' : 'free';
    const was = await priorAssetState(prior.asset);
    if (was === 'live') {
      throw new HttpError(409, `This fish is already an NFT (${prior.asset})`, { code: 'already-minted', assetId: prior.asset });
    }
    if (was === 'burned') {
      throw new HttpError(409, `This fish's NFT was already sold or burned (${prior.asset}): it can't be minted again`, {
        code: 'already-burned',
        assetId: prior.asset,
      });
    }
    if (prior.lastValid !== null && (await blockHeight()) <= prior.lastValid) {
      throw new HttpError(409, 'An earlier mint of this fish may still land: retry in a minute', { code: 'mint-in-flight', retryAfterMs: 30_000 });
    }
    return 'free';
  }

  // ---- POST /api/market/cosign-mint
  async function cosignMint(body) {
    const m = parseCosignMint(body, { market });
    const collection = await readyCollection();
    if ((await claim(m.owner, m.fishId, m.asset)) === 'free') {
      const q = mintQuota.take(m.owner);
      if (!q.ok) throw mintLimitError('Mint', mintsPerHour, q.retryAfterMs);
    }
    const blockhash = await u.rpc.getLatestBlockhash({ commitment: 'confirmed' });
    const tx = buildMintTx(u, { m, collection, blockhash, programId: playerStateProgram });
    const signed = await u.identity.signTransaction(tx);
    await registry.set(m.owner, m.fishId, { asset: m.asset, lastValid: blockhash.lastValidBlockHeight, kind: 'mint' });
    return { tx: b64(u.transactions.serialize(signed)), lastValidBlockHeight: blockhash.lastValidBlockHeight, collection: collection.publicKey.toString() };
  }

  // ---- POST /api/market/cosign-migrate
  async function cosignMigrate(body) {
    const { owner, payer, assetIds } = parseCosignMigrate(body, { market });
    const collection = await readyCollection();
    const rejected = [];
    const ok = [];
    const assets = await Promise.all(assetIds.map(loadAsset));
    for (const [i, asset] of assets.entries()) {
      const assetId = assetIds[i];
      const problem = migrationProblem(asset, { owner, payer, collection: collection.publicKey });
      if (problem) {
        rejected.push({ assetId, status: 422, error: problem });
        continue;
      }
      try {
        if (!isLegacyEra(await firstSlot(assetId), state.fishCollectionSlot ?? 0, legacyGraceSlots)) {
          rejected.push({ assetId, status: 422, error: 'Created after the market started checking fish: only fish minted by the game can be sold' });
          continue;
        }
        const fishId = readFacts(asset.attributes.attributeList).id;
        await claim(owner, fishId, assetId);
        ok.push({ assetId, asset, fishId });
      } catch (e) {
        rejected.push({ assetId, status: e instanceof HttpError ? e.status : isTransientRpcError(e) ? 503 : 500, error: short(e) });
      }
    }
    if (ok.length) {
      const priors = await Promise.all(ok.map((f) => registry.get(owner, f.fishId)));
      const fresh = ok.filter((f, i) => priors[i]?.asset !== f.assetId).length;
      const q = migrateQuota.take(owner, fresh);
      if (!q.ok) throw mintLimitError('Migration', migrationsPerHour, q.retryAfterMs);
    }

    // Pack the fish into as few transactions as fit; each fish is two Core updates.
    const sessionPayer = createNoopSigner(publicKey(payer));
    const blockhash = await u.rpc.getLatestBlockhash({ commitment: 'confirmed' });
    const start = () => transactionBuilder().setFeePayer(sessionPayer).setBlockhash(blockhash).useLegacyVersion();
    const moves = ok.map(({ assetId, asset }) => ({
      assetId,
      ix: transactionBuilder()
        // 1. The session key (its current update authority) hands it to the market...
        .add(update(u, { asset, newUpdateAuthority: updateAuthority('Address', [u.identity.publicKey]), authority: sessionPayer, payer: sessionPayer }))
        // 2. ...and the market, now its authority and the collection's, moves it into the collection.
        .add(
          update(u, {
            asset,
            newCollection: collection.publicKey,
            newUpdateAuthority: updateAuthority('Collection', [collection.publicKey]),
            authority: u.identity,
            payer: sessionPayer,
          }),
        ),
    }));
    const groups = [];
    let cur = { ids: [], b: start() };
    for (const { assetId, ix } of moves) {
      const next = cur.b.add(ix);
      if (cur.ids.length && next.getTransactionSize(u) > TX_LIMIT) {
        groups.push(cur);
        cur = { ids: [assetId], b: start().add(ix) };
      } else {
        cur = { ids: [...cur.ids, assetId], b: next };
      }
    }
    if (cur.ids.length) groups.push(cur);

    const txs = [];
    for (const g of groups) {
      const signed = await u.identity.signTransaction(g.b.build(u));
      txs.push({ tx: b64(u.transactions.serialize(signed)), assetIds: g.ids, lastValidBlockHeight: blockhash.lastValidBlockHeight });
    }
    for (const f of ok) await registry.set(owner, f.fishId, { asset: f.assetId, lastValid: blockhash.lastValidBlockHeight, kind: 'migrate' });
    return { txs, rejected };
  }

  return {
    ensureCollection,
    collection: () => state.fishCollection ?? null,
    price,
    capBatch,
    cosignMint,
    cosignMigrate,
    claim,
    limits: { mintsPerHour, migrationsPerHour, dailyPearls: limits.dailyPearls ?? DAILY_PEARL_CAP },
  };
}
