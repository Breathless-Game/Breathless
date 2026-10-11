// PEARL market, server mode (the fallback when no fish_market program is
// configured). The market wallet is the PEARL mint authority and the wallet
// sold fish go to. A sale: the player transfers the fish (a Metaplex Core
// asset) to the market and POSTs the transfer signature; we verify it on-chain,
// mint the fish's catch value in PEARL to the player, then burn the fish.
//
// State in `dir`/.market-state.json (gitignored, public data): the PEARL mint
// address and the sold set. Written via tmp + rename so a crash cannot truncate it.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createGenericFile, generateSigner, percentAmount, publicKey, sol, transactionBuilder } from '@metaplex-foundation/umi';
import { burn, fetchAsset, fetchCollection } from '@metaplex-foundation/mpl-core';
import { addMemo, createIdempotentAssociatedToken, findAssociatedTokenPda, mintTokensTo } from '@metaplex-foundation/mpl-toolbox';
import { createFungible } from '@metaplex-foundation/mpl-token-metadata';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { HttpError, SoldLedger, appraise, parseQuoteBatchBody, parseQuoteBody } from './market-rules.mjs';
import { createSaleDesk, quoteMany } from './market-sale.mjs';
import { renderPearlPng } from './pearl-png.mjs';

const SYMBOL = 'PEARL';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const AIRDROP_BELOW_SOL = 0.5;
const FUNDED_SOL = 0.02; // enough for a handful of sales (ATA rent ~0.002 + fees)
const MINT_NEEDS_SOL = 0.02; // mint + metadata accounts + Irys upload
const FAUCET = 'https://faucet.solana.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sigStr = (bytes) => base58.deserialize(bytes)[0];
const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160);

async function poll(fn, ok, tries = 6, gapMs = 1000) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (ok(last)) return last;
    if (i < tries - 1) await sleep(gapMs);
  }
  return last;
}

