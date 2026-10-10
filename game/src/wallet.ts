// STUB: every wallet role is the local burner wallet. The Phantom login branch
// replaces this file: owner = the player's Phantom, session = an in-game key.
import type { Signer, Umi } from '@metaplex-foundation/umi';

/** The player's address: owns the fish NFTs and PEARL. */
export function ownerAddress(umi: Umi): string {
  return umi.identity.publicKey.toString();
}

/** Signs as the owner (selling, spending PEARL). Phantom will prompt for these. */
export function ownerSigner(umi: Umi): Signer {
  return umi.identity;
}

/** Signs silently and pays fees (minting fish). Never prompts. */
export function sessionSigner(umi: Umi): Signer {
  return umi.identity;
}
