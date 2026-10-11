// Light link helpers with no imports, so statically-loaded UI can use them
// without pulling chain.ts (Umi, Solana libs) into the entry bundle.

/** Helius Orb: the wallet's NFTs on devnet. The owner wallet holds the fish, not the session key. */
export const orbNfts = (address: string) =>
  `https://orbmarkets.io/address/${encodeURIComponent(address)}/portfolio?cluster=devnet&tab=nfts`;
