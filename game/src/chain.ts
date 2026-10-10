import './polyfills';
import {
  createGenericFile,
  generateSigner,
  publicKey,
  signerIdentity,
  sol,
  type Umi,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { burn, create, fetchAsset, mplCore } from '@metaplex-foundation/mpl-core';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { RARITY, fishValue, zoneForDepth, type FishSpec } from './fish';
import { MAPS, type MapId } from './maps';
import { fishCard } from './portrait';
import { ownerAddress, ownerSigner, sessionSigner, walletState } from './wallet';

// Everything here runs in the browser against Solana devnet. The identity is
// the player's session wallet (see wallet.ts): it pays for the Irys upload and
// the Metaplex Core mint without a prompt. The fish NFTs belong to the Phantom owner.

const RPC = (import.meta.env.VITE_SOLANA_RPC as string | undefined) ?? 'https://api.devnet.solana.com';
const SYMBOL = 'DIVE';

let umi: Umi | null = null;
let umiOwner: string | null = null;

export function getUmi(): Umi {
  const owner = walletState().owner;
  if (umi && umiOwner === owner) return umi;
  const u = createUmi(RPC, 'confirmed').use(mplCore()).use(irysUploader({ timeout: 60_000 }));
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

function dataUrlBytes(url: string): Uint8Array {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type MintStep = 'upload-image' | 'upload-metadata' | 'mint';

export interface MintResult {
  asset: string;
  signature: string;
  image: string;
  uri: string;
}

export async function mintFish(spec: FishSpec, onStep?: (s: MintStep) => void): Promise<MintResult> {
  const u = getUmi();
  const rarity = RARITY[spec.rarity].label;

  onStep?.('upload-image');
  const png = createGenericFile(dataUrlBytes(fishCard(spec)), `${spec.id}.png`, { contentType: 'image/png' });
  const [image] = await u.uploader.upload([png]);

  onStep?.('upload-metadata');
  const traits: [string, string][] = [
    ['Rarity', rarity],
    ['Species', spec.species],
    ['Zone', zoneForDepth(spec.depthM).name],
    ...(spec.map && spec.map in MAPS ? [['Map', MAPS[spec.map as MapId].name] as [string, string]] : []),
    ['Depth (m)', String(spec.depthM)],
    ['Length (cm)', String(spec.lengthCm)],
    ['Weight (kg)', String(spec.weightKg)],
    ['Catch value', String(fishValue(spec))],
    ['Seed', spec.id],
  ];
  const uri = await u.uploader.uploadJson({
    name: spec.name,
    symbol: SYMBOL,
    description: `${/^[aeiou]/i.test(rarity) ? 'An' : 'A'} ${rarity.toLowerCase()} ${spec.species} caught ${spec.depthM} m down on a single held breath in Breathless. The art is a pure function of seed ${spec.id}.`,
    image,
    attributes: traits.map(([trait_type, value]) => ({ trait_type, value })),
    properties: { category: 'image', files: [{ uri: image, type: 'image/png' }] },
  });

  onStep?.('mint');
  const asset = generateSigner(u);
  // The session key pays and holds update authority; the player owns the fish.
  const session = sessionSigner(u);
  const { signature } = await create(u, {
    asset,
    owner: publicKey(ownerAddress(u)),
    payer: session,
    authority: session,
    updateAuthority: session.publicKey,
    name: spec.name,
    uri,
    plugins: [
      {
        type: 'Attributes',
        attributeList: [
          { key: 'rarity', value: spec.rarity },
          { key: 'species', value: spec.species },
          { key: 'depth', value: String(spec.depthM) },
          { key: 'seed', value: spec.id },
        ],
      },
    ],
  })
    .setFeePayer(session)
    .sendAndConfirm(u);

  return { asset: asset.publicKey.toString(), signature: base58.deserialize(signature)[0], image, uri };
}

/** Burning is the sink: the NFT is destroyed on-chain. */
export async function burnFish(assetId: string): Promise<string> {
  const u = getUmi();
  const asset = await fetchAsset(u, publicKey(assetId));
  const { signature } = await burn(u, { asset, authority: ownerSigner(u) }).sendAndConfirm(u);
  return base58.deserialize(signature)[0];
}
