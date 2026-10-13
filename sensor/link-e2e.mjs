// Devnet end-to-end check of the desktop app's browser wallet link (link-relay.mjs, link.html,
// game/src/relay-signer.ts), all in one process:
//   relay  link-relay.mjs on a memory KV behind a real http server on 127.0.0.1
//   app    the game's relay-signer.ts, creating sessions and polling for them over HTTP
//   page   what link.html does: read the request, swap in a fresh devnet blockhash, sign as the owner
// It logs in, has a top-up and a session-paid owner co-sign signed after a delay (so the blockhash
// is swapped), checks tampering, a wrong key and cancel are refused, then sends both transactions,
// or, while the owner has no devnet SOL, simulates them with signature verification.
//
//   npm run link:e2e      (in sensor/; needs game/node_modules)
//
// The throwaway owner keypair lives in the OS temp dir (or E2E_KEYPAIR), so a wallet you fund by
// hand at https://faucet.solana.com (0.03 SOL is plenty) is reused on the next run.
// Prints no secrets or tokens.
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const KEYFILE = process.env.E2E_KEYPAIR ?? path.join(os.tmpdir(), 'link-e2e-keypair.json');
const req = createRequire(`${REPO}/game/package.json`);
const load = (name) => import(pathToFileURL(req.resolve(name)).href);
const ts = (await load('typescript')).default;
const dataUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
function transpile(rel, replace = {}) {
  let { outputText } = ts.transpileModule(readFileSync(`${REPO}/game/src/${rel}`, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  for (const [from, to] of Object.entries(replace)) outputText = outputText.replaceAll(`from '${from}'`, `from '${to}'`);
  return dataUrl(outputText);
}
const linkTxUrl = transpile('link-tx.ts');
const L = await import(linkTxUrl);
const R = await import(transpile('relay-signer.ts', { './link-tx': linkTxUrl, './i18n': transpile('i18n.ts') }));
const X = await import(transpile('blockhash-expiry.ts'));
const { createLinkHandler } = await import(`${REPO}/sensor/link-relay.mjs`);
const { createMemoryKv } = await import(`${REPO}/sensor/market-store.mjs`);
const { linkUrl } = await import(`${REPO}/desktop/src/wallet-bridge.js`);

const { generateSigner, createSignerFromKeypair, sol, transactionBuilder } = await load('@metaplex-foundation/umi');
const { createUmi } = await load('@metaplex-foundation/umi-bundle-defaults');
const { mplToolbox, transferSol } = await load('@metaplex-foundation/mpl-toolbox');
const { ed25519 } = await load('@noble/curves/ed25519');

const verify = (sig, msg, pub) => {
  try {
    return ed25519.verify(sig, msg, pub, { zip215: false });
  } catch {
    return false;
  }
};
const umi = createUmi(RPC).use(mplToolbox());
if (!existsSync(KEYFILE)) writeFileSync(KEYFILE, JSON.stringify([...generateSigner(umi).secretKey]), { mode: 0o600 });
const owner = createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(new Uint8Array(JSON.parse(readFileSync(KEYFILE, 'utf8')))));
const session = generateSigner(umi);
const stranger = generateSigner(umi);
const results = [];
const ok = (what) => (results.push(`PASS ${what}`), console.log(`PASS ${what}`));

// ---- The relay, on a real socket --------------------------------------------------------
const logs = [];
const handler = createLinkHandler({ kv: createMemoryKv(), log: (...a) => logs.push(a.join(' ')) });
const server = http.createServer(async (rq, rs) => {
  if (!(await handler(rq, rs))) rs.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const APP_ORIGIN = 'https://breathless.example'; // what the packaged app's origin would be (the bridge is https-only)
const secretsSeen = [];

// ---- The app side (desktop-wallet.ts relay(): create, open, poll) --------------------------
async function appRelay(kind, payload, page) {
  const created = await fetch(`${ORIGIN}/api/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, payload }) });
  assert.equal(created.status, 201);
  const s = await created.json();
  secretsSeen.push(s.appToken, s.pageToken);
  const url = `${APP_ORIGIN}/link.html?sid=${encodeURIComponent(s.sid)}#t=${s.pageToken}`;
  assert.ok(linkUrl(url, APP_ORIGIN), 'the desktop bridge would open this link');
  page(url.replace(APP_ORIGIN, ORIGIN)).catch((e) => console.log('page:', e.message));
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await fetch(`${ORIGIN}/api/link/${s.sid}/result`, { headers: { Authorization: `Bearer ${s.appToken}` } });
    if (r.status === 202) continue;
    if (r.status !== 200) throw new Error(`poll HTTP ${r.status}`);
    const body = await r.json();
    if (body.status === 'cancelled') throw new R.RelayError('cancelled');
    return { session: s, result: body.result };
  }
}

// ---- The page side (link.ts) ------------------------------------------------------------
async function pageOpen(url) {
  const u = new URL(url);
  const sid = u.searchParams.get('sid');
  const token = new URLSearchParams(u.hash.slice(1)).get('t');
  const api = (p = '', init = {}) => fetch(`${ORIGIN}/api/link/${sid}${p}`, { ...init, headers: { ...(init.headers ?? {}), 'X-Link-Token': token } });
  const got = await api();
  assert.equal(got.status, 200);
  return { sid, api, request: await got.json(), origin: u.origin };
}
async function freshBlockhash() {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] }) });
  return (await r.json()).result.value;
}
const post = (api, body) => api('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
/** The page signing as `key`, optionally signing something else than it was given. */
const signingPage = ({ key = owner, swap = (t) => t, delayMs = 2500, onDone } = {}) => async (url) => {
  const { api, request } = await pageOpen(url);
  assert.equal(request.payload.owner, owner.publicKey.toString());
  await new Promise((r) => setTimeout(r, delayMs)); // the player reading the summary
  const shown = request.payload.txs.map((b) => L.summarizeTransaction(L.fromBase64(b), {}));
  const fresh = request.payload.keepBlockhash ? null : await freshBlockhash();
  const txs = request.payload.txs.map((b64) => {
    let tx = L.fromBase64(b64);
    if (fresh) tx = L.withBlockhash(tx, L.base58Decode(fresh.blockhash));
    tx = swap(tx);
    const p = L.parseTransaction(tx);
    const i = p.parsed.keys.findIndex((k) => L.bytesEqual(k, L.addressBytes(owner.publicKey)));
    tx.set(ed25519.sign(p.message, key.secretKey.subarray(0, 32)), 1 + 64 * i);
    return L.toBase64(tx);
  });
  const r = await post(api, { txs, ...(fresh ?? {}) });
  assert.equal(r.status, 200);
  // A second answer (a replay, another tab) is refused: the first result won.
  assert.equal((await post(api, { txs, ...(fresh ?? {}) })).status, 401);
  onDone?.({ shown, fresh });
};

function relaySigner(page) {
  return R.createRelaySigner({
    umi,
    address: owner.publicKey.toString(),
    local: [session],
    verify,
    relay: async (rq) => (await appRelay('sign', rq, page)).result,
    noteExpiry: async (blockhash, lastValid) => {
      const height = await umi.rpc.call('getBlockHeight', [{ commitment: 'confirmed' }]).catch(() => null);
      X.noteBlockhashExpiry(blockhash, typeof height === 'number' ? Math.min(lastValid, height + 300) : lastValid);
    },
  });
}

async function simulate(tx) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [L.toBase64(umi.transactions.serialize(tx)), { encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false, commitment: 'confirmed' }] }),
  });
  return r.json();
}
const balance = async (pk) => Number((await umi.rpc.getBalance(pk)).basisPoints);

