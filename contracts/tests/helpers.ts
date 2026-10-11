import { Keypair, PublicKey } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  create,
  createCollection,
  fetchCollection,
  mplCore,
} from "@metaplex-foundation/mpl-core";
import { generateSigner, keypairIdentity } from "@metaplex-foundation/umi";
import {
  fromWeb3JsKeypair,
  toWeb3JsPublicKey,
} from "@metaplex-foundation/umi-web3js-adapters";

export const MPL_CORE_ID = new PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
);
export const TOKEN_METADATA_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

export function pdas(programId: PublicKey) {
  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId
  );
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    programId
  );
  const [pearlMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("pearl")],
    programId
  );
  const [pearlMetadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_ID.toBuffer(), pearlMint.toBuffer()],
    TOKEN_METADATA_ID
  );
  return { config, mintAuthority, pearlMint, pearlMetadata };
}

/** A umi instance whose identity (payer + authority) is `owner`, like the game's burner wallet. */
export function umiFor(rpcUrl: string, owner: Keypair) {
  return createUmi(rpcUrl, "confirmed")
    .use(mplCore())
    .use(keypairIdentity(fromWeb3JsKeypair(owner)));
}

export interface FishTraits {
  name: string;
  rarity: string;
  species: string;
  depthM: number;
  catchValue: number;
  seed: string;
  uri?: string;
}

/**
 * Mints a Metaplex Core fish the same way game/src/chain.ts does: the owner
 * pays, and the on-chain Attributes plugin carries the fish's traits.
 */
export async function mintFish(
  rpcUrl: string,
  owner: Keypair,
  fish: FishTraits,
  collection?: PublicKey
): Promise<{ asset: PublicKey; signature: string }> {
  const umi = umiFor(rpcUrl, owner);
  const asset = generateSigner(umi);
  const { signature } = await create(umi, {
    asset,
    name: fish.name,
    uri: fish.uri ?? "https://example.com/fish.json",
    collection: collection
      ? await fetchCollection(umi, collection.toBase58())
      : undefined,
    plugins: [
      {
        type: "Attributes",
        attributeList: [
          { key: "rarity", value: fish.rarity },
          { key: "species", value: fish.species },
          { key: "depth", value: String(fish.depthM) },
          { key: "Catch value", value: String(fish.catchValue) },
          { key: "seed", value: fish.seed },
        ],
      },
    ],
  }).sendAndConfirm(umi);
  return {
    asset: toWeb3JsPublicKey(asset.publicKey),
    signature: Buffer.from(signature).toString("base64"),
  };
}

export async function mintCollection(
  rpcUrl: string,
  owner: Keypair
): Promise<PublicKey> {
  const umi = umiFor(rpcUrl, owner);
  const collection = generateSigner(umi);
  await createCollection(umi, {
    collection,
    name: "Breathless test collection",
    uri: "https://example.com/collection.json",
  }).sendAndConfirm(umi);
  return toWeb3JsPublicKey(collection.publicKey);
}
