// PEARL market, server mode (the fallback when no fish_market program is
// configured). The market wallet is the PEARL mint authority and the wallet
// sold fish go to. A sale: the player transfers the fish (a Metaplex Core
// asset) to the market and POSTs the transfer signature; we verify it on-chain,
// mint the fish's catch value in PEARL to the player, then burn the fish.
//
// State in `dir`/.market-state.json (gitignored, public data): the PEARL mint
// address and the sold set. Written via tmp + rename so a crash cannot truncate it.
// That is the file store; on a serverless host the same state lives in Redis (market-store.mjs).

import { createGenericFile, generateSigner, percentAmount, publicKey, sol, transactionBuilder } from '@metaplex-foundation/umi';
import { burn, fetchAsset, fetchAssetsByOwner, fetchCollection } from '@metaplex-foundation/mpl-core';
import { addMemo, createIdempotentAssociatedToken, findAssociatedTokenPda, mintTokensTo } from '@metaplex-foundation/mpl-toolbox';
import { createFungible } from '@metaplex-foundation/mpl-token-metadata';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { HttpError, parseQuoteBatchBody, parseQuoteBody, singleFlight } from './market-rules.mjs';
import { createBurnRetry, createSweep } from './market-burn.mjs';
import { createFishCollection, pendingIsLive } from './fish-collection.mjs';
import { createPayout } from './market-payout.mjs';
import { createSaleDesk, poll, quoteMany } from './market-sale.mjs';
import { createFileStore } from './market-store.mjs';
import { renderPearlPng } from './pearl-png.mjs';
import { isTransientRpcError, redactRpc } from './rpc-guard.mjs';

const SYMBOL = 'PEARL';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const AIRDROP_BELOW_SOL = 0.5;
const FUNDED_SOL = 0.02; // enough for a handful of sales (ATA rent ~0.002 + fees)
const MINT_NEEDS_SOL = 0.02; // mint + metadata accounts + Irys upload
const FAUCET = 'https://faucet.solana.com';
// A payout or burn may reuse a blockhash this young: every such transaction is unique anyway (the
// payout's memo names the fish, a burn names its asset), and ~60 s of validity is left.
const BLOCKHASH_REUSE_MS = 10_000;
const COLLECTION_TTL_MS = 60_000;
// Creating the PEARL mint or the fish collection (Irys upload, send, confirm) holds this lock across
// instances (Redis store) for at most this long; one process needs no lock.
const SETUP_LOCK_MS = 4 * 60_000;
/** ONE lock for every setup step: creating the mint and the collection each save the shared state. */
export const SETUP_LOCK = 'setup';

/**
 * setupStep(name, fn): one setup step at a time across instances (and within one), on the newest
 * state: refresh() runs only here, under the lock, so it never races a save of this instance.
 * `name` only words the 503. One process (file store): just run it, as always.
 */
export function createSetupStep({ store, refresh, shared, lockMs = SETUP_LOCK_MS }) {
  if (!shared) return (_name, fn) => fn();
  return async (name, fn) => {
    const release = await store.lock(SETUP_LOCK, lockMs);
    if (!release) throw new HttpError(503, `The market is being set up (${name} waits for another step), retry in a minute`);
    try {
      await refresh();
      return await fn();
    } finally {
      await Promise.resolve(release()).catch(() => {});
    }
  };
}

const sigStr = (bytes) => base58.deserialize(bytes)[0];
const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160);

/**
 * `u` is a umi whose identity is the market keypair, with mplCore, mplToolbox and mplTokenMetadata installed.
 * `store` (market-store.mjs) defaults to the file store in `dir`. `background: false` (a serverless
 * host) runs no timers and no start-up work: no airdrop, no sweep on start or every 10 minutes, no
 * in-memory burn retries; the host calls sweep() itself. `batchDeadlineMs`: see createSaleDesk.
 */
