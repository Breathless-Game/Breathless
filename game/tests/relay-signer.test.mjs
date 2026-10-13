import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The desktop Browser wallet's umi Signer (src/relay-signer.ts) with a real umi and a simulated
// link page (a throwaway owner key): the blockhash swap, re-signing what the session key signed
// before the owner, keeping the blockhash when a key this device doesn't hold signed first, one
// relay per batch, and refusing whatever the page changed. Confirmation uses the new blockhash's
// expiry (src/blockhash-expiry.ts).

const dataUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
async function transpile(rel, replace = {}) {
  const source = await readFile(new URL(`../src/${rel}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  for (const [from, to] of Object.entries(replace)) outputText = outputText.replaceAll(`from '${from}'`, `from '${to}'`);
  return dataUrl(outputText);
}
const linkTxUrl = await transpile('link-tx.ts');
const L = await import(linkTxUrl);
const R = await import(await transpile('relay-signer.ts', { './link-tx': linkTxUrl, './i18n': await transpile('i18n.ts') }));
const X = await import(await transpile('blockhash-expiry.ts'));

const { generateSigner, sol, transactionBuilder, signTransaction } = await import('@metaplex-foundation/umi');
const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
const { mplToolbox, transferSol } = await import('@metaplex-foundation/mpl-toolbox');
const { mplCore, burnV1 } = await import('@metaplex-foundation/mpl-core');
const { ed25519 } = await import('@noble/curves/ed25519');

const umi = createUmi('http://127.0.0.1:9').use(mplToolbox()).use(mplCore());
const verify = (sig, msg, pub) => {
  try {
    return ed25519.verify(sig, msg, pub, { zip215: false });
  } catch {
    return false;
  }
};
const owner = generateSigner(umi); // the key in the player's browser wallet
const session = generateSigner(umi); // this device's session key
const oracle = generateSigner(umi); // a key this device doesn't hold
const randomHash = () => L.base58Encode(ed25519.utils.randomSecretKey());
const BH1 = { blockhash: randomHash(), lastValidBlockHeight: 1000 };
const BH2 = { blockhash: randomHash(), lastValidBlockHeight: 2000 };

/** The link page and the browser wallet: swap in `fresh` (unless asked to keep it), sign as the owner. */
function page({ fresh = BH2, key = owner, tamper, swapWhenKept = false } = {}) {
  const calls = [];
  const relay = async (req) => {
    calls.push(req);
    const keep = req.keepBlockhash && !swapWhenKept;
    const txs = req.txs.map((b64) => {
      const tx = L.fromBase64(b64);
      assert.ok(L.parseTransaction(tx).signatures.every((s) => s.every((x) => x === 0)), 'nothing signed travels');
      let out = keep ? tx.slice() : L.withBlockhash(tx, L.base58Decode(fresh.blockhash));
      if (tamper) out = tamper(out);
      const p = L.parseTransaction(out);
      const i = p.parsed.keys.findIndex((k) => L.bytesEqual(k, L.addressBytes(owner.publicKey)));
      out.set(ed25519.sign(p.message, key.secretKey.subarray(0, 32)), 1 + 64 * i);
      return L.toBase64(out);
    });
    return keep ? { txs } : { txs, blockhash: fresh.blockhash, lastValidBlockHeight: fresh.lastValidBlockHeight };
  };
  return { relay, calls };
}

function relaySigner(p, local = [session]) {
  const noted = [];
  const signer = R.createRelaySigner({
    umi,
    address: owner.publicKey.toString(),
    local,
    relay: p.relay,
    verify,
    noteExpiry: (bh, lv) => {
      noted.push([bh, lv]);
      X.noteBlockhashExpiry(bh, lv);
    },
  });
  return { signer, noted };
}

/** Every signature slot holds a valid signature over the transaction's own message. */
function assertFullySigned(tx) {
  const bytes = umi.transactions.serialize(tx);
  const p = L.parseTransaction(bytes);
  p.signatures.forEach((sig, i) => assert.ok(verify(sig, p.message, p.parsed.keys[i]), `slot ${i} (${L.base58Encode(p.parsed.keys[i])}) valid`));
}

test('owner pays (a top-up): the blockhash is swapped, the owner signs it, confirmation uses its expiry', async () => {
  const p = page();
  const { signer, noted } = relaySigner(p);
  const builder = transferSol(umi, { source: signer, destination: session.publicKey, amount: sol(0.01) }).setFeePayer(signer).setBlockhash(BH1);
  const tx = await builder.buildAndSign(umi);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].keepBlockhash, false);
  assert.equal(tx.message.blockhash, BH2.blockhash);
  assertFullySigned(tx);
  assert.deepEqual(noted, [[BH2.blockhash, 2000]]);
  assert.deepEqual(X.expiryOf(tx, BH1), BH2);
  // Unchanged transactions keep the fetched expiry; an unknown blockhash refuses to guess.
  assert.deepEqual(X.expiryOf({ message: { blockhash: BH1.blockhash } }, BH1), BH1);
  assert.throws(() => X.expiryOf({ message: { blockhash: randomHash() } }, BH1), /No expiry known/);
});

test('the session key signed first (burnFish): it signs again over the new message', async () => {
  const p = page();
  const { signer } = relaySigner(p);
  const asset = generateSigner(umi).publicKey;
  // As umi does it: fee payer (the session) first, then the owner.
  const builder = burnV1(umi, { asset, authority: signer, payer: session }).setFeePayer(session).setBlockhash(BH1);
  const signers = builder.getSigners(umi);
  assert.deepEqual(signers.map((s) => s.publicKey), [session.publicKey, owner.publicKey], 'the session signs before the owner');
  const tx = await signTransaction(builder.build(umi), signers);
  assert.equal(p.calls[0].keepBlockhash, false, 'the session key is ours: swap away');
  assert.equal(tx.message.blockhash, BH2.blockhash);
  assertFullySigned(tx);
});

test('signers after the owner sign the new message in the first place', async () => {
  const p = page();
  const { signer } = relaySigner(p, []);
  const builder = transactionBuilder()
    .add(transferSol(umi, { source: signer, destination: oracle.publicKey, amount: sol(0.01) }))
    .add(transferSol(umi, { source: session, destination: oracle.publicKey, amount: sol(0.01) }))
    .setFeePayer(signer)
    .setBlockhash(BH1);
  const tx = await builder.buildAndSign(umi);
  assert.equal(tx.message.blockhash, BH2.blockhash);
  assertFullySigned(tx);
});

test("a key this device doesn't hold signed first (an oracle co-sign): the blockhash stays", async () => {
  const p = page();
  const { signer, noted } = relaySigner(p);
  const builder = transactionBuilder()
    .add(transferSol(umi, { source: oracle, destination: owner.publicKey, amount: sol(0.01) }))
    .add(transferSol(umi, { source: signer, destination: oracle.publicKey, amount: sol(0.01) }))
    .setFeePayer(signer)
    .setBlockhash(BH1);
  const presigned = await oracle.signTransaction(builder.build(umi));
  const tx = await signer.signTransaction(presigned);
  assert.equal(p.calls[0].keepBlockhash, true);
  assert.equal(tx.message.blockhash, BH1.blockhash);
  assertFullySigned(tx);
  assert.deepEqual(noted, []);
  // A page that swaps anyway is refused: the oracle's signature would be void.
  const rogue = relaySigner(page({ swapWhenKept: true })).signer;
  await assert.rejects(rogue.signTransaction(presigned), (e) => e instanceof R.RelayError && e.noRetry && /blockhash had to stay/.test(e.message));
});

test('a batch is one relay, one prompt', async () => {
  const p = page();
  const { signer } = relaySigner(p);
  const txs = [1, 2, 3].map((n) =>
    transferSol(umi, { source: signer, destination: session.publicKey, amount: sol(n / 100) }).setFeePayer(signer).setBlockhash(BH1).build(umi),
  );
  const signed = await signer.signAllTransactions(txs);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].txs.length, 3);
  assert.equal(signed.length, 3);
  signed.forEach(assertFullySigned);
});

test('whatever the page changes is refused, with nothing kept', async () => {
  const build = (s) => transferSol(umi, { source: s, destination: session.publicKey, amount: sol(0.01) }).setFeePayer(s).setBlockhash(BH1).build(umi);
  const cases = [
    [page({ key: oracle }), /signature is not valid/],
    [page({ tamper: (tx) => (tx[tx.length - 3] ^= 1, tx) }), /changed|unreadable/],
    [{ relay: async (req) => ({ txs: req.txs.slice(1) }) }, /returned 0 of 1/],
    [{ relay: async (req) => ({ txs: ['%%%'] , blockhash: BH2.blockhash, lastValidBlockHeight: 5 }) }, /unreadable/],
  ];
  for (const [p, why] of cases) {
    const { signer, noted } = relaySigner(p);
    await assert.rejects(signer.signTransaction(build(signer)), (e) => e instanceof R.RelayError && e.noRetry === true && why.test(e.message), String(why));
    assert.deepEqual(noted, []);
  }
  // A swapped blockhash without its expiry can't be confirmed: refused.
  const noExpiry = { relay: async (req) => ({ txs: (await page().relay(req)).txs }) };
  await assert.rejects(relaySigner(noExpiry).signer.signTransaction(build(relaySigner(noExpiry).signer)), /without saying until when/);
  // Not the owner's transaction at all.
  const { signer } = relaySigner(page());
  await assert.rejects(signer.signTransaction(build(session)), /does not ask for the owner/);
  await assert.rejects(signer.signMessage(new Uint8Array(3)), /transactions only/);
});
