import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { generateSigner, keypairIdentity } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { PublicKey as Web3PublicKey } from '@solana/web3.js';
import {
  CONFIG_DISCRIMINATOR,
  DEFAULT_LAYOUT,
  PROGRAMS,
  SELL_FISH_ACCOUNTS,
  buildSellFish,
  decodeConfig,
  layoutFromIdl,
  sellFishData,
} from './fish-market.mjs';
import { composeQuoteTx, fishMarketPdas } from './market-program-mode.mjs';

const hex = (b) => Buffer.from(b).toString('hex');

// The account order agreed with the fish_market program (coordinator spec).
const SPEC_ORDER = [
  'seller',
  'oracle',
  'config',
  'asset',
  'collection',
  'pearl_mint',
  'mint_authority',
  'seller_pearl_ata',
  'mpl_core_program',
  'token_program',
  'associated_token_program',
  'system_program',
];

const u = createUmi('http://127.0.0.1:1'); // offline: nothing here touches the RPC
const addr = () => generateSigner(u).publicKey.toString();
const PROGRAM_ID = addr();
const keys = () => ({
  seller: addr(),
  oracle: addr(),
  config: addr(),
  asset: addr(),
  collection: null,
  pearl_mint: addr(),
  mint_authority: addr(),
  seller_pearl_ata: addr(),
  mpl_core_program: PROGRAMS.mplCore,
  token_program: PROGRAMS.token,
  associated_token_program: PROGRAMS.associatedToken,
  system_program: PROGRAMS.system,
});

test('sell_fish discriminator is sha256("global:sell_fish")[0..8] (pinned)', () => {
  assert.equal(hex(DEFAULT_LAYOUT.discriminator), 'cab2e51cf3cb4573');
  assert.equal(hex(CONFIG_DISCRIMINATOR), '9b0caae01efacc82'); // sha256("account:Config")[0..8]
});

test('sell_fish data is the discriminator then the value as u64 little-endian', () => {
  assert.equal(hex(sellFishData(16)), 'cab2e51cf3cb4573' + '1000000000000000');
  assert.equal(hex(sellFishData(2000n)), 'cab2e51cf3cb4573' + 'd007000000000000');
  assert.throws(() => sellFishData(0), RangeError);
  assert.throws(() => sellFishData(1n << 64n), RangeError);
});

test('sell_fish accounts follow the agreed order, signers are exactly seller + oracle', () => {
  assert.deepEqual(SELL_FISH_ACCOUNTS.map((a) => a.name), SPEC_ORDER);
  const k = keys();
  const ix = buildSellFish({ programId: PROGRAM_ID, keys: k, value: 5 });
  assert.equal(ix.programId, PROGRAM_ID);
  assert.equal(ix.keys.length, 12);
  assert.deepEqual(
    ix.keys.map((m) => m.pubkey),
    SPEC_ORDER.map((n) => (n === 'collection' ? PROGRAM_ID : k[n])),
  );
  assert.deepEqual(ix.keys.filter((m) => m.isSigner).map((m) => m.pubkey), [k.seller, k.oracle]);
  const writable = new Set(ix.keys.filter((m) => m.isWritable).map((m) => m.pubkey));
  for (const n of ['seller', 'asset', 'pearl_mint', 'seller_pearl_ata']) assert.ok(writable.has(k[n]), `${n} must be mut`);
  for (const n of ['mpl_core_program', 'token_program', 'associated_token_program', 'system_program']) {
    assert.ok(!writable.has(k[n]), `${n} must be read-only`);
  }
});

test('collection: None is the program id (read-only), Some is the collection (writable)', () => {
  const none = buildSellFish({ programId: PROGRAM_ID, keys: keys(), value: 1 }).keys[4];
  assert.deepEqual(none, { pubkey: PROGRAM_ID, isSigner: false, isWritable: false });
  const col = addr();
  const some = buildSellFish({ programId: PROGRAM_ID, keys: { ...keys(), collection: col }, value: 1 }).keys[4];
  assert.deepEqual(some, { pubkey: col, isSigner: false, isWritable: true });
  assert.throws(() => buildSellFish({ programId: PROGRAM_ID, keys: { ...keys(), asset: null }, value: 1 }), /asset/);
});

const idlAccounts030 = SPEC_ORDER.map((name) => ({
  name,
  ...(name === 'seller' ? { writable: true, signer: true } : {}),
  ...(name === 'oracle' ? { signer: true } : {}),
  ...(['asset', 'pearl_mint', 'seller_pearl_ata'].includes(name) ? { writable: true } : {}),
  ...(name === 'collection' ? { writable: true, optional: true } : {}),
}));
const idl030 = {
  address: PROGRAM_ID,
  instructions: [
    {
      name: 'sell_fish',
      discriminator: [...DEFAULT_LAYOUT.discriminator],
      accounts: idlAccounts030,
      args: [{ name: 'value', type: 'u64' }],
    },
  ],
};

test('layoutFromIdl reads an Anchor 0.30 IDL, flags and all', () => {
  const layout = layoutFromIdl(idl030);
  assert.equal(layout.address, PROGRAM_ID);
  assert.equal(hex(layout.discriminator), 'cab2e51cf3cb4573');
  assert.deepEqual(layout.accounts.map((a) => a.name), SPEC_ORDER);
  assert.equal(layout.accounts.find((a) => a.name === 'config').writable, false); // the IDL wins over our default
  const ix = buildSellFish({ programId: PROGRAM_ID, keys: keys(), value: 3, layout });
  assert.equal(ix.keys.filter((m) => m.isSigner).length, 2);
});

