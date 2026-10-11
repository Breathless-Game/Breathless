import { createSignerFromKeypair, generateSigner, publicKey, type Signer, type Umi } from '@metaplex-foundation/umi';
import { addPlugin, create, fetchAsset, update, updatePlugin } from '@metaplex-foundation/mpl-core';
import { base58 } from '@metaplex-foundation/umi/serializers';
import type { GearAttribute } from './gear-nft';
import type { GearMintRequest, GearUpdateRequest } from './gear-sync';
import { confirmedOrThrow } from './payment-safety';

// The Boat and Dive Kit NFTs on chain (gear-nft.ts has the layout, gear-sync.ts the schedule). Only
// chain.ts imports this, so Umi and mpl-core stay out of the entry bundle. Every call takes the Umi
// and the session signer explicitly: chain.ts passes the game's, and a Node script can pass its own.
//
// The session key pays, signs, and is the update authority; the Attributes plugin's authority is
// the update authority too, so the owner never signs anything here.

export interface GearCtx {
  umi: Umi;
  session: Signer;
  /** The player's wallet: it owns the NFTs. */
  owner: string;
  /** Where the metadata URIs point (nft-uri.ts nftOrigin). */
  origin: string;
}

const sig = (s: Uint8Array) => base58.deserialize(s)[0];

const sameAttributes = (a: readonly GearAttribute[], b: readonly GearAttribute[]) =>
  a.length === b.length && a.every((x, i) => x.key === b[i].key && x.value === b[i].value);

/** A fresh secret for a new asset's address (64 bytes). */
export function newGearKey(umi: Umi): Uint8Array {
  return generateSigner(umi).secretKey;
}

/**
 * Mint one gear NFT at the address of `secret`. If that address already holds an asset (the same
 * mint landed earlier and the page closed before it was recorded), adopt it: no second mint.
 */
export async function mintGear(ctx: GearCtx, req: GearMintRequest): Promise<{ asset: string; signature: string | null; uri: string }> {
  const { umi, session } = ctx;
  const asset = createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(req.secret));
  if (await umi.rpc.accountExists(asset.publicKey)) {
    const existing = await fetchAsset(umi, asset.publicKey);
    return { asset: asset.publicKey.toString(), signature: null, uri: existing.uri };
  }
  const uri = ctx.origin + req.path;
  const mintTx = create(umi, {
    asset,
    owner: publicKey(ctx.owner),
    payer: session,
    authority: session,
    updateAuthority: session.publicKey,
    name: req.name,
    uri,
    plugins: [{ type: 'Attributes', attributeList: req.attributes, authority: { type: 'UpdateAuthority' } }],
  }).setFeePayer(session);
  const signature = await confirmedOrThrow(mintTx, umi, 'Gear NFT mint');
  return { asset: asset.publicKey.toString(), signature: sig(signature), uri };
}

/**
 * Bring one gear NFT to these levels: its URI and its Attributes, in one transaction. 'ok' when it
 * already matches (nothing sent), 'missing' if the asset is gone, 'not-ours' if this session key is
 * not its update authority (minted from another browser).
 */
export async function updateGear(
  ctx: GearCtx,
  req: GearUpdateRequest,
): Promise<{ status: 'updated' | 'ok' | 'missing' | 'not-ours'; signature?: string }> {
  const { umi, session } = ctx;
  const id = publicKey(req.asset);
  if (!(await umi.rpc.accountExists(id))) return { status: 'missing' };
  const asset = await fetchAsset(umi, id);
  const ua = asset.updateAuthority;
  if (ua.type !== 'Address' || ua.address?.toString() !== session.publicKey.toString()) return { status: 'not-ours' };
  const uri = ctx.origin + req.path;
  const current = asset.attributes?.attributeList ?? null;
  const uriOk = asset.uri === uri;
  const attrsOk = current !== null && sameAttributes(current, req.attributes);
  if (uriOk && attrsOk) return { status: 'ok' };
  let tx = update(umi, { asset, uri, authority: session, payer: session });
  if (!attrsOk) {
    const plugin = { type: 'Attributes' as const, attributeList: req.attributes };
    tx = tx.add(
      current === null
        ? addPlugin(umi, { asset: id, plugin: { ...plugin, authority: { type: 'UpdateAuthority' } }, authority: session, payer: session })
        : updatePlugin(umi, { asset: id, plugin, authority: session, payer: session }),
    );
  }
  const signature = await confirmedOrThrow(tx.setFeePayer(session), umi, 'Gear NFT update');
  return { status: 'updated', signature: sig(signature) };
}

/** What the chain holds for a gear NFT (for checks and scripts). */
export async function readGear(umi: Umi, assetId: string) {
  const asset = await fetchAsset(umi, publicKey(assetId));
  return {
    owner: asset.owner.toString(),
    updateAuthority: asset.updateAuthority.address?.toString() ?? null,
    name: asset.name,
    uri: asset.uri,
    attributes: asset.attributes?.attributeList ?? [],
    attributesAuthority: asset.attributes?.authority.type ?? null,
  };
}