try {
  // 1. Login: the page signs the login message, the app checks it.
  const nonce = L.base58Encode(ed25519.utils.randomSecretKey()).slice(0, 24);
  const loginPage = (key) => async (url) => {
    const { sid, api, request, origin } = await pageOpen(url);
    void origin; // the page signs for the origin it was opened on: the app's, not this test server's
    const text = L.loginMessage({ sid, nonce: request.payload.nonce, expiresAt: request.expiresAt, origin: APP_ORIGIN });
    const r = await post(api, { publicKey: owner.publicKey.toString(), signature: L.toBase64(ed25519.sign(new TextEncoder().encode(text), key.secretKey.subarray(0, 32))) });
    assert.equal(r.status, 200);
  };
  {
    const { session: s, result } = await appRelay('connect', { nonce }, loginPage(owner));
    const expected = L.loginMessage({ sid: s.sid, nonce, expiresAt: s.expiresAt, origin: APP_ORIGIN });
    assert.equal(L.checkLogin(expected, result.publicKey, L.fromBase64(result.signature), verify), owner.publicKey.toString());
    ok('login: the owner signs the login message in the browser, the app verifies it');
  }
  {
    const { session: s, result } = await appRelay('connect', { nonce }, loginPage(stranger));
    const expected = L.loginMessage({ sid: s.sid, nonce, expiresAt: s.expiresAt, origin: APP_ORIGIN });
    assert.throws(() => L.checkLogin(expected, result.publicKey, L.fromBase64(result.signature), verify), L.RelayCheckError);
    ok('login: a signature by another key claiming the owner address is refused');
  }

  // 2. Owner pays (a top-up), signed 2.5 s after it was built: the page swaps in a fresh blockhash.
  const funded = (await balance(owner.publicKey)) >= 30_000_000;
  console.log(`owner ${owner.publicKey} devnet balance ${(await balance(owner.publicKey)) / 1e9} SOL${funded ? '' : ' (unfunded: simulate with sigVerify instead of sending)'}`);
  const built = await umi.rpc.getLatestBlockhash({ commitment: 'confirmed' });
  let pageSaw = null;
  const topUpSigner = relaySigner(signingPage({ onDone: (x) => (pageSaw = x) }));
  const topUp = transferSol(umi, { source: topUpSigner, destination: session.publicKey, amount: sol(0.01) }).setFeePayer(topUpSigner).setBlockhash(built);
  const topUpTx = await topUp.buildAndSign(umi);
  assert.notEqual(topUpTx.message.blockhash, built.blockhash, 'the blockhash was swapped');
  assert.equal(topUpTx.message.blockhash, pageSaw.fresh.blockhash);
  assert.equal(pageSaw.shown[0].instructions.find((i) => i.kind === 'sol-transfer')?.lamports, 10_000_000n);
  const expiry = X.expiryOf(topUpTx, built);
  assert.equal(expiry.blockhash, pageSaw.fresh.blockhash);
  ok(`top-up: blockhash swapped by the page, app re-checked it, expiry ${expiry.lastValidBlockHeight} from the new blockhash; page summary showed 0.01 SOL`);

  // 3. Session pays, owner co-signs (burnFish's order): the session key signs again after the swap.
  const coSigner = relaySigner(signingPage());
  const co = transactionBuilder()
    .add(transferSol(umi, { source: coSigner, destination: session.publicKey, amount: sol(0.001) }))
    .setFeePayer(session)
    .setBlockhash(await umi.rpc.getLatestBlockhash({ commitment: 'confirmed' }));
  const coTx = await co.buildAndSign(umi);
  ok('session-paid, owner co-signed: session re-signed over the swapped message');

  // 4. Tampering: the page (or a wallet) signs a different amount.
  {
    const bigger = transferSol(umi, { source: owner, destination: stranger.publicKey, amount: sol(0.5) }).setFeePayer(owner).setBlockhash(built).build(umi);
    const evil = relaySigner(signingPage({ swap: (tx) => L.withBlockhash(umi.transactions.serialize(bigger), L.parseTransaction(tx).parsed.blockhash) }));
    const sneaky = transferSol(umi, { source: evil, destination: session.publicKey, amount: sol(0.01) }).setFeePayer(evil).setBlockhash(built);
    await assert.rejects(sneaky.buildAndSign(umi), (e) => e instanceof R.RelayError && e.noRetry);
    ok('tampered: a page that has the owner sign a different transfer is refused by the app');
  }
  {
    const wrongKey = relaySigner(signingPage({ key: stranger }));
    await assert.rejects(transferSol(umi, { source: wrongKey, destination: session.publicKey, amount: sol(0.01) }).setFeePayer(wrongKey).setBlockhash(built).buildAndSign(umi), /signature is not valid/);
    ok('tampered: a signature by another key is refused');
  }

  // 5. Cancel from the page.
  {
    const cancelPage = async (url) => {
      const { api } = await pageOpen(url);
      assert.equal((await api('/cancel', { method: 'POST' })).status, 200);
    };
    await assert.rejects(appRelay('sign', { owner: owner.publicKey.toString(), txs: [L.toBase64(L.zeroSignatures(umi.transactions.serialize(topUpTx)))] }, cancelPage), /cancelled/);
    ok('cancel on the page reaches the app');
  }

  // 6. Devnet itself: send, or simulate with signature verification.
  if (funded) {
    for (const [name, tx] of [['top-up', topUpTx], ['session-paid co-sign', coTx]]) {
      const sig = await umi.rpc.sendTransaction(tx);
      const exp = X.expiryOf(tx, built);
      const res = await umi.rpc.confirmTransaction(sig, { strategy: { type: 'blockhash', ...exp }, commitment: 'confirmed' });
      assert.equal(res.value.err, null);
      ok(`devnet: ${name} landed, https://explorer.solana.com/tx/${L.base58Encode(sig)}?cluster=devnet`);
    }
  } else {
    for (const [name, tx] of [['top-up', topUpTx], ['session-paid co-sign', coTx]]) {
      const r = await simulate(tx);
      console.log(`  simulate ${name}:`, JSON.stringify(r.error ?? r.result?.value?.err));
      assert.ok(!r.error, 'signatures verified by devnet');
      assert.equal(r.result.value.err, 'AccountNotFound', 'only the missing funds stop it');
      ok(`devnet simulate(sigVerify): ${name} passes signature and blockhash checks (fails only for the unfunded payer)`);
    }
    const broken = umi.transactions.serialize(topUpTx);
    broken[1] ^= 1;
    const r = await simulate(umi.transactions.deserialize(broken));
    console.log('  simulate a flipped signature:', JSON.stringify(r.error ?? r.result?.value?.err));
    assert.ok(r.error || r.result.value.err === 'SignatureFailure', 'devnet refuses a bad signature');
    ok('devnet simulate(sigVerify): a flipped signature byte is refused with SignatureFailure (control)');
    const stale = await transferSol(umi, { source: owner, destination: session.publicKey, amount: sol(0.01) })
      .setFeePayer(owner)
      .setBlockhash({ blockhash: L.base58Encode(ed25519.utils.randomSecretKey()), lastValidBlockHeight: 1 })
      .buildAndSign(umi);
    const r2 = await simulate(stale);
    console.log('  simulate an unknown blockhash:', JSON.stringify(r2.error ?? r2.result?.value?.err));
    assert.equal(r2.result?.value?.err, 'BlockhashNotFound');
    ok('devnet simulate: an unknown blockhash is refused with BlockhashNotFound (control: the swapped one was live)');
  }

  const logText = logs.join('\n');
  assert.ok(secretsSeen.every((s) => !logText.includes(s)), 'no token in the relay logs');
  ok(`relay logs: ${logs.length} line(s), no tokens`);
} finally {
  server.close();
  console.log(`\n${results.length} checks passed`);
}