test('layoutFromIdl reads an Anchor 0.29 IDL (camelCase, isMut/isSigner, no discriminator)', () => {
  const camel = (s) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase());
  const idl029 = {
    instructions: [
      {
        name: 'sellFish',
        accounts: idlAccounts030.map((a) => ({ name: camel(a.name), isMut: !!a.writable, isSigner: !!a.signer })),
        args: [{ name: 'value', type: 'u64' }],
      },
    ],
    metadata: { address: PROGRAM_ID },
  };
  const layout = layoutFromIdl(idl029);
  assert.deepEqual(layout.accounts.map((a) => a.name), SPEC_ORDER);
  assert.equal(hex(layout.discriminator), 'cab2e51cf3cb4573');
  assert.equal(layout.address, PROGRAM_ID);
});

test('layoutFromIdl refuses IDLs it cannot build for', () => {
  const withAccounts = (accounts) => ({ instructions: [{ ...idl030.instructions[0], accounts }] });
  assert.throws(() => layoutFromIdl({ instructions: [] }), /no sell_fish/);
  assert.throws(() => layoutFromIdl(withAccounts([...idlAccounts030, { name: 'rent' }])), /unknown sell_fish account "rent"/);
  assert.throws(() => layoutFromIdl(withAccounts(idlAccounts030.filter((a) => a.name !== 'oracle'))), /no "oracle"/);
  assert.throws(
    () => layoutFromIdl({ instructions: [{ ...idl030.instructions[0], args: [{ name: 'value', type: 'u32' }] }] }),
    /expected one u64/,
  );
});

const IDL_FILE = new URL('../game/src/idl/fish_market.json', import.meta.url);
test('the committed fish_market IDL matches what the server builds', { skip: !existsSync(IDL_FILE) && 'no IDL yet' }, () => {
  const layout = layoutFromIdl(JSON.parse(readFileSync(IDL_FILE, 'utf8')));
  assert.deepEqual(layout.accounts.map((a) => a.name), SPEC_ORDER);
  assert.equal(hex(layout.discriminator), 'cab2e51cf3cb4573');
  assert.deepEqual(layout.accounts.filter((a) => a.signer).map((a) => a.name), ['seller', 'oracle']);
});

test('PDAs use raw seeds and match @solana/web3.js', () => {
  const pdas = fishMarketPdas(u.eddsa, PROGRAM_ID);
  const web3 = (seed) =>
    Web3PublicKey.findProgramAddressSync([Buffer.from(seed)], new Web3PublicKey(PROGRAM_ID))[0].toBase58();
  assert.deepEqual(pdas, { pearlMint: web3('pearl'), mintAuthority: web3('mint_authority'), config: web3('config') });
});

test('decodeConfig reads Config { admin, oracle, pearl_mint, max_value, bump, mint_bump }', () => {
  const [admin, oracle, mint] = [addr(), addr(), addr()];
  const data = Buffer.concat([
    Buffer.from(CONFIG_DISCRIMINATOR),
    ...[admin, oracle, mint].map((a) => Buffer.from(base58.serialize(a))),
    Buffer.from([0xd0, 0x07, 0, 0, 0, 0, 0, 0]), // 2000
    Buffer.from([254, 253]),
  ]);
  assert.deepEqual(decodeConfig(data), { admin, oracle, pearlMint: mint, maxValue: 2000n, bump: 254, mintBump: 253 });
  data[0] ^= 1;
  assert.throws(() => decodeConfig(data), /not a fish_market Config/);
});

test('a quote tx is paid by the seller, partially signed by the oracle, completed by the seller', async () => {
  const oracleUmi = createUmi('http://127.0.0.1:1');
  oracleUmi.use(keypairIdentity(oracleUmi.eddsa.generateKeypair()));
  const sellerKp = u.eddsa.generateKeypair();
  const seller = sellerKp.publicKey.toString();
  const k = { ...keys(), seller, oracle: oracleUmi.identity.publicKey.toString() };
  const instruction = buildSellFish({ programId: PROGRAM_ID, keys: k, value: 16 });
  const blockhash = { blockhash: base58.deserialize(new Uint8Array(32).fill(7))[0], lastValidBlockHeight: 100 };

  const bytes = await composeQuoteTx(oracleUmi, { instruction, seller, blockhash });
  const tx = u.transactions.deserialize(bytes); // what the browser does with the base64
  const m = tx.message;
  assert.equal(m.accounts[0], seller); // fee payer
  assert.equal(m.header.numRequiredSignatures, 2);
  assert.equal(m.instructions.length, 1);
  assert.equal(m.accounts[m.instructions[0].programIndex], PROGRAM_ID);
  assert.equal(hex(m.instructions[0].data), 'cab2e51cf3cb4573' + '1000000000000000');
  assert.deepEqual(
    m.instructions[0].accountIndexes.map((i) => m.accounts[i]),
    SPEC_ORDER.map((n) => (n === 'collection' ? PROGRAM_ID : k[n])),
  );

  const oracleIdx = m.accounts.indexOf(k.oracle);
  assert.ok(u.eddsa.verify(tx.serializedMessage, tx.signatures[oracleIdx], k.oracle), 'oracle signed');
  assert.ok(tx.signatures[0].every((b) => b === 0), 'seller slot left empty');

  const { createSignerFromKeypair } = await import('@metaplex-foundation/umi');
  const signed = await createSignerFromKeypair(u, sellerKp).signTransaction(tx);
  assert.ok(u.eddsa.verify(signed.serializedMessage, signed.signatures[0], seller), 'seller signed');
  assert.ok(u.eddsa.verify(signed.serializedMessage, signed.signatures[oracleIdx], k.oracle), 'oracle sig kept');
});
