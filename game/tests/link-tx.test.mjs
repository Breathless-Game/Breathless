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
const { mplToolbox, transferSol, transferTokens, transferTokensChecked, burnToken, setComputeUnitLimit, setComputeUnitPrice, requestHeapFrame, addMemo } = await import(
  '@metaplex-foundation/mpl-toolbox'
);
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
  reject(pageSign(build(topUp(0.06))), /the wallet changed the data of instruction 1 \(program 1{32}\)/);
  // Another destination account, signed by the owner.
  reject(pageSign(build(topUp(0.05, stranger.publicKey))), /made account \S+ writable/);
  // Bytes flipped after the blockhash (instruction data) or in the header, then signed.
  reject(pageSign(sent, { message: (m) => ((m[off + 40] ^= 1), m) }), /changed/);
  reject(pageSign(sent, { message: (m) => ((m[2] ^= 1), m) }), /changed|read-only|writable|unreadable/);
  // Legacy instead of v0: same instruction, other bytes.
  reject(pageSign(build(topUp().useLegacyVersion())), /changed|unreadable/);
  // Someone else pays the fee: a different transaction with the same instruction.
  reject(pageSign(build(topUp(), session)), /fee payer|signer slots/);
  // An extra signer slot: another instruction that needs a second signature.
  const extra = build(topUp().add(transferSol(umi, { source: stranger, destination: owner.publicKey, amount: sol(1) })));
  reject(pageSign(extra), /signer slots/);
  // Another instruction appended (what a wallet's own guard instruction would do).
  reject(pageSign(build(topUp().add(transferSol(umi, { source: owner, destination: stranger.publicKey, amount: sol(0.001) })))), /added an instruction for program 1111/);
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

// ---- What a wallet may change while signing (Phantom's priority fee) ----------------------

const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPtRJWCRfYXJGiAB4AfPfGJ';
/** ComputeBudget instructions, as a wallet puts them in front. */
function budget({ units, microLamports } = {}) {
  let b = transactionBuilder();
  if (units !== undefined) b = b.add(setComputeUnitLimit(umi, { units }));
  if (microLamports !== undefined) b = b.add(setComputeUnitPrice(umi, { microLamports }));
  return b;
}
const fee = () => budget({ units: 300_000, microLamports: 100_000 });
/** What the wallet hands back: `builder` compiled anew with the page's blockhash, signed by the owner. */
const walletSigned = (builder, payer = owner) => pageSign(build(builder, payer, BH2), { blockhash: null });
const accept = (sent, got, opts) => L.checkRelayedTransaction(sent, got, OWNER, verify, opts);
const refuse = (sent, got, why, opts) =>
  assert.throws(() => accept(sent, got, opts), (e) => e instanceof L.RelayCheckError && why.test(e.message) && /\p{Script=Han}/u.test(e.zh), String(why));
const two = (a, b) => transactionBuilder().add(a).add(b);
const memo = (text = 'breathless') => addMemo(umi, { memo: text });
const ix = (programId, keys, data = new Uint8Array([1])) => ({ instruction: { programId: publicKey(programId), keys, data }, signers: [], bytesCreatedOnChain: 0 });

test("a wallet's priority fee is accepted, and the app gets the message the owner signed", () => {
  const sent = build(topUp());
  for (const [what, b] of [
    ['limit and price', fee()],
    ['price only', budget({ microLamports: 50_000 })],
    ['limit only', budget({ units: 1_000 })],
    ['exactly 0.001 SOL', budget({ units: 200_000, microLamports: 5_000_000 })],
  ]) {
    const got = walletSigned(b.add(topUp()));
    const c = accept(sent, got);
    assert.equal(c.edited, true, what);
    assert.equal(c.blockhashChanged, true, what);
    assert.deepEqual(c.message, L.parseTransaction(got).message, what);
    assert.ok(verify(c.ownerSignature, c.message, OWNER), what);
  }
  // Legacy too.
  assert.equal(accept(build(topUp().useLegacyVersion()), walletSigned(fee().add(topUp()).useLegacyVersion())).edited, true);
  // The relay's own budget, changed or dropped by the wallet.
  const relayed = L.withComputeBudget(sent);
  assert.equal(accept(relayed, walletSigned(budget({ units: 250_000, microLamports: 200_000 }).add(topUp()))).edited, true);
  assert.equal(accept(relayed, walletSigned(topUp())).edited, true);
  // Unchanged is no edit.
  assert.equal(accept(relayed, pageSign(relayed)).edited, false);
  // The link page applies the same rule to the message bytes, with its own blockhash kept.
  const page = L.parseTransaction(L.withBlockhash(sent, L.base58Decode(BH2))).message;
  const back = L.parseTransaction(walletSigned(fee().add(topUp()))).message;
  assert.deepEqual(L.checkWalletEdits(page, back, { keepBlockhash: true }), { blockhashChanged: false, edited: true });
  assert.throws(() => L.checkWalletEdits(L.parseTransaction(sent).message, back, { keepBlockhash: true }), /blockhash had to stay/);
});

test('a priority fee above 0.001 SOL is refused', () => {
  const sent = build(topUp());
  refuse(sent, walletSigned(budget({ units: 200_000, microLamports: 5_000_001 }).add(topUp())), /priority fee of 0\.001000001 SOL, above the 0\.001 SOL limit/);
  // No limit: the runtime's default (200k units for the one instruction) is what it costs.
  refuse(sent, walletSigned(budget({ microLamports: 10_000_000 }).add(topUp())), /priority fee of 0\.002 SOL/);
  refuse(L.withComputeBudget(sent), walletSigned(budget({ units: 1_400_000, microLamports: 1_000_000 }).add(topUp())), /priority fee of 0\.0014 SOL/);
});

