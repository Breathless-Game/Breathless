// Dev-only: mounts the REAL Vault (Collection panel) with fixture fish and a fake sale queue,
// so the Collection can be checked without a Phantom login. Not part of the build inputs.
import { rollFish, type Rarity } from './fish';
import { setLang, lang } from './i18n';
import { Vault } from './vault';
import { OTHER_DEVICE } from './fish-cosign';
import type { BankedFish } from './market';
import type { NftQueue } from './nft-queue';

let counter = 0;
/** A rolled fish of the wanted rarity. Searches a bounded seed range; if none matches, takes the first roll and forces the rarity, so this never throws. */
function fish(rarity: Rarity, extra: Partial<BankedFish> = {}): BankedFish {
  const depth = 120 + (counter % 5) * 200;
  const start = 1000 + counter * 7919;
  let f = rollFish(start, depth);
  for (let seed = start; seed < start + 3000; seed++) {
    const r = rollFish(seed, depth);
    if (r.rarity === rarity) { f = r; break; }
  }
  if (f.rarity !== rarity) f = { ...f, rarity };
  counter++;
  return { ...f, nft: 'minted', trusted: true, metaFixed: true, nameFixed: true, serial: 100 + counter, ...extra };
}

function fixtures(): BankedFish[] {
  counter = 0;
  return [
    fish('common'), fish('common'), fish('common'), fish('uncommon'), fish('uncommon'), fish('uncommon'),
    fish('common'), fish('rare'), fish('epic'), fish('legendary'),
    fish('uncommon', { nft: 'minting', trusted: undefined, serial: undefined }),
    fish('common', { nft: 'failed', trusted: undefined, mintError: 'Mint failed: transaction simulation error (dev fixture).' }),
    fish('uncommon', { sellBlock: OTHER_DEVICE }),
    fish('common', { legacy: true, nft: undefined, trusted: undefined, serial: undefined }),
    fish('rare', { name: 'The Extraordinarily Long-Named Abyssal Wandering Gilded Reef Lurker of the Deep' }),
  ];
}

const bank: BankedFish[] = fixtures();
let failNext = false;

const selling = new Map<BankedFish, 'verify' | 'sign' | 'confirm' | null>();
const sellErrors = new Map<BankedFish, string>();

const queue = {
  funds: 'ok', serials: 'ok', balance: null, declined: 0, mintPause: null, minting: null, batch: null,
  lastSale: null as null | { name: string; result: { pearls: number; tx: string }; count: number; total: number; failed: number },
  selling, sellErrors,
  loadChain: () => Promise.reject(new Error('no chain in preview')),
  recheck() {}, enqueue() {}, retry() {}, cancelSell() {},
  sell(f: BankedFish) { this.sellMany([f]); },
  sellMany(list: readonly BankedFish[]) {
    const items = list.filter((f) => !selling.has(f));
    if (!items.length) return;
    const fails = failNext;
    failNext = false;
    document.getElementById('dev-fail')?.setAttribute('aria-pressed', 'false');
    for (const f of items) { sellErrors.delete(f); selling.set(f, 'sign'); }
    vault.refresh();
    setTimeout(() => {
      for (const f of items) selling.delete(f);
      if (fails) {
        for (const f of items) sellErrors.set(f, 'Sale failed: wallet rejected the request (dev fixture).');
      } else {
        for (const f of items) { const i = bank.indexOf(f); if (i >= 0) bank.splice(i, 1); }
        queue.lastSale = {
          name: items[0].name,
          result: { pearls: items.length * 5, tx: '1'.repeat(64) },
          count: items.length, total: items.length * 5, failed: 0,
        };
      }
      vault.refresh();
    }, 800);
  },
};

const vault = new Vault(bank, queue as unknown as NftQueue);
document.getElementById('collection-close')?.addEventListener('click', () => vault.toggle(false));

const $ = (id: string) => document.getElementById(id)!;
$('dev-open').addEventListener('click', () => vault.toggle(true));
$('dev-fail').addEventListener('click', (e) => {
  failNext = !failNext;
  (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(failNext));
});
$('dev-reset').addEventListener('click', () => {
  bank.splice(0, bank.length, ...fixtures());
  selling.clear(); sellErrors.clear(); queue.lastSale = null;
  vault.refresh();
});
$('dev-over').addEventListener('click', (e) => {
  const on = $('collection').classList.toggle('over-aquarium');
  (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(on));
});
$('dev-lang').addEventListener('click', () => setLang(lang() === 'zh' ? 'en' : 'zh'));

vault.toggle(true);
(window as unknown as { __preview: unknown }).__preview = { vault, bank, queue };
