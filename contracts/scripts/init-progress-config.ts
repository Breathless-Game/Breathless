// player_state v2 devnet setup, after the upgrade: init_progress_config with the game's boat
// prices and the ship / map unlock thresholds, signed by Config.admin (the deployer).
// Idempotent: if the ProgressConfig exists it only decodes it, and with --set it replaces the
// rules when they differ from the game's (set_progress_config).
//
//   PLAYER_STATE_ADMIN_KEYPAIR=/abs/path/player_state-deployer.json npx tsx scripts/init-progress-config.ts [--set]
//
// Optional env: SOLANA_RPC (default devnet).
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "../target/idl/player_state.json";
import type { PlayerState } from "../target/types/player_state";

const RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";

/**
 * game/src/player-state.ts GAME_PROGRESS_RULES in on-chain order: boat pieces bait, boat,
 * boatSpeed, boatHull, boatDeck (upgrades.ts prices); ships.ts SHIPS thresholds; maps fjord,
 * tianchi (Heaven Lake), ocean (Open Ocean). Same numbers as tests/player_state.ts.
 */
const RULES = {
  boatPrices: [[0, 40, 300], [0, 120, 700], [0, 80, 500], [0, 80, 500], [0, 80, 500]],
  shipThresholds: [0, 50, 150, 500, 1200, 2500],
  mapThresholds: [0, 150, 1000],
};
const bn = (n: number) => new BN(n);
const rulesArg = {
  boatPrices: RULES.boatPrices.map((r) => r.map(bn)),
  shipThresholds: RULES.shipThresholds.map(bn),
  mapThresholds: RULES.mapThresholds.map(bn),
};

/** Reads a Solana CLI keypair file. Never print the result. */
function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const plain = (v: unknown): unknown =>
  BN.isBN(v) ? (v as BN).toNumber() : Array.isArray(v) ? v.map(plain)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

async function main() {
  const keyFile = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ?? process.env.PLAYER_STATE_ADMIN_KEYPAIR;
  if (!keyFile) throw new Error("pass the admin keypair path (argv or PLAYER_STATE_ADMIN_KEYPAIR)");
  const admin = loadKeypair(keyFile);
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed", preflightCommitment: "confirmed" });
  const program = new Program<PlayerState>(idl as unknown as PlayerState, provider);
  const pid = program.programId;
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
  const [progressConfig] = PublicKey.findProgramAddressSync([Buffer.from("progress_config")], pid);

  console.log("rpc            ", RPC);
  console.log("program        ", pid.toBase58());
  console.log("admin          ", admin.publicKey.toBase58());
  console.log("progress_config", progressConfig.toBase58());

  if (!(await connection.getAccountInfo(progressConfig))) {
    const sig = await program.methods
      .initProgressConfig(rulesArg)
      .accountsStrict({ admin: admin.publicKey, config, progressConfig, systemProgram: SystemProgram.programId })
      .rpc();
    console.log("init_progress_config", sig);
    console.log("  ", tx(sig));
  } else {
    console.log("progress_config already initialized");
  }

  let pc = await program.account.progressConfig.fetch(progressConfig);
  let match = JSON.stringify(plain(pc.rules)) === JSON.stringify(RULES);
  if (!match && process.argv.includes("--set")) {
    const sig = await program.methods.setProgressConfig(rulesArg).accountsStrict({ admin: admin.publicKey, config, progressConfig }).rpc();
    console.log("set_progress_config", sig);
    console.log("  ", tx(sig));
    pc = await program.account.progressConfig.fetch(progressConfig);
    match = JSON.stringify(plain(pc.rules)) === JSON.stringify(RULES);
  }
  console.log("version", pc.version, "bump", pc.bump, "size", (await connection.getAccountInfo(progressConfig))!.data.length);
  for (const [k, v] of Object.entries(plain(pc.rules) as object)) console.log(`rules.${k}`.padEnd(22), JSON.stringify(v));
  console.log("rules match the game:", match);
  if (!match) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