export async function createServerMode({ u, rpc, dir, log, fishOptions = {}, store, background = true, batchDeadlineMs }) {
  const marketKey = u.identity.publicKey.toString();
  store ??= createFileStore({ dir });
  const { state, ledger, save, refresh, adopt } = await store.openMarketState({ cluster: redactRpc(rpc) });
  const shared = store.kind !== 'file'; // other instances write the same state
  const setupStep = createSetupStep({ store, refresh, shared });
  // A pending mint / collection younger than this may still land (see pendingIsLive); one process: none.
  const pendingWaitMs = shared ? SETUP_LOCK_MS : 0;

  log(`[market] mode: server (PEARL minted by the market wallet; set FISH_MARKET_PROGRAM_ID for program mode)`);
  log(`[market] market wallet ${marketKey}  (${redactRpc(rpc)})`);
  log(`[market] PEARL mint ${state.mint ?? '(not created yet)'}`);

  // ---- SOL balance (cached briefly) and the one start-up airdrop.
  let balance = { sol: 0, at: 0 };
  async function balanceSol(maxAgeMs = 15_000) {
    if (Date.now() - balance.at > maxAgeMs) {
      const b = await u.rpc.getBalance(u.identity.publicKey);
      balance = { sol: Number(b.basisPoints) / 1e9, at: Date.now() };
    }
    return balance.sol;
  }

  async function topUp() {
    try {
      const have = await balanceSol(0);
      if (have >= AIRDROP_BELOW_SOL) return;
      log(`[market] balance ${have} SOL, requesting a devnet airdrop...`);
      await u.rpc.airdrop(u.identity.publicKey, sol(1), { commitment: 'confirmed' });
      log(`[market] airdrop ok, balance ${await balanceSol(0)} SOL`);
    } catch (e) {
      log(`[market] airdrop failed (${short(e).slice(0, 120)})`);
      log(`[market] fund the market wallet by hand: ${FAUCET}  ->  ${marketKey}`);
    }
  }

  // ---- PEARL mint: created lazily once the wallet can pay for it.
  let minting = null;
  function ensureMint() {
    if (state.mint) return Promise.resolve(state.mint);
    minting ??= setupStep('PEARL mint', createPearlMint).finally(() => {
      minting = null;
    });
    return minting;
  }

  async function createPearlMint() {
    if (state.mint) return state.mint; // another instance made it (refreshed under the setup lock)
    // A crash between send and save leaves a pending mint address: adopt it if it landed.
    if (state.pendingMint && (await u.rpc.accountExists(publicKey(state.pendingMint)))) {
      state.mint = state.pendingMint;
      delete state.pendingMint;
      delete state.pendingMintAt;
      await save();
      return state.mint;
    }
    // Not landed (yet): a sender that just failed to confirm, or lost the lock, may still land it.
    if (state.pendingMint && pendingIsLive(state.pendingMintAt, pendingWaitMs)) {
      throw new HttpError(503, 'The PEARL mint is still being created, retry in a few minutes');
    }
    if ((await balanceSol(0)) < MINT_NEEDS_SOL) {
      throw new HttpError(503, `PEARL market is not funded yet. Send devnet SOL to ${marketKey} (${FAUCET})`);
    }
    const uri = await uploadMetadata();
    const mint = generateSigner(u);
    const address = mint.publicKey.toString(); // not state.pendingMint: kept even if `state` is reloaded
    state.pendingMint = address;
    if (pendingWaitMs) state.pendingMintAt = Date.now();
    await save();
    await createFungible(u, {
      mint,
      name: 'Pearl',
      symbol: SYMBOL,
      uri,
      sellerFeeBasisPoints: percentAmount(0),
      decimals: 0,
    }).sendAndConfirm(u);
    state.mint = address;
    delete state.pendingMint;
    delete state.pendingMintAt;
    await save(); // shared store: if another instance saved a mint first, `state.mint` is now that one
    if (state.mint !== address) log(`[market] PEARL mint ${address} landed after ${state.mint} was saved: left unused`);
    else log(`[market] created PEARL mint ${state.mint}`);
    return state.mint;
  }

  async function uploadMetadata() {
    try {
      const { irysUploader } = await import('@metaplex-foundation/umi-uploader-irys');
      u.use(irysUploader({ timeout: 60_000 }));
      const png = createGenericFile(renderPearlPng(256), 'pearl.png', { contentType: 'image/png' });
      const [image] = await u.uploader.upload([png]);
      return await u.uploader.uploadJson({
        name: 'Pearl',
        symbol: SYMBOL,
        description: 'The currency of Breathless. Earned by selling fish caught on a single held breath.',
        image,
        properties: { category: 'image', files: [{ uri: image, type: 'image/png' }] },
      });
    } catch (e) {
      log(`[market] metadata upload failed, creating PEARL without an image (${short(e).slice(0, 120)})`);
      return '';
    }
  }

  // ---- Chain helpers.
  /** The asset, or null when it does not exist (burned, never minted). An RPC failure (429, timeout) throws instead. */
  async function loadAsset(assetId) {
    try {
      return await fetchAsset(u, publicKey(assetId));
    } catch (e) {
      if (isTransientRpcError(e)) throw e;
      return null;
    }
  }

  // The fish collection account, which every burn names: fetched once a minute, not once per fish.
  const collections = new Map(); // address -> { at, value }
  const collectionFlights = new Map();
  async function collectionOf(asset) {
    const ua = asset.updateAuthority;
    if (ua?.type !== 'Collection' || !ua.address) return undefined;
    const key = ua.address.toString();
    const hit = collections.get(key);
    if (hit && Date.now() - hit.at < COLLECTION_TTL_MS) return hit.value;
    return singleFlight(collectionFlights, key, async () => {
      const value = await fetchCollection(u, ua.address);
      collections.set(key, { at: Date.now(), value });
      return value;
    });
  }

  // One recent blockhash shared by the payouts and burns of a bulk sale (see BLOCKHASH_REUSE_MS).
  let recentBlockhash = { at: 0, value: null };
  const blockhashFlights = new Map();
  function freshBlockhash() {
    if (recentBlockhash.value && Date.now() - recentBlockhash.at < BLOCKHASH_REUSE_MS) return Promise.resolve(recentBlockhash.value);
    return singleFlight(blockhashFlights, 'confirmed', async () => {
      const value = await u.rpc.getLatestBlockhash({ commitment: 'confirmed' });
      recentBlockhash = { at: Date.now(), value };
      return value;
    });
  }

  // The fish collection, the co-signed mint / migration routes and the one price gate (fish-collection.mjs).
  const fish = createFishCollection({ u, state, save, registry: await store.openRegistry(), setupStep, pendingWaitMs, ledger, balanceSol, log, ...fishOptions });

  /** Price check before the player hands the fish over, so the market never holds a fish it refuses. */
  async function quote(body) {
    const { assetId, seller } = parseQuoteBody(body);
    const asset = await loadAsset(assetId);
    if (!asset) throw new HttpError(410, 'Fish not found: already sold (burned) or never minted');
    if (asset.owner.toString() !== seller && asset.owner.toString() !== marketKey) {
      throw new HttpError(403, 'This fish is not owned by the seller');
    }
    if (ledger.loadSeller) await ledger.loadSeller(seller); // Redis: this seller's last 24 h, for the cap
    return { pearls: fish.price(asset, seller) }; // only collection fish the generator agrees with; daily cap
  }

  /** POST /quote-batch: the same check for several fish at once. */
  async function quoteBatch(body) {
    const req = parseQuoteBatchBody(body);
    const quoted = await quoteMany(req, quote);
    if (ledger.loadSeller) await ledger.loadSeller(req.seller);
    return fish.capBatch(req.seller, quoted);
  }

  /**
   * The PEARL payout for one fish: mint `pearls` to the seller's ATA (created if missing, market pays).
   * The memo names the fish: it makes every pay transaction unique, so two fish of the same value sold to the
   * same seller in the same blockhash window can never produce one identical transaction (one signature, one payment).
   * The signature and expiry are persisted before sending; an uncertain send is settled by resolvePending
   * (market-payout.mjs), so a timeout never leads to a second payment.
   */
  const payout = createPayout({
    ledger,
    async build(assetId, mint, seller, pearls) {
      const ata = findAssociatedTokenPda(u, { mint: publicKey(mint), owner: publicKey(seller) });
      const blockhash = await freshBlockhash();
      const tx = await transactionBuilder()
        .add(createIdempotentAssociatedToken(u, { ata, mint: publicKey(mint), owner: publicKey(seller) }))
        .add(mintTokensTo(u, { mint: publicKey(mint), token: ata, amount: BigInt(pearls) }))
        .add(addMemo(u, { memo: `PEARL for fish ${assetId}` }))
        .setBlockhash(blockhash)
        .buildAndSign(u);
      return { tx, blockhash, sig: sigStr(tx.signatures[0]), lastValid: blockhash.lastValidBlockHeight };
    },
    send: ({ tx }) => u.rpc.sendTransaction(tx, { preflightCommitment: 'confirmed' }),
    confirm: async ({ tx, blockhash }) =>
      (await u.rpc.confirmTransaction(tx.signatures[0], { strategy: { type: 'blockhash', ...blockhash }, commitment: 'confirmed' })).value.err,
    getSignatureStatus: async (sig) => (await u.rpc.getSignatureStatuses([base58.serialize(sig)], { searchTransactionHistory: true }))[0],
    getBlockHeight: () => u.rpc.call('getBlockHeight', [{ commitment: 'finalized' }]),
  });

  /**
   * Burn one sold fish and record it. Throws when the burn did not land (RPC error, expiry, an
   * on-chain error). Only a fish the market owns is burned; one that is gone already counts as burned.
   * Concurrent calls for one fish (a sale retry, the retry queue, the sweep) share one attempt.
   */
  const burnFlights = new Map();
  function burnOnce(assetId) {
    return singleFlight(burnFlights, assetId, async () => {
      const asset = await loadAsset(assetId); // throws on an RPC error: "not found" must really mean gone
      if (!asset) {
        const r = await ledger.get(assetId);
        if (r) await ledger.burned(assetId, r.burnTx ?? '');
        return '';
      }
      if (asset.owner.toString() !== marketKey) throw new Error(`the market does not own ${assetId}`);
      const builder = burn(u, { asset, collection: await collectionOf(asset) }).setBlockhash(await freshBlockhash());
      const { signature, result } = await builder.sendAndConfirm(u);
      if (result?.value?.err) throw new Error(`burn transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
      const sig = sigStr(signature);
      if (await ledger.get(assetId)) await ledger.burned(assetId, sig);
      return sig;
    });
  }

  // A failed burn is retried in memory with backoff; the sweep (start-up + every 10 min) catches the rest.
  // A serverless instance may be frozen once it has answered, so its timers can't be trusted: there the sweep alone catches up.
  const burnRetry = background ? createBurnRetry({ burnOnce, log }) : { retry() {} };
  const sweep = createSweep({
    listOwned: () => fetchAssetsByOwner(u, u.identity.publicKey, { skipDerivePlugins: true }),
    collection: () => state.fishCollection ?? null,
    market: marketKey,
    ledger,
    burnOnce,
    log,
  });

  /** The sale desk's burn: best effort, never throws. The player is already paid either way. */
  async function burnSold(assetId) {
    try {
      await burnOnce(assetId);
    } catch (e) {
      log(`[market] burn of ${assetId} failed, retrying later: ${short(e)}`);
      burnRetry.retry(assetId);
    }
  }

  // Every fish is verified, paid and burned on its own, under a lock on its id (market-sale.mjs).
  const desk = createSaleDesk({
    ledger,
    market: marketKey,
    ensureMint,
    fetchTransfer: (sig) =>
      poll(
        () => u.rpc.getTransaction(base58.serialize(sig), { commitment: 'confirmed' }),
        (t) => t !== null,
      ),
    loadMarketAsset: (assetId) =>
      poll(
        () => loadAsset(assetId),
        (a) => a?.owner?.toString() === marketKey,
      ),
    priceFish: fish.price,
    resolvePending: payout.resolvePending,
    pay: payout.pay,
    burnSold,
    log,
    batchDeadlineMs,
  });

  async function info() {
    // Another instance may have created the mint or the collection since this one loaded the state.
    if (shared && (!state.mint || !state.fishCollection)) await adopt(); // read only: a setup step may be saving
    let funded = false;
    try {
      funded = (await balanceSol()) >= FUNDED_SOL;
    } catch {}
    if (!state.mint && funded) ensureMint().catch((e) => log(`[market] PEARL mint not created: ${e.message}`));
    if (!fish.collection() && funded) fish.ensureCollection().catch((e) => log(`[market] fish collection not created: ${e.message}`));
    return {
      mode: 'server',
      symbol: SYMBOL,
      pearlMint: state.mint ?? null,
      tokenProgram: TOKEN_PROGRAM,
      market: marketKey,
      programId: null,
      oracle: null,
      funded,
      // POST /quote-batch and /sell-batch exist: a client sells many fish with one transfer and two requests.
      batch: true,
      // Fish are minted through POST /cosign-mint into this collection; only its fish sell.
      fishCollection: fish.collection(),
      cosign: true,
      limits: fish.limits,
    };
  }

  // Start-up: top up and create the mint in the background so the server can listen at once.
  const ready = !background ? Promise.resolve() : (async () => {
    await topUp();
    try {
      await ensureMint();
    } catch (e) {
      log(`[market] PEARL mint not created yet: ${e.message}`);
    }
    try {
      await fish.ensureCollection();
    } catch (e) {
      log(`[market] fish collection not created yet: ${e.message}`);
    }
    // Finish burns a crash or RPC hiccup left behind: the paid fish the market wallet still holds.
    await sweep.run();
  })();
  if (background) sweep.start();

  return {
    info,
    quote,
    quoteBatch,
    sell: desk.sell,
    sellBatch: desk.sellBatch,
    cosignMint: fish.cosignMint,
    cosignMigrate: fish.cosignMigrate,
    ready,
    sweep: sweep.run,
  };
}
