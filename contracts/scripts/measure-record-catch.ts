// Measures the cosigned fish-mint transaction with record_catch appended, the way the server
// would build it (sensor/fish-collection.mjs cosignMint): size against the 1232-byte limit and,
// with --simulate, compute units from a devnet simulation. Read-only: nothing is signed or sent
// (the simulation skips signature checks), no key is loaded.
//
//   npx tsx scripts/measure-record-catch.ts [--simulate]
//
// The worst case: the longest URI the server accepts (MAX_URI 300 in sensor/fish-trust.mjs), a
// long name with a nine-digit serial, and a brand-new owner, so record_catch also creates Progress.
import { createNoopSigner, generateSigner, publicKey, type Umi } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { create, fetchCollection, mplCore } from "@metaplex-foundation/mpl-core";
import { toWeb3JsTransaction } from "@metaplex-foundation/umi-web3js-adapters";
import { Connection } from "@solana/web3.js";
import { buyBoat, fishSeedKey, recordCatch } from "../../game/src/player-state";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const COLLECTION = publicKey("AB2Wss9G1w246PoTWc6CQQ4pKnxQKeY1vC6MmyCYvkx5"); // /api/market/info fishCollection
const MARKET = publicKey("12b3GY2Pbh4HnNaLqL7GszmeFrcrfiULwfLz5HcF7gRd"); // collection authority = Config.oracle
// Simulation needs a fee payer with SOL; any funded wallet works since signatures are not checked.
const PAYER = publicKey(process.env.SIM_PAYER ?? "EA77L4HGz15Urk1Ycohju77Ufb1hJCa4g5z4Xfdwz9To");
const PROGRAM = "EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ";

async function build(u: Umi, withRecord: boolean) {
  const owner = generateSigner(u).publicKey; // a new player: no Progress yet
  const asset = generateSigner(u).publicKey;
  const origin = "https://breathless.gotclass.xyz";
  const path = "/api/nft/meta/v2/123456789/0badf00d/legendary/1234-1234-123-123.4/";
  const uri = (origin + path).padEnd(300 - "/abyss/x.json".length, "a") + "/abyss/x.json";
  const name = "Giant Pacific Octopus #123456789";
  const collection = await fetchCollection(u, COLLECTION);
  const payer = createNoopSigner(PAYER);
  const market = createNoopSigner(MARKET);
  let tx = create(u, {
    asset: createNoopSigner(asset),
    collection,
    owner,
    payer,
    authority: market,
    name,
    uri,
    plugins: [{ type: "Attributes", attributeList: [
      { key: "rarity", value: "legendary" },
      { key: "species", value: "Giant Pacific Octopus" },
      { key: "depth", value: "1234" },
      { key: "value", value: "1234" },
      { key: "seed", value: "0badf00d" },
    ] }],
  });
  if (withRecord) {
    const [ix] = recordCatch(u, { oracle: market, payer, owner, fish: fishSeedKey("0badf00d"), value: 1234, createsProgress: true }).getInstructions();
    tx = tx.add({ instruction: ix, signers: [market, payer], bytesCreatedOnChain: 0 });
  }
  const blockhash = await u.rpc.getLatestBlockhash({ commitment: "confirmed" });
  const built = tx.setFeePayer(payer).setBlockhash(blockhash).useLegacyVersion().build(u);
  return { built, bytes: u.transactions.serialize(built).length, uriLength: uri.length };
}

async function main() {
  const u = createUmi(RPC).use(mplCore());
  const plain = await build(u, false);
  const withRecord = await build(u, true);
  console.log(`URI ${plain.uriLength} chars`);
  console.log(`cosigned mint alone:            ${plain.bytes} bytes`);
  console.log(`mint + record_catch:            ${withRecord.bytes} bytes (limit 1232, +${withRecord.bytes - plain.bytes})`);
  if (!process.argv.includes("--simulate")) return;
  const connection = new Connection(RPC, "confirmed");
  if (process.argv.includes("--buy-boat")) {
    // buy_boat(bait, Lv2) for the e2e player wallet (contracts/DEPLOYED.md), which holds PEARL.
    const owner = createNoopSigner(publicKey(process.env.BOAT_OWNER ?? "4uKAMgmbi5dxgmZJWbrUgaEkc5nzrkGqAaFzZCVnnwkE"));
    const pearl = { pearlMint: publicKey("3aX1muNxajg9VuxfigrVk2f7dGdCedJ67kUsAqCc9drp"), tokenProgram: publicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") };
    const blockhash = await u.rpc.getLatestBlockhash({ commitment: "confirmed" });
    const built = buyBoat(u, { owner, boat: "bait", level: 2, createsProgress: true, ...pearl })
      .setFeePayer(owner).setBlockhash(blockhash).useLegacyVersion().build(u);
    const s = await connection.simulateTransaction(toWeb3JsTransaction(built), { sigVerify: false, replaceRecentBlockhash: true });
    console.log(`buy_boat simulation (${u.transactions.serialize(built).length} bytes): err=${JSON.stringify(s.value.err)} ${s.value.unitsConsumed} CU`);
    for (const l of (s.value.logs ?? []).filter((l) => l.includes("Program log:") || l.includes(" consumed "))) console.log(`  ${l}`);
  }
  const sim = await connection.simulateTransaction(toWeb3JsTransaction(withRecord.built), { sigVerify: false, replaceRecentBlockhash: true });
  const logs = sim.value.logs ?? [];
  const consumed = logs.filter((l) => / consumed \d+ of /.test(l));
  console.log(`simulation: err=${JSON.stringify(sim.value.err)} total ${sim.value.unitsConsumed} CU`);
  for (const l of consumed) console.log(`  ${l}`);
  const mine = logs.filter((l) => l.startsWith(`Program ${PROGRAM}`) || l.includes("Program log: Instruction"));
  for (const l of mine) console.log(`  ${l}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
