// PEARL market, program mode (FISH_MARKET_PROGRAM_ID is set). The fish_market
// Anchor program owns the PEARL mint and, in one `sell_fish` instruction, burns
// the fish and mints its value to the seller, enforcing config.max_value. This
// server is only the ORACLE: it vouches for a fish's value by partially signing
// that instruction. The seller pays the fees; the oracle never needs SOL.

import { createNoopSigner, publicKey, transactionBuilder } from '@metaplex-foundation/umi';
import { fetchAsset } from '@metaplex-foundation/mpl-core';
import { findAssociatedTokenPda } from '@metaplex-foundation/mpl-toolbox';
import { HttpError, appraise, parseQuoteBody } from './market-rules.mjs';
import { PROGRAMS, SEEDS, buildSellFish, decodeConfig } from './fish-market.mjs';

const SYMBOL = 'PEARL';
const CONFIG_TTL_MS = 60_000;
const utf8 = (s) => new TextEncoder().encode(s);

/** The program's PDAs. Seeds are raw bytes (umi's default string serializer would add a length prefix). */
export function fishMarketPdas(eddsa, programId) {
  const pda = (seed) => eddsa.findPda(publicKey(programId), [utf8(seed)])[0].toString();
  return { pearlMint: pda(SEEDS.pearlMint), mintAuthority: pda(SEEDS.mintAuthority), config: pda(SEEDS.config) };
}

/** One-instruction legacy tx, fee payer = seller, partially signed by the oracle (u.identity). Returns its bytes. */
export async function composeQuoteTx(u, { instruction, seller, blockhash }) {
  const tx = transactionBuilder()
    .add({
      instruction: {
        programId: publicKey(instruction.programId),
        keys: instruction.keys.map((k) => ({ ...k, pubkey: publicKey(k.pubkey) })),
        data: instruction.data,
      },
      signers: [u.identity],
      bytesCreatedOnChain: 0,
    })
    .setFeePayer(createNoopSigner(publicKey(seller)))
    .setBlockhash(blockhash)
    .useLegacyVersion()
    .build(u);
  return u.transactions.serialize(await u.identity.signTransaction(tx));
}

/** `u` is a umi whose identity is the oracle keypair, with mplCore installed. */
export function createProgramMode({ u, programId, layout, log }) {
  const oracle = u.identity.publicKey.toString();
  const { pearlMint, mintAuthority, config: configPda } = fishMarketPdas(u.eddsa, programId);

  log(`[market] mode: program (fish_market ${programId})`);
  log(`[market] oracle ${oracle}  <- config.oracle must be this key`);
  log(`[market] PEARL mint (PDA) ${pearlMint}`);

  // ---- On-chain config + the mint's token program, refreshed every minute.
  let chain = { at: 0, config: null, tokenProgram: PROGRAMS.token };
  let warned = '';
  async function chainState(maxAgeMs = CONFIG_TTL_MS) {
    if (Date.now() - chain.at < maxAgeMs) return chain;
    const [cfgAcc, mintAcc] = await u.rpc.getAccounts([publicKey(configPda), publicKey(pearlMint)]);
    let config = null;
    if (cfgAcc.exists) {
      try {
        config = decodeConfig(cfgAcc.data);
      } catch (e) {
        log(`[market] could not decode fish_market config: ${e.message}`);
      }
    }
    chain = { at: Date.now(), config, tokenProgram: mintAcc.exists ? mintAcc.owner.toString() : PROGRAMS.token };
    const problem = !config
      ? `config ${configPda} not initialized yet`
      : config.oracle !== oracle
        ? `config.oracle is ${config.oracle}, but this server's oracle is ${oracle}: quotes will fail on-chain`
        : config.pearlMint !== pearlMint
          ? `config.pearl_mint ${config.pearlMint} != PDA ${pearlMint}`
          : '';
    if (problem && problem !== warned) log(`[market] WARNING: ${problem}`);
    warned = problem;
    return chain;
  }

  async function quote(body) {
    const { assetId, seller } = parseQuoteBody(body);
    const { config, tokenProgram } = await chainState();
    if (!config) throw new HttpError(503, 'fish_market is not initialized on-chain yet');
    if (config.oracle !== oracle) throw new HttpError(503, 'This server is not the fish_market oracle');

    let asset;
    try {
      asset = await fetchAsset(u, publicKey(assetId));
    } catch {
      throw new HttpError(410, 'Fish not found: already sold (burned) or never minted');
    }
    if (asset.owner.toString() !== seller) throw new HttpError(403, 'This fish is not owned by the seller');
    const a = appraise(asset.attributes?.attributeList, { maxValue: config.maxValue });
    if (!a.ok) throw new HttpError(422, a.reason);

    const ua = asset.updateAuthority;
    const collection = ua?.type === 'Collection' && ua.address ? ua.address.toString() : null;
    const ata = findAssociatedTokenPda(u, {
      mint: publicKey(pearlMint),
      owner: publicKey(seller),
      tokenProgramId: publicKey(tokenProgram),
    })[0].toString();
    const instruction = buildSellFish({
      programId,
      layout,
      value: a.pearls,
      keys: {
        seller,
        oracle,
        config: configPda,
        asset: assetId,
        collection,
        pearl_mint: pearlMint,
        mint_authority: mintAuthority,
        seller_pearl_ata: ata,
        mpl_core_program: PROGRAMS.mplCore,
        token_program: tokenProgram,
        associated_token_program: PROGRAMS.associatedToken,
        system_program: PROGRAMS.system,
      },
    });
    const blockhash = await u.rpc.getLatestBlockhash({ commitment: 'confirmed' });
    const bytes = await composeQuoteTx(u, { instruction, seller, blockhash });
    return {
      tx: Buffer.from(bytes).toString('base64'),
      pearls: a.pearls,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    };
  }

  async function info() {
    let ready = false;
    let tokenProgram = PROGRAMS.token;
    try {
      const c = await chainState();
      tokenProgram = c.tokenProgram;
      ready = Boolean(c.config && c.config.oracle === oracle);
    } catch {}
    return {
      mode: 'program',
      symbol: SYMBOL,
      pearlMint,
      tokenProgram,
      programId,
      oracle,
      market: null,
      funded: true, // the seller pays every fee; the oracle only signs
      ready,
    };
  }

  const ready = chainState(0).catch((e) => log(`[market] could not read fish_market config: ${e.message}`));
  return { info, quote, ready };
}
