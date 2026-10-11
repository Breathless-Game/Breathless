import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createNoopSigner, generateSigner, publicKey, signerIdentity } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore } from '@metaplex-foundation/mpl-core';
import { buildMintTx } from './fish-collection.mjs';
import {
  DEFAULT_PLAYER_STATE_PROGRAM_ID,
  RECORD_CATCH_DISCRIMINATOR,
  findConfigPda,
  findProgressPda,
  fishSeedKey,
  playerStateProgramId,
  recordCatch,
  recordCatchData,
} from './player-state-ix.mjs';
import { MPL_CORE_PROGRAM } from './market-rules.mjs';

// The market's record_catch (player-state-ix.mjs) against the program's IDL, and the co-signed
// mint (fish-collection.mjs buildMintTx): Core create first, record_catch second, under 1232 bytes.
// Everything here is local: umi derives PDAs and serializes without an RPC.

const IDL = JSON.parse(readFileSync(new URL('../game/src/idl/player_state.json', import.meta.url), 'utf8'));
const idlIx = IDL.instructions.find((i) => i.name === 'record_catch');

const u = createUmi('http://127.0.0.1:1').use(mplCore());
const market = generateSigner(u);
u.use(signerIdentity(market));
const session = generateSigner(u).publicKey.toString();
const owner = generateSigner(u).publicKey.toString();
const asset = generateSigner(u).publicKey.toString();
const collection = { publicKey: generateSigner(u).publicKey, oracles: [], lifecycleHooks: [] };
const PROGRAM = publicKey(DEFAULT_PLAYER_STATE_PROGRAM_ID);
const blockhash = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 };

const u64 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(at, true);

test('record_catch matches the IDL: discriminator, account order, signer / writable flags, args', () => {
  assert.deepEqual([...RECORD_CATCH_DISCRIMINATOR], idlIx.discriminator);
  assert.deepEqual(idlIx.args.map((a) => [a.name, a.type]), [['fish', 'u64'], ['value', 'u64']]);
  const ix = recordCatch(u, { oracle: market, payer: createNoopSigner(publicKey(session)), owner, fish: 0xdeadbeefn, value: 375 }).items[0].instruction;
  assert.equal(ix.programId.toString(), DEFAULT_PLAYER_STATE_PROGRAM_ID);
  assert.deepEqual(
    ix.keys.map((k) => [!!k.isWritable, !!k.isSigner]),
    idlIx.accounts.map((a) => [!!a.writable, !!a.signer]),
  );
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toString()), [
    market.publicKey.toString(),
    session,
    findConfigPda(u, PROGRAM)[0].toString(),
    owner,
    findProgressPda(u, publicKey(owner), PROGRAM)[0].toString(),
    '11111111111111111111111111111111',
  ]);
  assert.equal(ix.data.length, 24);
  assert.equal(u64(ix.data, 8), 0xdeadbeefn);
  assert.equal(u64(ix.data, 16), 375n);
});

test('the deployed PDAs: Config at 3xrn…, and the program id comes from PLAYER_STATE_PROGRAM_ID or the devnet default', () => {
  assert.equal(findConfigPda(u, PROGRAM)[0].toString(), '3xrnDesVHmrpYZi6R52ux7FmoxaWL5ege53iFN44DtMj');
  assert.equal(playerStateProgramId({}).toString(), DEFAULT_PLAYER_STATE_PROGRAM_ID);
  assert.equal(playerStateProgramId({ PLAYER_STATE_PROGRAM_ID: '  ' }).toString(), DEFAULT_PLAYER_STATE_PROGRAM_ID);
  assert.equal(playerStateProgramId({ PLAYER_STATE_PROGRAM_ID: session }).toString(), session);
});

test('fish keys are the 8-hex seed as a u64; bad ids and values are refused', () => {
  assert.equal(fishSeedKey('00c0ffee'), 0xc0ffeen);
  assert.equal(fishSeedKey('ffffffff'), 0xffffffffn);
  for (const bad of ['', 'C0FFEE00', '00c0ffe', '00c0ffee0', 'zzzzzzzz', 12]) assert.throws(() => fishSeedKey(bad));
  assert.deepEqual([...recordCatchData(1n, 2).slice(8)], [1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
  const payer = createNoopSigner(publicKey(session));
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '5']) {
    assert.throws(() => recordCatch(u, { oracle: market, payer, owner, fish: 1n, value }), /Bad catch value/);
  }
});

/** The worst case cosignMint signs: the longest URI the market accepts (300), a numbered name. */
function mint(over = {}) {
  const uri = `https://breathless.gotclass.xyz/api/nft/meta/v2/9999/`.padEnd(300, 'x');
  return {
    owner,
    payer: session,
    asset,
    name: 'Abyssal Lanternfish Sunfish #9999',
    uri,
    fishId: '00c0ffee',
    value: 2000,
    attributeList: [
      { key: 'rarity', value: 'legendary' },
      { key: 'species', value: 'Abyssal Sunfish' },
      { key: 'depth', value: '1000' },
      { key: 'value', value: '2000' },
      { key: 'seed', value: '00c0ffee' },
    ],
    ...over,
  };
}

test('the co-signed mint: Core create, then record_catch for this owner and fish, paid by the session key', () => {
  const tx = buildMintTx(u, { m: mint(), collection, blockhash, programId: PROGRAM });
  const keys = tx.message.accounts.map(String);
  const ixs = tx.message.instructions;
  assert.equal(ixs.length, 2);
  assert.equal(keys[ixs[0].programIndex], MPL_CORE_PROGRAM, 'Core create first');
  assert.equal(keys[ixs[1].programIndex], DEFAULT_PLAYER_STATE_PROGRAM_ID, 'record_catch second');
  // No new signer: fee payer = session key, then the asset and the market.
  assert.equal(keys[0], session);
  assert.deepEqual(new Set(keys.slice(0, tx.message.header.numRequiredSignatures)), new Set([session, asset, market.publicKey.toString()]));
  const rc = ixs[1];
  assert.deepEqual([...rc.data.slice(0, 8)], idlIx.discriminator);
  assert.equal(u64(rc.data, 8), 0x00c0ffeen, 'fish = the seed key');
  assert.equal(u64(rc.data, 16), 2000n, 'value = the validated value');
  assert.deepEqual(rc.accountIndexes.map((i) => keys[i]), [
    market.publicKey.toString(),
    session,
    findConfigPda(u, PROGRAM)[0].toString(),
    owner,
    findProgressPda(u, publicKey(owner), PROGRAM)[0].toString(),
    '11111111111111111111111111111111',
  ]);
  const size = u.transactions.serialize(tx).length;
  assert.ok(size <= 1232, `worst case ${size} bytes fits in a transaction`);
});

test('a mint transaction that would not fit is refused before signing', () => {
  const long = mint({ attributeList: [...mint().attributeList, { key: 'pad', value: 'x'.repeat(400) }] });
  assert.throws(() => buildMintTx(u, { m: long, collection, blockhash, programId: PROGRAM }), (e) => e.status === 422 && /too large/.test(e.message));
});
