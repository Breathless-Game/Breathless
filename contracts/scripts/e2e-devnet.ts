// A real end-to-end sale on devnet, mirroring the game + market server flow:
//   1. a fresh burner wallet (the player) mints a Metaplex Core fish with the
//      game's on-chain Attributes;
//   2. the player builds sell_fish, the oracle (market server) co-signs;
//   3. the fish is burned and PEARL lands in the player's ATA.
//
//   npx tsx scripts/e2e-devnet.ts
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { mintFish, pdas } from "../tests/helpers";
import { RPC, addr, loadKeypair, programFor, tx } from "./common";

async function main() {
  const deployer = loadKeypair(".keys/deployer.json");
  const oracle = loadKeypair(".keys/oracle.json");
  const player = Keypair.generate();
  const { connection, program } = programFor(player);
  const { pearlMint } = pdas(program.programId);

  // Fund the burner like a player who hit the faucet.
  const fund = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: player.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      })
    ),
    [deployer],
    { commitment: "confirmed" }
  );
  console.log("player   ", player.publicKey.toBase58());
  console.log("fund     ", tx(fund));

  // A legendary caught in The Abyss: 150 x 2.5 = 375 pearls.
  const value = 375;
  const { asset } = await mintFish(RPC, player, {
    name: "Abyssal Sunfish",
    rarity: "legendary",
    species: "Abyssal Sunfish",
    depthM: 52,
    catchValue: value,
    seed: "e2e-" + Date.now().toString(36),
  });
  console.log("fish     ", asset.toBase58(), addr(asset));

  // Player builds the sale; the oracle (server) co-signs; the player pays fees.
  const sale = await program.methods
    .sellFish(new BN(value))
    .accounts({
      seller: player.publicKey,
      oracle: oracle.publicKey,
      asset,
      collection: null,
    })
    .transaction();
  sale.feePayer = player.publicKey;
  sale.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  sale.partialSign(oracle); // server side
  sale.partialSign(player); // client side
  const sig = await connection.sendRawTransaction(sale.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  console.log("sell_fish", tx(sig));

  const ata = getAssociatedTokenAddressSync(pearlMint, player.publicKey);
  const balance = (await getAccount(connection, ata, "confirmed")).amount;
  const fishAfter = await connection.getAccountInfo(asset, "confirmed");
  console.log("PEARL ATA", ata.toBase58(), addr(ata));
  console.log("PEARL balance", balance.toString(), "(expected", value + ")");
  console.log(
    "fish account after sale:",
    fishAfter ? `${fishAfter.data.length} byte(s), key=${fishAfter.data[0]}` : "closed"
  );
  if (balance !== BigInt(value)) throw new Error("balance mismatch");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
