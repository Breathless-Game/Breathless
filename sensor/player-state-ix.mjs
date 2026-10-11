// The one player_state instruction the market server sends: record_catch, appended to the
// co-signed fish mint (fish-collection.mjs cosignMint). A port of game/src/player-state.ts
// recordCatch (contracts/programs/player_state, v2), kept byte for byte the same; the tests in
// player-state-ix.test.mjs pin the discriminator, the account order and the argument layout.
//
//   accounts  oracle (signer)  payer (signer, writable)  config ["config"]  owner
//             progress ["progress", owner] (writable)  system program
//   data      [36, 14, 58, 242, 96, 105, 45, 233] ++ fish u64 LE ++ value u64 LE   (24 bytes)
//
// The oracle is Config.oracle (the market wallet, already a signer of the mint as the fish
// collection's authority) and the payer is the mint's fee payer (the game's session key), so the
// instruction adds no signature. It is increment-only and idempotent per fish: a retried mint of
// the same fish is a successful no-op on chain.

import { publicKey, publicKeyBytes, transactionBuilder } from '@metaplex-foundation/umi';

/** The devnet program (contracts/DEPLOYED.md). PLAYER_STATE_PROGRAM_ID overrides it. */
export const DEFAULT_PLAYER_STATE_PROGRAM_ID = 'EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ';
export const RECORD_CATCH_DISCRIMINATOR = Object.freeze([36, 14, 58, 242, 96, 105, 45, 233]);
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const PROGRESS_HEADER_SIZE = 100; // Progress, discriminator included; the catch log follows
const CATCH_KEY_SIZE = 8;
const ACCOUNT_HEADER_SIZE = 128;

export function playerStateProgramId(env = process.env) {
  return publicKey(env.PLAYER_STATE_PROGRAM_ID?.trim() || DEFAULT_PLAYER_STATE_PROGRAM_ID);
}

const utf8 = (s) => new TextEncoder().encode(s);

export const findConfigPda = (u, programId) => u.eddsa.findPda(programId, [utf8('config')]);
export const findProgressPda = (u, owner, programId) => u.eddsa.findPda(programId, [utf8('progress'), publicKeyBytes(owner)]);

/** A fish's catch-log key: its 8-hex seed id as a u64 (game/src/player-state.ts fishSeedKey). */
export function fishSeedKey(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}$/.test(id)) throw new Error(`Bad fish id ${id}`);
  return BigInt(`0x${id}`);
}

function u64le(v) {
  let n = BigInt(v);
  if (n < 0n || n >= 1n << 64n) throw new RangeError(`u64 out of range: ${v}`);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** The instruction data: discriminator, fish key, value. */
export function recordCatchData(fish, value) {
  return Uint8Array.from([...RECORD_CATCH_DISCRIMINATOR, ...u64le(fish), ...u64le(value)]);
}

/**
 * record_catch as a umi TransactionBuilder. oracle / payer are Signers (noop signers are fine:
 * the market signs as oracle, the session key as payer). fish: the u64 seed key; value: the
 * validated catch value (a positive safe integer).
 */
export function recordCatch(u, { oracle, payer, owner, fish, value, programId = playerStateProgramId() }) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Bad catch value ${value}`);
  const ownerKey = publicKey(owner);
  const program = publicKey(programId);
  const keys = [
    { pubkey: oracle.publicKey, isSigner: true, isWritable: false },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: findConfigPda(u, program)[0], isSigner: false, isWritable: false },
    { pubkey: ownerKey, isSigner: false, isWritable: false },
    { pubkey: findProgressPda(u, ownerKey, program)[0], isSigner: false, isWritable: true },
    { pubkey: publicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
  ];
  return transactionBuilder([
    {
      instruction: { programId: program, keys, data: recordCatchData(fish, value) },
      signers: [oracle, payer],
      // Worst case for the fee estimate: a new Progress plus this fish's log entry.
      bytesCreatedOnChain: PROGRESS_HEADER_SIZE + ACCOUNT_HEADER_SIZE + CATCH_KEY_SIZE,
    },
  ]);
}
