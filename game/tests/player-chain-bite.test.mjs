import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// player-chain.ts against a fake RPC: an owed shark bite must never be (re)sent while a purchase
// that may carry it, or may have raised a level after it, is still unsettled (review H1).
const dataUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
async function transpile(rel, replace = {}) {
  const source = await readFile(new URL(`../src/${rel}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  for (const [from, to] of Object.entries(replace)) outputText = outputText.replaceAll(`from '${from}'`, `from '${to}'`).replaceAll(`import('${from}')`, `import('${to}')`);
  return dataUrl(outputText);
}

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// A transaction builder that only remembers which instructions it holds.
const umiStub = dataUrl(`
let n = 0;
export class B {
  constructor(items = []) { this.items = items; }
  add(b) { return new B([...this.items, ...b.items]); }
  setFeePayer(p) { this.payer = p; return this; }
  setBlockhash() { return this; }
  getTransactionSize() { return 200; }
  async buildAndSign() { return { signatures: ['sig' + ++n + ':' + this.items.join('+')], payer: this.payer }; }
}
export const publicKey = (s) => s;
export const transactionBuilder = () => new B([]);
`);
const serializersStub = dataUrl('export const base58 = { serialize: (s) => s, deserialize: (b) => [b] };');
const walletStub = dataUrl(`
export const walletState = () => globalThis.__wallet;
export const ownerSigner = () => ({ publicKey: 'OWNER' });
export const sessionSigner = () => ({ publicKey: 'SESS' });
export const storageKey = (name) => 'w.' + name;
`);
const balanceStub = dataUrl('export const markBalanceStale = () => {};');
const chainStub = dataUrl('export const getUmi = async () => globalThis.__umi;');
const psStub = dataUrl(`
import { B } from '${umiStub}';
export const playerStateProgramId = () => 'PROG';
export const SLOT_ORDER = ['rod', 'reel', 'net', 'fins', 'tank', 'lamp', 'sonar'];
export const decodeConfig = (d) => d, decodePlayerState = (d) => d, decodeAquarium = (d) => d;
export const findConfigPda = () => ['config'], findPlayerStatePda = () => ['player'], findAquariumPda = () => ['aquarium'];
export const initPlayer = () => new B(['init_player']);
export const setSession = () => new B(['set_session']);
export const sharkBite = () => new B(['shark_bite']);
`);
const umiUrl = import.meta.resolve('@metaplex-foundation/umi');
const realPs = await transpile('player-state.ts', { '@metaplex-foundation/umi': umiUrl });
const ps = await import(realPs);
const syncUrl = await transpile('player-sync.ts', { './player-state': realPs });
const chain = await import(await transpile('player-chain.ts', {
  '@metaplex-foundation/umi': umiStub,
  '@metaplex-foundation/umi/serializers': serializersStub,
  './wallet': walletStub,
  './balance-api': balanceStub,
  './payment-safety': await transpile('payment-safety.ts'),
  './player-state': psStub,
  './player-sync': syncUrl,
  './player-state-errors': await transpile('player-state-errors.ts'),
  './chain': chainStub,
}));
const { B } = await import(umiStub);

const BITE = 'w.player-state.bite.pending';
const JOURNAL = 'w.pearl.purchases.pending';
const LV1 = { rod: 1, reel: 1, net: 1, fins: 1, tank: 1, lamp: 1, sonar: 1 };
const PATHS = { rod: 'far', reel: 'fastReel', net: 'wide', fins: 'sprint', tank: 'long', lamp: 'focus' };

let sends, statuses;
function setup({ levels = LV1 } = {}) {
  store.clear();
  sends = [];
  statuses = {};
  globalThis.__wallet = { owner: 'OWNER', session: 'SESS' };
  const player = { owner: 'OWNER', session: 'SESS', levels: { ...levels }, paths: { ...PATHS }, materials: {}, crafted: { bait: 0, composite: 0 } };
  globalThis.__umi = {
    rpc: {
      getAccounts: async () => [
        { exists: true, owner: 'PROG', data: { pearlMint: 'MINT', tokenProgram: 'TP', prices: ps.GAME_PRICE_TABLE } },
        { exists: true, owner: 'PROG', data: player },
        { exists: false },
      ],
      getLatestBlockhash: async () => ({ blockhash: 'bh', lastValidBlockHeight: 100 }),
      // What the bite flag says at the moment a transaction is broadcast.
      sendTransaction: async (tx) => void sends.push({ sig: tx.signatures[0], payer: tx.payer?.publicKey, bite: store.get(BITE) ?? null }),
      confirmTransaction: async () => ({ value: { err: null } }),
      getSignatureStatuses: async (sigs) => sigs.map((s) => statuses[s] ?? null),
      call: async () => 50,
    },
  };
  return player;
}

test('H1a: no session shark_bite while the purchase journal is non-empty', async () => {
  setup({ levels: { ...LV1, rod: 2 } });
  store.set(JOURNAL, JSON.stringify([{ signature: 'lost', what: { v: 1, kind: 'upgrade', slot: 'rod', level: 2, bite: true }, cost: 100, ts: Date.now(), lastValid: 100 }]));
  assert.equal(await chain.recordSharkBite(), 'deferred');
  assert.equal(sends.length, 0, 'nothing sent');
  assert.equal(store.get(BITE), '1', 'the bite stays owed');
  // A reload: the login settles nothing either while the record is unknown.
  await chain.settleOwedBite();
  assert.equal(sends.length, 0);
});

test('H1b: a purchase carrying the owed bite marks it in flight from the moment it is signed', async () => {
  setup({ levels: { ...LV1, rod: 2 } });
  store.set(BITE, '1');
  await chain.sendPlayerPurchase(() => ({ builder: new B(['buy_upgrade']), what: { v: 1, kind: 'upgrade', slot: 'rod', level: 2 }, cost: 100 }), 'Upgrade');
  assert.equal(sends.length, 1, 'one transaction, one prompt');
  assert.match(sends[0].sig, /shark_bite\+buy_upgrade$/, 'the bite rides in front of the purchase');
  assert.deepEqual(JSON.parse(sends[0].bite), { sig: sends[0].sig, lastValid: 100 }, 'never "owed" while it may land');
  assert.equal(store.has(BITE), false, 'settled once it landed');
});

test('H1: after a lost confirmation, login settles the journal first and the bite rides with it', async () => {
  setup({ levels: { ...LV1, rod: 2 } });
  const sig = 'sig-lost:shark_bite+buy_upgrade';
  store.set(JOURNAL, JSON.stringify([{ signature: sig, what: { v: 1, kind: 'upgrade', slot: 'rod', level: 2, bite: true }, cost: 100, ts: Date.now(), lastValid: 100 }]));
  store.set(BITE, JSON.stringify({ sig, lastValid: 100 }));
  // Still unknown and the blockhash valid: kept, and no session bite goes out.
  const kept = await chain.reconcilePlayerPurchases();
  assert.deepEqual(kept.kept, [sig]);
  assert.equal(await chain.recordSharkBite(), 'deferred');
  // It landed: delivered, the bite it carried is settled, nothing is re-sent.
  statuses[sig] = { error: null, commitment: 'confirmed' };
  const done = await chain.reconcilePlayerPurchases();
  assert.deepEqual(done.delivered, [sig]);
  assert.equal(store.has(BITE), false);
  assert.equal(store.has(JOURNAL), false);
  assert.equal(sends.length, 0);
});

test('H1: a bite-carrying purchase that never landed owes the bite again', async () => {
  setup({ levels: { ...LV1, rod: 3 } });
  const sig = 'sig-expired:shark_bite+buy_upgrade';
  store.set(JOURNAL, JSON.stringify([{ signature: sig, what: { v: 1, kind: 'upgrade', slot: 'rod', level: 2, bite: true }, cost: 100, ts: Date.now(), lastValid: 40 }]));
  store.set(BITE, JSON.stringify({ sig, lastValid: 40 }));
  const report = await chain.reconcilePlayerPurchases(); // height 50 > 40: expired, not found
  assert.deepEqual(report.dropped, [sig], 'an old Lv3 is not evidence for a bite-carrying record');
  assert.equal(store.get(BITE), '1');
  // Now the session key settles it (the journal is empty).
  assert.equal(await chain.recordSharkBite(), 'sent');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].payer, 'SESS', 'the session key pays');
  assert.deepEqual(JSON.parse(sends[0].bite), { sig: sends[0].sig, lastValid: 100 });
});

test('M1: a purchase stays locked while an earlier one may still land, whatever the state shows', async () => {
  setup({ levels: { ...LV1, rod: 3 } }); // another device already reached Lv3
  store.set(JOURNAL, JSON.stringify([{ signature: 'a', what: { v: 1, kind: 'upgrade', slot: 'rod', level: 3 }, cost: 500, ts: Date.now(), lastValid: 100 }]));
  await assert.rejects(
    chain.sendPlayerPurchase(() => ({ builder: new B(['buy_upgrade']), what: { v: 1, kind: 'upgrade', slot: 'net', level: 2 }, cost: 300 }), 'Upgrade'),
    { name: 'PaymentInProgressError' },
  );
  assert.equal(sends.length, 0);
  assert.equal(JSON.parse(store.get(JOURNAL)).length, 1, 'still journaled');
});
