import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The desktop wallet relay's byte-level checks (src/link-tx.ts), against real transactions built
// with umi, mpl-toolbox and mpl-core: the app accepts a relayed transaction only if it is what it
// sent but for the blockhash, signed by the owner; the login only for the exact message; the link
// page's summary reads amounts and NFTs from the bytes.

const source = await readFile(new URL('../src/link-tx.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const L = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const { generateSigner, publicKey, sol, transactionBuilder, createNoopSigner } = await import('@metaplex-foundation/umi');
const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
const { mplToolbox, transferSol, transferTokens, transferTokensChecked, burnToken } = await import('@metaplex-foundation/mpl-toolbox');
const { mplCore, transferV1, burnV1 } = await import('@metaplex-foundation/mpl-core');
const { ed25519 } = await import('@noble/curves/ed25519');

const umi = createUmi('http://127.0.0.1:9').use(mplToolbox()).use(mplCore());
const verify = (sig, msg, pub) => {
  try {
    return ed25519.verify(sig, msg, pub, { zip215: false });
  } catch {
    return false;
  }
};
const owner = generateSigner(umi);
const session = generateSigner(umi);
const stranger = generateSigner(umi);
const OWNER = L.addressBytes(owner.publicKey);
const randomHash = () => L.base58Encode(ed25519.utils.randomSecretKey());
const BH1 = randomHash();
const BH2 = randomHash();

/** A transaction as the app sends it: built, every signature slot zero. */
const build = (builder, payer = owner, blockhash = BH1) =>
  umi.transactions.serialize(builder.setFeePayer(payer).setBlockhash({ blockhash, lastValidBlockHeight: 1000 }).build(umi));
const topUp = (amount = 0.05, destination = session.publicKey) => transferSol(umi, { source: owner, destination, amount: sol(amount) });

/** What the link page does: a fresh blockhash in, then the owner's wallet signs. */
function pageSign(tx, { blockhash = BH2, key = owner, message: mutate } = {}) {
  let out = blockhash ? L.withBlockhash(tx, L.base58Decode(blockhash)) : L.zeroSignatures(tx);
  const { messageOffset, parsed, message } = L.parseTransaction(out);
  const signerIndex = parsed.keys.findIndex((k, i) => i < parsed.header.numRequiredSignatures && L.bytesEqual(k, L.addressBytes(owner.publicKey)));
  const signed = mutate ? mutate(message.slice()) : message;
  out = new Uint8Array([...out.subarray(0, messageOffset), ...signed]);
  out.set(ed25519.sign(signed, key.secretKey.subarray(0, 32)), 1 + 64 * Math.max(0, signerIndex));
  return out;
}

test('parses umi transactions: signer slots, keys, blockhash, instructions', () => {
  const tx = build(topUp());
  const p = L.parseTransaction(tx);
  assert.equal(p.signatures.length, 1);
  assert.equal(p.parsed.version, 0); // umi builds v0 by default
  assert.equal(L.base58Encode(p.parsed.keys[0]), owner.publicKey.toString());
  assert.equal(L.base58Encode(p.parsed.blockhash), BH1);
  assert.equal(p.parsed.instructions.length, 1);
  assert.equal(L.base58Encode(L.base58Decode(BH1)), BH1);
  assert.deepEqual(L.fromBase64(L.toBase64(tx)), tx);
  const legacy = L.parseTransaction(build(topUp().useLegacyVersion()));
  assert.equal(legacy.parsed.version, 'legacy');
  assert.equal(L.base58Encode(legacy.parsed.blockhash), BH1);
  // v0 with a lookup table reads too.
  const lut = generateSigner(umi).publicKey;
  const v0 = umi.transactions.serialize(
    topUp().useV0().setAddressLookupTables([{ publicKey: lut, addresses: [session.publicKey] }]).setFeePayer(owner).setBlockhash({ blockhash: BH1, lastValidBlockHeight: 1 }).build(umi),
  );
  const pv = L.parseTransaction(v0);
  assert.equal(pv.parsed.version, 0);
  assert.equal(pv.parsed.lookups.length, 1);
  assert.equal(L.base58Encode(pv.parsed.lookups[0].account), lut.toString());
  assert.equal(L.summarizeTransaction(v0).usesLookupTables, true);
});

test('accepts the same transaction with a new blockhash and a valid owner signature', () => {
  const sent = build(topUp());
  const got = pageSign(sent);
  const c = L.checkRelayedTransaction(sent, got, OWNER, verify);
  assert.equal(c.blockhashChanged, true);
  assert.equal(c.blockhash, BH2);
  assert.equal(c.ownerIndex, 0);
  assert.ok(verify(c.ownerSignature, c.message, OWNER));
  // Signed as is (keepBlockhash): accepted too, and required.
  const kept = pageSign(sent, { blockhash: null });
  assert.equal(L.checkRelayedTransaction(sent, kept, OWNER, verify, { keepBlockhash: true }).blockhashChanged, false);
  assert.throws(() => L.checkRelayedTransaction(sent, got, OWNER, verify, { keepBlockhash: true }), /blockhash had to stay/);
});

test('rejects a tampered instruction, account, fee payer, extra signer or bad signature', () => {
  const sent = build(topUp());
  const off = L.parseTransaction(sent).parsed.blockhashOffset;
  const reject = (got, why) => assert.throws(() => L.checkRelayedTransaction(sent, got, OWNER, verify), (e) => e instanceof L.RelayCheckError && why.test(e.message) && typeof e.zh === 'string');

  // Another amount (the instruction's data), signed by the owner: still refused.
  reject(pageSign(build(topUp(0.06))), /changed \(more than its blockhash\)/);
  // Another destination account, signed by the owner.
  reject(pageSign(build(topUp(0.05, stranger.publicKey))), /changed/);
  // Bytes flipped after the blockhash (instruction data) or in the header, then signed.
  reject(pageSign(sent, { message: (m) => ((m[off + 40] ^= 1), m) }), /changed/);
  reject(pageSign(sent, { message: (m) => ((m[2] ^= 1), m) }), /changed|unreadable/);
  // Legacy instead of v0: same instruction, other bytes.
  reject(pageSign(build(topUp().useLegacyVersion())), /changed|unreadable/);
  // Someone else pays the fee: a different transaction with the same instruction.
  reject(pageSign(build(topUp(), session)), /fee payer|signer slots|changed/);
  // An extra signer slot: another instruction that needs a second signature.
  const extra = build(topUp().add(transferSol(umi, { source: stranger, destination: owner.publicKey, amount: sol(1) })));
  reject(pageSign(extra), /signer slots/);
  // Another instruction appended (what a wallet's own guard instruction would do).
  reject(pageSign(build(topUp().add(transferSol(umi, { source: owner, destination: stranger.publicKey, amount: sol(0.001) })))), /changed/);
  // Signed by the wrong key, or not at all.
  reject(pageSign(sent, { key: stranger }), /signature is not valid/);
  reject(L.withBlockhash(sent, L.base58Decode(BH2)), /signature is not valid/);
  // Garbage.
  reject(sent.subarray(0, 40), /unreadable/);
  assert.ok(off > 0);
  // The owner must be a signer at all.
  const notOwners = build(transferSol(umi, { source: session, destination: stranger.publicKey, amount: sol(1) }), session);
  assert.throws(() => L.checkRelayedTransaction(notOwners, notOwners, OWNER, verify), /not a signer/);
});

test('sameExceptBlockhash and withBlockhash touch only the 32 blockhash bytes', () => {
  const sent = build(topUp());
  const swapped = L.withBlockhash(sent, L.base58Decode(BH2));
  const a = L.parseTransaction(sent).message;
  const b = L.parseTransaction(swapped).message;
  assert.ok(L.sameExceptBlockhash(a, b));
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert.ok(diff > 0 && diff <= 32);
  assert.ok(!L.sameExceptBlockhash(a, b.subarray(0, b.length - 1)));
});

test('login: only the exact message, signed by the address that claims it', () => {
  const parts = { sid: 'S'.repeat(43), nonce: 'nonce_123456789012345', expiresAt: 1_700_000_300_000, origin: 'https://breathless.gotclass.xyz' };
  const text = L.loginMessage(parts);
  assert.equal(text, `breathless-desktop-login|${parts.sid}|${parts.nonce}|${parts.expiresAt}|${parts.origin}`);
  const sign = (t, key = owner) => ed25519.sign(new TextEncoder().encode(t), key.secretKey.subarray(0, 32));
  assert.equal(L.checkLogin(text, owner.publicKey.toString(), sign(text), verify), owner.publicKey.toString());
  for (const other of [
    { ...parts, sid: 'T'.repeat(43) },
    { ...parts, nonce: 'another_nonce_1234567' },
    { ...parts, expiresAt: parts.expiresAt + 1 },
    { ...parts, origin: 'https://evil.example' },
  ]) {
    assert.throws(() => L.checkLogin(text, owner.publicKey.toString(), sign(L.loginMessage(other)), verify), /login signature is not valid/);
  }
  // Signed by someone else, claimed by the owner, or the other way round.
  assert.throws(() => L.checkLogin(text, owner.publicKey.toString(), sign(text, stranger), verify), /not valid/);
  assert.throws(() => L.checkLogin(text, stranger.publicKey.toString(), sign(text), verify), /not valid/);
  assert.throws(() => L.checkLogin(text, 'nope', sign(text), verify), /malformed/);
  assert.throws(() => L.checkLogin(text, owner.publicKey.toString(), new Uint8Array(10), verify), /malformed/);
  assert.throws(() => L.loginMessage({ ...parts, origin: 'a|b' }), /Bad login message part/);
});

test('summary: a SOL transfer', () => {
  const s = L.summarizeTransaction(build(topUp()));
  assert.equal(s.feePayer, owner.publicKey.toString());
  assert.deepEqual(s.signers, [owner.publicKey.toString()]);
  assert.deepEqual(s.instructions, [{ kind: 'sol-transfer', from: owner.publicKey.toString(), to: session.publicKey.toString(), lamports: 50_000_000n }]);
  assert.equal(L.formatUnits(50_000_000n, 9), '0.05');
  assert.equal(L.formatUnits(1_000_000_000n, 9), '1');
  assert.equal(L.formatUnits(7n, 0), '7');
});

test('summary: SPL transfers and a PEARL burn', () => {
  const [src, dst, mint, acct] = [generateSigner(umi), generateSigner(umi), generateSigner(umi), generateSigner(umi)].map((k) => k.publicKey);
  const s = L.summarizeTransaction(
    build(
      transactionBuilder()
        .add(transferTokens(umi, { source: src, destination: dst, authority: owner, amount: 5n }))
        .add(transferTokensChecked(umi, { source: src, mint, destination: dst, authority: owner, amount: 1500n, decimals: 2 }))
        .add(burnToken(umi, { account: acct, mint, authority: owner, amount: 7n })),
    ),
  );
  const o = owner.publicKey.toString();
  assert.deepEqual(s.instructions, [
    { kind: 'token-transfer', program: 'Token', source: src.toString(), destination: dst.toString(), authority: o, amount: 5n },
    { kind: 'token-transfer', program: 'Token', source: src.toString(), mint: mint.toString(), destination: dst.toString(), authority: o, amount: 1500n, decimals: 2 },
    { kind: 'token-burn', program: 'Token', account: acct.toString(), mint: mint.toString(), authority: o, amount: 7n },
  ]);
});

test('summary: Core NFT transfers (a sale batch) and a burn', () => {
  const market = generateSigner(umi).publicKey;
  const collection = generateSigner(umi).publicKey;
  const assets = [generateSigner(umi), generateSigner(umi), generateSigner(umi)].map((k) => k.publicKey);
  let b = transactionBuilder();
  for (const asset of assets) b = b.add(transferV1(umi, { asset, collection, newOwner: market, payer: owner, authority: owner }));
  const s = L.summarizeTransaction(build(b));
  assert.deepEqual(
    s.instructions,
    assets.map((asset) => ({ kind: 'core-transfer', asset: asset.toString(), collection: collection.toString(), authority: owner.publicKey.toString(), newOwner: market.toString() })),
  );
  // Burned by the owner, the session key paying the fee (as burnFish does).
  const burned = L.summarizeTransaction(build(burnV1(umi, { asset: assets[0], authority: owner, payer: session }), session));
  assert.deepEqual(burned.instructions, [{ kind: 'core-burn', asset: assets[0].toString(), authority: owner.publicKey.toString() }]);
  assert.equal(burned.feePayer, session.publicKey.toString());
  assert.deepEqual(new Set(burned.signers), new Set([session.publicKey.toString(), owner.publicKey.toString()]));
});

test('summary: Anchor instructions by name, anything else as unknown', () => {
  const program = generateSigner(umi).publicKey;
  const disc = [136, 43, 33, 208, 15, 32, 65, 61];
  const ix = (data) => ({
    instruction: { programId: program, keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }], data: Uint8Array.from(data) },
    signers: [owner],
    bytesCreatedOnChain: 0,
  });
  const tx = build(transactionBuilder().add(ix([...disc, 1, 2])).add(ix([9, 9, 9])));
  const labels = { [program.toString()]: { label: 'Breathless player state', instructions: L.anchorNames({ buy_upgrade: disc }) } };
  assert.deepEqual(L.summarizeTransaction(tx, labels).instructions, [
    { kind: 'named', program: program.toString(), label: 'Breathless player state', name: 'buy_upgrade' },
    { kind: 'unknown', program: program.toString(), label: 'Breathless player state', bytes: 3 },
  ]);
  assert.deepEqual(L.summarizeTransaction(tx).instructions[0], { kind: 'unknown', program: program.toString(), bytes: 10 });
  void createNoopSigner;
  void publicKey;
});