/** `u` is a umi whose identity is the market keypair, with mplCore, mplToolbox and mplTokenMetadata installed. */
export function createServerMode({ u, rpc, dir, log }) {
  const marketKey = u.identity.publicKey.toString();
  const statePath = path.join(dir, '.market-state.json');

  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { cluster: rpc, mint: null, sold: {} };
  state.sold ??= {};
  const save = () => {
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...state, sold: ledger.toJSON() }, null, 2));
    renameSync(tmp, statePath);
  };
  const ledger = new SoldLedger(state.sold, save);

  log(`[market] mode: server (PEARL minted by the market wallet; set FISH_MARKET_PROGRAM_ID for program mode)`);
  log(`[market] market wallet ${marketKey}  (${rpc})`);
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
    minting ??= createPearlMint().finally(() => {
      minting = null;
    });
    return minting;
  }

  async function createPearlMint() {
    // A crash between send and save leaves a pending mint address: adopt it if it landed.
    if (state.pendingMint && (await u.rpc.accountExists(publicKey(state.pendingMint)))) {
      state.mint = state.pendingMint;
      delete state.pendingMint;
      save();
      return state.mint;
    }
    if ((await balanceSol(0)) < MINT_NEEDS_SOL) {
      throw new HttpError(503, `PEARL market is not funded yet. Send devnet SOL to ${marketKey} (${FAUCET})`);
    }
    const uri = await uploadMetadata();
    const mint = generateSigner(u);
    state.pendingMint = mint.publicKey.toString();
    save();
    await createFungible(u, {
      mint,
      name: 'Pearl',
      symbol: SYMBOL,
      uri,
      sellerFeeBasisPoints: percentAmount(0),
      decimals: 0,
    }).sendAndConfirm(u);
    state.mint = state.pendingMint;
    delete state.pendingMint;
    save();
    log(`[market] created PEARL mint ${state.mint}`);
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
  async function loadAsset(assetId) {
    try {
      return await fetchAsset(u, publicKey(assetId));
    } catch {
      return null;
    }
  }

  async function collectionOf(asset) {
    const ua = asset.updateAuthority;
    return ua?.type === 'Collection' && ua.address ? fetchCollection(u, ua.address) : undefined;
  }

  /** Price check before the player hands the fish over, so the market never holds a fish it refuses. */
  async function quote(body) {
    const { assetId, seller } = parseQuoteBody(body);
    const asset = await loadAsset(assetId);
    if (!asset) throw new HttpError(410, 'Fish not found: already sold (burned) or never minted');
    if (asset.owner.toString() !== seller && asset.owner.toString() !== marketKey) {
      throw new HttpError(403, 'This fish is not owned by the seller');
    }
    const a = appraise(asset.attributes?.attributeList);
    if (!a.ok) throw new HttpError(422, a.reason);
    return { pearls: a.pearls };
  }

  /** POST /quote-batch: the same check for several fish at once. */
  function quoteBatch(body) {
    return quoteMany(parseQuoteBatchBody(body), quote);
  }

  /**
   * Mint `pearls` to the seller's ATA (created if missing, market pays). The signature is persisted before sending.
   * The memo names the fish: it makes every pay transaction unique, so two fish of the same value sold to the
   * same seller in the same blockhash window can never produce one identical transaction (one signature, one payment).
   */
  async function pay(assetId, mint, seller, pearls) {
    const ata = findAssociatedTokenPda(u, { mint: publicKey(mint), owner: publicKey(seller) });
    const blockhash = await u.rpc.getLatestBlockhash({ commitment: 'confirmed' });
    const builder = transactionBuilder()
      .add(createIdempotentAssociatedToken(u, { ata, mint: publicKey(mint), owner: publicKey(seller) }))
      .add(mintTokensTo(u, { mint: publicKey(mint), token: ata, amount: BigInt(pearls) }))
      .add(addMemo(u, { memo: `PEARL for fish ${assetId}` }))
      .setBlockhash(blockhash);
    const tx = await builder.buildAndSign(u);
    ledger.payPending(assetId, sigStr(tx.signatures[0]), blockhash.lastValidBlockHeight);
    try {
      await u.rpc.sendTransaction(tx, { preflightCommitment: 'confirmed' });
    } catch (e) {
      ledger.payDropped(assetId); // rejected in preflight: never submitted
      throw e;
    }
    const res = await builder.confirm(u, tx.signatures[0], { commitment: 'confirmed' });
    if (res.value.err) {
      ledger.payDropped(assetId);
      throw new Error('PEARL mint transaction failed');
    }
    ledger.paid(assetId);
  }

  /** A record stuck in `paying` (crash or timeout): find out whether its pay tx landed. */
  async function resolvePending(assetId) {
    const r = ledger.get(assetId);
    if (!r.payTx) return 'unpaid';
    const [status] = await u.rpc.getSignatureStatuses([base58.serialize(r.payTx)], { searchTransactionHistory: true });
    if (status && !status.error) {
      ledger.paid(assetId);
      return 'paid';
    }
    if (status?.error) {
      ledger.payDropped(assetId);
      return 'unpaid';
    }
    const height = await u.rpc.call('getBlockHeight', [{ commitment: 'confirmed' }]);
    if (height > r.payLastValid) {
      ledger.payDropped(assetId); // expired: it can never land now
      return 'unpaid';
    }
    return 'in-flight';
  }

  async function burnSold(assetId) {
    try {
      const asset = await loadAsset(assetId);
      if (!asset) {
        ledger.burned(assetId, ledger.get(assetId).burnTx ?? '');
        return;
      }
      const { signature } = await burn(u, { asset, collection: await collectionOf(asset) }).sendAndConfirm(u);
      ledger.burned(assetId, sigStr(signature));
    } catch (e) {
      // The player is already paid; a later retry of the same sale finishes the burn.
      log(`[market] burn of ${assetId} failed: ${short(e)}`);
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
    resolvePending,
    pay,
    burnSold,
    log,
  });

  async function info() {
    let funded = false;
    try {
      funded = (await balanceSol()) >= FUNDED_SOL;
    } catch {}
    if (!state.mint && funded) ensureMint().catch((e) => log(`[market] PEARL mint not created: ${e.message}`));
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
    };
  }

  // Start-up: top up and create the mint in the background so the server can listen at once.
  const ready = (async () => {
    await topUp();
    try {
      await ensureMint();
    } catch (e) {
      log(`[market] PEARL mint not created yet: ${e.message}`);
    }
    // Finish burns a crash or RPC hiccup left behind.
    for (const [id, r] of Object.entries(ledger.records)) if (r.status === 'paid') await burnSold(id);
  })();

  return { info, quote, quoteBatch, sell: desk.sell, sellBatch: desk.sellBatch, ready };
}
