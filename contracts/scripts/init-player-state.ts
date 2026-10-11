// One-time devnet setup for player_state after `solana program deploy`:
// initialize_config(oracle, prices) with the game's price table, signed by the
// program's upgrade authority (the only key the program accepts for it).
// Idempotent: if the Config PDA already exists it only decodes and prints it.
//
//   PLAYER_STATE_ADMIN_KEYPAIR=/abs/path/player_state-deployer.json npx tsx scripts/init-player-state.ts
//   npx tsx scripts/init-player-state.ts /abs/path/player_state-deployer.json
//
// Optional env: SOLANA_RPC (default devnet), PLAYER_STATE_ORACLE, PEARL_MINT.
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "../target/idl/player_state.json";
import type { PlayerState } from "../target/types/player_state";

const RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
/** Config.oracle: the market wallet on the game server. */
const ORACLE = new PublicKey(process.env.PLAYER_STATE_ORACLE ?? "12b3GY2Pbh4HnNaLqL7GszmeFrcrfiULwfLz5HcF7gRd");
const PEARL_MINT = new PublicKey(process.env.PEARL_MINT ?? "3aX1muNxajg9VuxfigrVk2f7dGdCedJ67kUsAqCc9drp");
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/**
 * game/src/player-state.ts GAME_PRICE_TABLE, in on-chain order (slots rod..sonar,
 * recipes bait/composite, materials scale/fiber/scrap/crystal, foods plankton..glowCoral).
 * Same numbers as tests/player_state.ts; game/tests/player-state.test.mjs checks the game side.
 */
const GAME = {
  upgrade: [[0, 100, 500], [0, 120, 600], [0, 300, 1200], [0, 150, 750], [0, 180, 900], [0, 100, 500], [0, 300, 1200]],
  synthUpgrade: [[68, 329], [78, 389], [89, 499], [99, 549], [119, 699], [58, 299], [149, 899]],
  recipeCost: [38, 128],
  recipeNeeds: [[2, 1, 0, 0], [0, 2, 3, 1]],
  startingMaterials: [8, 8, 10, 3],
  foodPrice: [8, 24, 72, 216, 648],
  foodGrowthMilli: [400, 700, 1050, 1400, 1900],
  foodCooldownMilli: [1150, 1000, 900, 780, 650],
  feedCooldownMs: 15_000,
  maxGrowthMilli: 5000,
};
const bn = (n: number) => new BN(n);
const priceArg = {
  upgrade: GAME.upgrade.map((r) => r.map(bn)),
  synthUpgrade: GAME.synthUpgrade.map((r) => r.map(bn)),
  recipeCost: GAME.recipeCost.map(bn),
  recipeNeeds: GAME.recipeNeeds,
  startingMaterials: GAME.startingMaterials,
  foodPrice: GAME.foodPrice.map(bn),
  foodGrowthMilli: GAME.foodGrowthMilli,
  foodCooldownMilli: GAME.foodCooldownMilli,
  feedCooldownMs: GAME.feedCooldownMs,
  maxGrowthMilli: GAME.maxGrowthMilli,
};

/** Reads a Solana CLI keypair file. Never print the result. */
function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** BNs and PublicKeys as plain numbers/strings, for printing and comparing. */
const plain = (v: unknown): unknown =>
  BN.isBN(v) ? (v as BN).toNumber()
  : v instanceof PublicKey ? v.toBase58()
  : Array.isArray(v) ? v.map(plain)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  : v;

const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

async function main() {
  const keyFile = process.argv[2] ?? process.env.PLAYER_STATE_ADMIN_KEYPAIR;
  if (!keyFile) throw new Error("pass the upgrade-authority keypair path (argv or PLAYER_STATE_ADMIN_KEYPAIR)");
  const admin = loadKeypair(keyFile);

  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program<PlayerState>(idl as unknown as PlayerState, provider);
  const pid = program.programId;
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
  const [programData] = PublicKey.findProgramAddressSync([pid.toBuffer()], BPF_LOADER_UPGRADEABLE);

  console.log("rpc      ", RPC);
  console.log("program  ", pid.toBase58());
  console.log("admin    ", admin.publicKey.toBase58());
  console.log("config   ", config.toBase58());

  if (!(await connection.getAccountInfo(config))) {
    const mintInfo = await connection.getAccountInfo(PEARL_MINT);
    if (!mintInfo) throw new Error(`PEARL mint ${PEARL_MINT.toBase58()} not found on ${RPC}`);
    const tokenProgram = mintInfo.owner; // classic Tokenkeg or Token-2022, whichever owns the mint
    console.log("oracle   ", ORACLE.toBase58());
    console.log("mint     ", PEARL_MINT.toBase58(), "owned by", tokenProgram.toBase58());
    const sig = await program.methods
      .initializeConfig(ORACLE, priceArg)
      .accountsStrict({
        admin: admin.publicKey,
        config,
        pearlMint: PEARL_MINT,
        tokenProgram,
        program: pid,
        programData,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("initialize_config", sig);
    console.log("  ", tx(sig));
  } else {
    console.log("config already initialized");
  }

  const cfg = await program.account.config.fetch(config);
  const { reserved, prices, ...fields } = cfg;
  for (const [k, v] of Object.entries(plain(fields) as object)) console.log(k.padEnd(18), v);
  for (const [k, v] of Object.entries(plain(prices) as object)) console.log(`prices.${k}`.padEnd(25), JSON.stringify(v));
  console.log("reserved bytes", reserved.length, "all zero:", reserved.every((b: number) => b === 0));
  const pricesMatch = JSON.stringify(plain(cfg.prices)) === JSON.stringify(GAME);
  console.log("prices match the game table:", pricesMatch);
  if (!pricesMatch) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
