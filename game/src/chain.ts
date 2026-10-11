import './polyfills';
import { generateSigner, publicKey, signerIdentity, sol, type Umi } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { burn, create, fetchAsset, mplCore, update } from '@metaplex-foundation/mpl-core';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { zoneName } from './depth-odds';
import { ZONES, fishValue, recordedDepth, zoneForDepth, type FishSpec } from './fish';
import { MAPS, mapDepth, type MapId } from './maps';
import { cosignInfo, cosignMint, makeSellable, mintRoute, type FishTrust } from './fish-cosign';
import * as gearOps from './gear-chain';
import type { GearCtx } from './gear-chain';
import type { GearMintRequest, GearUpdateRequest } from './gear-sync';
import { fishImagePath, fishMetaPath, nftName, nftOrigin } from './nft-uri';
import { ownerAddress, ownerSigner, sessionSigner, walletState } from './wallet';

// Everything here runs in the browser against Solana devnet. The identity is
// the player's session wallet (see wallet.ts): it pays for the Metaplex Core
// mint without a prompt. The fish NFTs belong to the owner (the player's wallet).
// Metadata is not uploaded anywhere: the URI points at our own server, which
// generates the JSON and the card art from the path (sensor/nft-meta.mjs).

const RPC = (import.meta.env.VITE_SOLANA_RPC as string | undefined) ?? 'https://api.devnet.solana.com';
// Public origin of the NFT metadata host (not a secret). Unset: this page's origin, or the deployed game in dev.
const NFT_ORIGIN = nftOrigin(import.meta.env.VITE_NFT_ORIGIN as string | undefined, location);

let umi: Umi | null = null;
let umiOwner: string | null = null;

export function getUmi(): Umi {
  const owner = walletState().owner;
  if (umi && umiOwner === owner) return umi;
  const u = createUmi(RPC, 'confirmed').use(mplCore());
  u.use(signerIdentity(sessionSigner(u)));
  umi = u;
  umiOwner = owner;
  return u;
}

