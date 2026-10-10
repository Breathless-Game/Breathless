// ⚠ STUB. The real PEARL client (an SPL token on Solana devnet) replaces this file wholesale: there a
// sale is one atomic transaction in which the program burns the fish NFT and mints PEARL, with the
// market server co-signing as an oracle. Keep the exported interface exactly as it is and add nothing
// else here.
//
// Until then the balance lives in localStorage under `deepbreath.pearl-stub`. A sale burns the NFT for
// real from the burner wallet (that burn is the sale's one tx), then the stub credits the fish's catch
// value. Callers import this module lazily, like chain.ts.

import { fishValue, type FishSpec } from './fish';

export type SellStep = 'verify' | 'sign' | 'confirm';
export interface SellResult { pearls: number; tx: string }

const LEDGER = 'deepbreath.pearl-stub';

function read(): number {
  try {
    const n = Number(JSON.parse(localStorage.getItem(LEDGER) ?? '0'));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function write(n: number) {
  try {
    localStorage.setItem(LEDGER, JSON.stringify(n));
  } catch {}
}

/** PEARL in the burner wallet (decimals 0). */
export async function pearlBalance(): Promise<number> {
  return read();
}

/** One atomic sale: the program burns the fish NFT and mints PEARL to the seller. Returns that tx. */
export async function sellToMarket(assetId: string, onStep?: (s: SellStep) => void): Promise<SellResult> {
  onStep?.('verify');
  let fish: FishSpec | undefined;
  try {
    fish = (JSON.parse(localStorage.getItem('deepbreath.bank') ?? '[]') as FishSpec[]).find((f) => f.assetId === assetId);
  } catch {}
  if (!fish) throw new Error('Market: that NFT is not in your bank');
  onStep?.('sign');
  const { burnFish } = await import('./chain');
  const tx = await burnFish(assetId); // resolves once confirmed; a failed burn pays nothing
  onStep?.('confirm');
  const pearls = fishValue(fish);
  write(read() + pearls);
  return { pearls, tx };
}

/** Burns PEARL from the player's account, returns the tx. */
export async function spendPearls(amount: number): Promise<string> {
  const have = read();
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`Cannot spend ${amount} PEARL`);
  if (have < amount) throw new Error(`Not enough PEARL (${have} of ${amount})`);
  write(have - amount);
  return `stub-spend-${Date.now().toString(36)}`;
}
