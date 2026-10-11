// The fish_market Anchor program's `sell_fish` instruction, built by hand so
// neither the server nor the browser needs the Anchor TS client. Pure: no RPC.
//
// When the IDL (game/src/idl/fish_market.json) exists, layoutFromIdl() takes the
// discriminator, account order and flags from it and fails loudly on any account
// it does not recognise; otherwise SELL_FISH_ACCOUNTS (the agreed spec) is used.

import { createHash } from 'node:crypto';
import { bytes, publicKey as publicKeySerializer, struct, u64, u8 } from '@metaplex-foundation/umi/serializers';

export const PROGRAMS = Object.freeze({
  mplCore: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  system: '11111111111111111111111111111111',
});

/** PDA seeds of the program (raw bytes, no length prefix). */
export const SEEDS = Object.freeze({ pearlMint: 'pearl', mintAuthority: 'mint_authority', config: 'config' });

/**
 * sell_fish accounts in program order. The spec pins seller/asset/pearl_mint/ATA
 * as mut; config and mint_authority are marked writable too, because passing a
 * read-only account the program writes fails, while the reverse is harmless.
 */
export const SELL_FISH_ACCOUNTS = Object.freeze([
  { name: 'seller', signer: true, writable: true },
  { name: 'oracle', signer: true, writable: false },
  { name: 'config', signer: false, writable: true },
  { name: 'asset', signer: false, writable: true },
  { name: 'collection', signer: false, writable: true, optional: true },
  { name: 'pearl_mint', signer: false, writable: true },
  { name: 'mint_authority', signer: false, writable: true },
  { name: 'seller_pearl_ata', signer: false, writable: true },
  { name: 'mpl_core_program', signer: false, writable: false },
  { name: 'token_program', signer: false, writable: false },
  { name: 'associated_token_program', signer: false, writable: false },
  { name: 'system_program', signer: false, writable: false },
]);

export function anchorDiscriminator(namespace, name) {
  return Uint8Array.from(createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8));
}

export const DEFAULT_LAYOUT = Object.freeze({
  discriminator: anchorDiscriminator('global', 'sell_fish'),
  accounts: SELL_FISH_ACCOUNTS,
  address: null,
});

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const KNOWN = new Map(SELL_FISH_ACCOUNTS.map((a) => [norm(a.name), a.name]));

/** Read sell_fish from an Anchor IDL (0.30+ or 0.29 format). Throws if it does not fit what we can build. */
export function layoutFromIdl(idl) {
  const ix = idl?.instructions?.find((i) => norm(i.name) === 'sellfish');
  if (!ix) throw new Error('fish_market IDL has no sell_fish instruction');
  const args = ix.args ?? [];
  if (args.length !== 1 || args[0].type !== 'u64') {
    throw new Error(`fish_market IDL: sell_fish args are ${JSON.stringify(args)}, expected one u64`);
  }
  const accounts = ix.accounts.map((a) => {
    if (a.accounts) throw new Error(`fish_market IDL: nested account group "${a.name}" is not supported`);
    const name = KNOWN.get(norm(a.name));
    if (!name) throw new Error(`fish_market IDL: unknown sell_fish account "${a.name}"`);
    return {
      name,
      signer: Boolean(a.signer ?? a.isSigner),
      writable: Boolean(a.writable ?? a.isMut),
      optional: Boolean(a.optional ?? a.isOptional),
    };
  });
  for (const must of ['seller', 'oracle', 'asset', 'pearl_mint', 'seller_pearl_ata']) {
    if (!accounts.some((a) => a.name === must)) throw new Error(`fish_market IDL: sell_fish has no "${must}" account`);
  }
  const discriminator = ix.discriminator
    ? Uint8Array.from(ix.discriminator)
    : anchorDiscriminator('global', 'sell_fish');
  return { discriminator, accounts, address: idl.address ?? idl.metadata?.address ?? null };
}

/** Instruction data: 8-byte discriminator + value as u64 little-endian. */
export function sellFishData(value, discriminator = DEFAULT_LAYOUT.discriminator) {
  const v = BigInt(value);
  if (v <= 0n || v >= 1n << 64n) throw new RangeError(`sell_fish value out of range: ${value}`);
  const data = new Uint8Array(16);
  data.set(discriminator, 0);
  new DataView(data.buffer).setBigUint64(8, v, true);
  return data;
}

/**
 * A umi-shaped Instruction ({ programId, keys, data }). `keys` maps account names
 * to base58 addresses; a missing optional account (collection) becomes the
 * program id, which is how Anchor encodes None.
 */
export function buildSellFish({ programId, keys, value, layout = DEFAULT_LAYOUT }) {
  return {
    programId,
    keys: layout.accounts.map((a) => {
      const pubkey = keys[a.name];
      if (pubkey) return { pubkey, isSigner: a.signer, isWritable: a.writable };
      if (a.optional) return { pubkey: programId, isSigner: false, isWritable: false };
      throw new Error(`sell_fish: missing account ${a.name}`);
    }),
    data: sellFishData(value, layout.discriminator),
  };
}

/** Anchor `Config { admin, oracle, pearl_mint, max_value: u64, bump: u8, mint_bump: u8 }` after its 8-byte discriminator. */
const configSerializer = struct([
  ['discriminator', bytes({ size: 8 })],
  ['admin', publicKeySerializer()],
  ['oracle', publicKeySerializer()],
  ['pearlMint', publicKeySerializer()],
  ['maxValue', u64()],
  ['bump', u8()],
  ['mintBump', u8()],
]);

export const CONFIG_DISCRIMINATOR = anchorDiscriminator('account', 'Config');

export function decodeConfig(data) {
  const [c] = configSerializer.deserialize(data);
  const disc = Uint8Array.from(c.discriminator);
  if (disc.some((b, i) => b !== CONFIG_DISCRIMINATOR[i])) throw new Error('Account is not a fish_market Config');
  return {
    admin: c.admin.toString(),
    oracle: c.oracle.toString(),
    pearlMint: c.pearlMint.toString(),
    maxValue: c.maxValue,
    bump: c.bump,
    mintBump: c.mintBump,
  };
}
