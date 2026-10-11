// One-time devnet setup after `solana program deploy`:
//   1. initialize(oracle, max_value)   -> config + PEARL mint
//   2. upload PEARL image + JSON to Irys (devnet), then create_pearl_metadata(uri)
// Idempotent: skips whatever already exists.
//
//   npx tsx scripts/init-devnet.ts
import * as fs from "fs";
import * as path from "path";
import { BN } from "@coral-xyz/anchor";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createGenericFile, keypairIdentity } from "@metaplex-foundation/umi";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import { pdas } from "../tests/helpers";
import { MAX_VALUE, ROOT, RPC, addr, loadKeypair, programFor, tx } from "./common";

async function main() {
  const admin = loadKeypair(".keys/deployer.json");
  const oracle = loadKeypair(".keys/oracle.json").publicKey;
  const { connection, program } = programFor(admin);
  const { config, mintAuthority, pearlMint, pearlMetadata } = pdas(program.programId);

  console.log("program  ", program.programId.toBase58());
  console.log("admin    ", admin.publicKey.toBase58());
  console.log("oracle   ", oracle.toBase58());

  if (!(await connection.getAccountInfo(config))) {
    const sig = await program.methods
      .initialize(oracle, new BN(MAX_VALUE))
      .accounts({ admin: admin.publicKey })
      .rpc();
    console.log("initialize", tx(sig));
  } else {
    console.log("config already initialized");
  }

  if (!(await connection.getAccountInfo(pearlMetadata))) {
    let uri = process.env.PEARL_URI;
    if (!uri) {
      const umi = createUmi(RPC, "confirmed")
        .use(keypairIdentity(fromWeb3JsKeypair(admin)))
        .use(irysUploader({ timeout: 60_000 }));
      const svg = fs.readFileSync(path.join(ROOT, "metadata/pearl.svg"));
      const [image] = await umi.uploader.upload([
        createGenericFile(svg, "pearl.svg", { contentType: "image/svg+xml" }),
      ]);
      uri = await umi.uploader.uploadJson({
        name: "Pearl",
        symbol: "PEARL",
        description:
          "Pearls from Breathless: earned by selling fish caught on a single held breath, spent on gear.",
        image,
        properties: { category: "image", files: [{ uri: image, type: "image/svg+xml" }] },
      });
      console.log("image    ", image);
    }
    console.log("uri      ", uri);
    const sig = await program.methods
      .createPearlMetadata(uri)
      .accounts({ admin: admin.publicKey })
      .rpc();
    console.log("create_pearl_metadata", tx(sig));
  } else {
    console.log("PEARL metadata already exists");
  }

  const cfg = await program.account.config.fetch(config);
  console.log("\nconfig        ", config.toBase58(), addr(config));
  console.log("pearl_mint    ", pearlMint.toBase58(), addr(pearlMint));
  console.log("mint_authority", mintAuthority.toBase58());
  console.log("pearl_metadata", pearlMetadata.toBase58());
  console.log("config.oracle ", cfg.oracle.toBase58());
  console.log("config.max    ", cfg.maxValue.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