export const explorer = (kind: 'address' | 'tx', id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

export function walletAddress(): string {
  return getUmi().identity.publicKey.toString();
}

export async function balanceSol(): Promise<number> {
  const u = getUmi();
  const bal = await u.rpc.getBalance(u.identity.publicKey);
  return Number(bal.basisPoints) / 1e9;
}

/** Devnet faucet. Rate limited, so callers must handle failure gracefully. */
export async function airdrop(amount = 1): Promise<void> {
  const u = getUmi();
  await u.rpc.airdrop(u.identity.publicKey, sol(amount), { commitment: 'confirmed' });
}

/** The zone the HUD showed where the fish was caught: below the map's shelf that is the trench. */
function zoneLabel(spec: FishSpec): string {
  if (!spec.map || !(spec.map in MAPS)) return zoneName(spec.depthM);
  const map = MAPS[spec.map as MapId];
  if (spec.depthM >= mapDepth(map)) return 'The Trench';
  // Just above the shelf (e.g. 18–20 m on the fjord) still counts as the last open zone.
  return map.zoneLabels[Math.min(ZONES.indexOf(zoneForDepth(spec.depthM)), map.zoneLabels.length - 1)];
}

export type MintStep = 'mint';

export interface MintResult {
  asset: string;
  signature: string;
  image: string;
  uri: string;
  /** The market's fish collection, when minted into it (co-signed): the fish is sellable as is. */
  collection?: string;
}

/** The fish's metadata URI on our server. Depth and value are what the on-chain Attributes record. */
export function fishMetaUri(spec: FishSpec): string {
  // Older bank entries may predate the depth cap; the market rejects anything deeper.
  return NFT_ORIGIN + fishMetaPath(spec, { depthM: recordedDepth(spec.depthM), value: fishValue(spec), zone: zoneLabel(spec) });
}

export async function mintFish(spec: FishSpec, onStep?: (s: MintStep) => void): Promise<MintResult> {
  const u = getUmi();
  const depthM = recordedDepth(spec.depthM);
  const catchValue = fishValue(spec);
  const uri = fishMetaUri(spec);
  const image = NFT_ORIGIN + fishImagePath(spec);

  onStep?.('mint');
  // The market only buys fish in its collection, and only it can admit one (fish-cosign.ts).
  const info = await cosignInfo();
  const route = mintRoute(info);
  if (route === 'wait') throw new Error('The market is still creating its fish collection; minting resumes shortly');
  if (route === 'cosign') {
    const res = await cosignMint(u, {
      info,
      owner: ownerAddress(u),
      session: sessionSigner(u),
      fish: { id: spec.id, rarity: spec.rarity, species: spec.species, depth: depthM, value: catchValue },
      name: nftName(spec),
      uri,
    });
    return { ...res, image, uri };
  }
  // An older market (or program mode) without the collection: the session key mints on its own.
  const asset = generateSigner(u);
  // The session key pays and holds update authority; the player owns the fish.
  const session = sessionSigner(u);
  const { signature } = await create(u, {
    asset,
    owner: publicKey(ownerAddress(u)),
    payer: session,
    authority: session,
    updateAuthority: session.publicKey,
    // "Lively Striped Wrasse #0042": the queue gets the fish its number (spec.serial) first.
    name: nftName(spec),
    uri,
    plugins: [
      {
        type: 'Attributes',
        attributeList: [
          { key: 'rarity', value: spec.rarity },
          { key: 'species', value: spec.species },
          { key: 'depth', value: String(depthM) },
          // The market pays this (bounded by rarity value x 6), so a sale pays what the collection showed.
          { key: 'value', value: String(catchValue) },
          { key: 'seed', value: spec.id },
        ],
      },
    ],
  })
    .setFeePayer(session)
    .sendAndConfirm(u);

  return { asset: asset.publicKey.toString(), signature: base58.deserialize(signature)[0], image, uri };
}

export type RepairResult = 'updated' | 'ok' | 'not-ours';

/**
 * Bring an already-minted fish's on-chain name and URI up to date in one transaction: its number
 * ("… #0042", spec.serial) and our metadata host (fish minted before it pointed at Irys devnet URIs
 * that no longer resolve). Only touches assets whose update authority is this session key; costs
 * one session-paid transaction per fish.
 */
export async function repairFishUri(spec: FishSpec & { assetId: string; serial?: number }): Promise<RepairResult> {
  const u = getUmi();
  const asset = await fetchAsset(u, publicKey(spec.assetId));
  const name = nftName(spec);
  const uri = fishMetaUri(spec);
  if (asset.name === name && asset.uri === uri) return 'ok';
  const session = sessionSigner(u);
  const ua = asset.updateAuthority;
  if (ua.type !== 'Address' || ua.address?.toString() !== session.publicKey.toString()) return 'not-ours';
  await update(u, { asset, name, uri, authority: session, payer: session })
    .setFeePayer(session)
    .sendAndConfirm(u);
  return 'updated';
}

// ---- Boat and Dive Kit NFTs (gear-sync.ts schedules them, gear-chain.ts builds the transactions) ----

const gearCtx = (): GearCtx => {
  const u = getUmi();
  return { umi: u, session: sessionSigner(u), owner: ownerAddress(u), origin: NFT_ORIGIN };
};

export const newGearKey = (): Uint8Array => gearOps.newGearKey(getUmi());
export const mintGear = (req: GearMintRequest) => gearOps.mintGear(gearCtx(), req);
export const updateGear = (req: GearUpdateRequest) => gearOps.updateGear(gearCtx(), req);
export const readGear = (assetId: string) => gearOps.readGear(getUmi(), assetId);

/** Burning is the sink: the NFT is destroyed on-chain. */
export async function burnFish(assetId: string): Promise<string> {
  const u = getUmi();
  const asset = await fetchAsset(u, publicKey(assetId));
  const { signature } = await burn(u, { asset, authority: ownerSigner(u) }).sendAndConfirm(u);
  return base58.deserialize(signature)[0];
}

/**
 * Make minted fish sellable: fish minted before the market's collection are moved into it (the
 * market co-signs, the session key pays); fish this device cannot move are reported blocked.
 */
export async function makeFishSellable(assetIds: string[]): Promise<Map<string, FishTrust>> {
  const u = getUmi();
  return makeSellable(u, { info: await cosignInfo(), owner: ownerAddress(u), session: sessionSigner(u), assetIds });
}
