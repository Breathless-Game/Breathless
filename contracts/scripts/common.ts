import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../target/idl/fish_market.json";
import type { FishMarket } from "../target/types/fish_market";

export const ROOT = path.resolve(__dirname, "..");
export const RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
export const MAX_VALUE = 30_000;

/** Reads a keypair file. Never print the result. */
export function loadKeypair(rel: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function programFor(wallet: Keypair) {
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  const program = new anchor.Program<FishMarket>(idl as FishMarket, provider);
  return { connection, provider, program };
}

export const tx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const addr = (a: PublicKey | string) =>
  `https://explorer.solana.com/address/${a.toString()}?cluster=devnet`;