test('anything else a wallet changes is refused, saying what', () => {
  const sent = build(topUp());
  // A transfer of its own.
  refuse(sent, walletSigned(fee().add(topUp()).add(transferSol(umi, { source: owner, destination: stranger.publicKey, amount: sol(0.001) }))), /added an instruction for program 1111/);
  // A Lighthouse assertion (not known to happen on signTransaction): refused, naming its program.
  const assertion = ix(LIGHTHOUSE, [{ pubkey: session.publicKey, isSigner: false, isWritable: false }]);
  refuse(sent, walletSigned(fee().add(topUp()).add(assertion)), new RegExp(`added an instruction for program ${LIGHTHOUSE}`));
  // Other data (the amount), another destination (a new writable account).
  refuse(sent, walletSigned(fee().add(topUp(0.5))), /changed the data of instruction 1 \(program 1{32}\)/);
  refuse(sent, walletSigned(fee().add(topUp(0.05, stranger.publicKey))), /made account \S+ writable/);
  // A read-only account made writable.
  const touch = (isWritable) => ix(L.MEMO_PROGRAM, [{ pubkey: stranger.publicKey, isSigner: false, isWritable }]);
  refuse(build(two(topUp(), touch(false))), walletSigned(fee().add(two(topUp(), touch(true)))), /made account \S+ writable/);
  // A new signer.
  const signerToo = fee().add(topUp()).add(transferSol(umi, { source: stranger, destination: owner.publicKey, amount: sol(1) }));
  refuse(sent, walletSigned(signerToo), /signer slots/);
  assert.throws(() => L.checkWalletEdits(L.parseTransaction(sent).message, L.parseTransaction(walletSigned(signerToo)).message), /changed the signers/);
  // The original instructions reordered, or one dropped.
  const both = build(two(topUp(), memo()));
  refuse(both, walletSigned(fee().add(two(memo(), topUp()))), /made instruction 1 call program Memo\S+, not 1{32} \(added, dropped or reordered\)/);
  refuse(both, walletSigned(fee().add(topUp())), /dropped the instruction for program Memo/);
  // Another fee payer, the same two signers.
  const pair = () => two(topUp(), transferSol(umi, { source: session, destination: owner.publicKey, amount: sol(0.01) }));
  refuse(build(pair()), walletSigned(fee().add(pair()), session), /changed the fee payer/);
  // A compute budget other than a limit and a price (a heap frame), or a second price.
  refuse(sent, walletSigned(fee().add(requestHeapFrame(umi, { bytes: 64 * 1024 })).add(topUp())), /program ComputeBudget111/);
  refuse(sent, walletSigned(fee().add(budget({ microLamports: 1 })).add(topUp())), /compute budget twice/);
  // Signed by a key the app can't sign with again: nothing may change, not even the fee.
  refuse(sent, walletSigned(fee().add(topUp())), /another key had signed already/, { exact: true });
  // Address lookup tables: unchanged only.
  const lut = [{ publicKey: generateSigner(umi).publicKey, addresses: [session.publicKey] }];
  const withLut = build(topUp().useV0().setAddressLookupTables(lut));
  assert.equal(accept(withLut, pageSign(withLut)).edited, false);
  refuse(withLut, walletSigned(fee().add(topUp()).useV0().setAddressLookupTables(lut)), /address lookup tables/);
});

test("withComputeBudget: the relay's own limit and price in front, nothing else changed", () => {
  for (const tx of [build(topUp()), build(topUp().useLegacyVersion()), build(two(topUp(), memo()))]) {
    const p = L.parseTransaction(tx);
    assert.deepEqual(L.serializeMessage(p.parsed), p.message, 'serializeMessage reverses parseMessage');
    const out = L.withComputeBudget(tx);
    const n = p.parsed.instructions.length;
    const s = L.summarizeTransaction(out);
    assert.deepEqual(s.instructions.slice(0, 2), [
      { kind: 'compute-budget', units: 200_000 * n },
      { kind: 'compute-budget', microLamports: L.RELAY_MICRO_LAMPORTS_PER_UNIT },
    ]);
    assert.deepEqual(s.instructions.slice(2), L.summarizeTransaction(tx).instructions);
    assert.deepEqual({ ...s, instructions: [] }, { ...L.summarizeTransaction(tx), instructions: [] }, 'same fee payer, signers, blockhash, version');
    assert.ok(L.parseTransaction(out).signatures.every((sig) => sig.every((b) => b === 0)));
    assert.equal(umi.transactions.deserialize(out).message.instructions.length, n + 2, 'umi reads it');
    assert.equal(L.checkWalletEdits(p.message, L.parseTransaction(out).message).edited, true);
    assert.equal(L.withComputeBudget(out), out, 'a budget already: left alone');
  }
  // No room left for it: as it was (the wallet can't add one either).
  const base = build(two(topUp(), memo(''))).length;
  const big = build(two(topUp(), memo('x'.repeat(L.PACKET_SIZE - base - 10))));
  assert.ok(big.length <= L.PACKET_SIZE);
  assert.equal(L.withComputeBudget(big), big);
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
