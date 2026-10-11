// player_state tests. Run with `npm run test:player-state` (scripts/test-player-state.sh),
// which starts a local validator with the program loaded as upgradeable and the
// provider wallet as its upgrade authority.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import { randomBytes } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import idl from "../target/idl/player_state.json";
import type { PlayerState } from "../target/types/player_state";

// Slot order = DIVE_GEAR_SLOTS (game/src/equipment.ts:678).
const SLOTS = ["rod", "reel", "net", "fins", "tank", "lamp", "sonar"] as const;
const ROD = 0, NET = 2, SONAR = 6;
const BAIT = 0, COMPOSITE = 1;
const GLOW_CORAL = 4, PLANKTON = 0;

/** The game's tables (equipment.ts, synthesis.ts, fish-food.ts, aquarium-state.ts). */
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

type Table = typeof GAME;
const bn = (n: number) => new BN(n);
const priceArg = (t: Table) => ({
  upgrade: t.upgrade.map((r) => r.map(bn)),
  synthUpgrade: t.synthUpgrade.map((r) => r.map(bn)),
  recipeCost: t.recipeCost.map(bn),
  recipeNeeds: t.recipeNeeds,
  startingMaterials: t.startingMaterials,
  foodPrice: t.foodPrice.map(bn),
  foodGrowthMilli: t.foodGrowthMilli,
  foodCooldownMilli: t.foodCooldownMilli,
  feedCooldownMs: t.feedCooldownMs,
  maxGrowthMilli: t.maxGrowthMilli,
});
const clone = (t: Table): Table => JSON.parse(JSON.stringify(t));

/** Passes if `fn` throws and the error (or its logs) mentions `needle`. */
async function expectFail(fn: () => Promise<unknown>, needle: string) {
  let thrown: any = null;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `expected failure containing "${needle}"`).to.not.equal(null);
  const text = [
    String(thrown),
    thrown?.error?.errorCode?.code,
    JSON.stringify(thrown?.logs ?? thrown?.transactionLogs ?? []),
  ].join("\n");
  expect(text, text).to.include(needle);
}

describe("player_state", () => {
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(env.connection, env.wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program<PlayerState>(idl as unknown as PlayerState, provider);
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const pid = program.programId;

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
  const playerPda = (o: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("player"), o.toBuffer()], pid)[0];
  const aquariumPda = (o: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("aquarium"), o.toBuffer()], pid)[0];
  const [programData] = PublicKey.findProgramAddressSync([pid.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));

  const oracle = new PublicKey("12b3GY2Pbh4HnNaLqL7GszmeFrcrfiULwfLz5HcF7gRd");
  const alice = Keypair.generate();
  const bob = Keypair.generate(); // the poor one
  const carol = Keypair.generate(); // the fish keeper
  const session = Keypair.generate();
  const stranger = Keypair.generate();
  let pearl: PublicKey;
  let fakeMint: PublicKey;
  const ata: Record<string, PublicKey> = {};
  let fakeAta: PublicKey;

  const balance = async (who: Keypair) => Number((await getAccount(connection, ata[who.publicKey.toBase58()])).amount);
  const player = (who: Keypair) => program.account.playerState.fetch(playerPda(who.publicKey));
  const aquarium = (who: Keypair) => program.account.aquarium.fetch(aquariumPda(who.publicKey));
  const rawState = async (who: Keypair) => (await connection.getAccountInfo(playerPda(who.publicKey)))!.data.toString("hex");

  const spendAccounts = (who: Keypair, over: Partial<Record<string, PublicKey>> = {}) => ({
    owner: who.publicKey,
    config,
    player: playerPda(who.publicKey),
    pearlMint: pearl,
    ownerPearl: ata[who.publicKey.toBase58()],
    tokenProgram: TOKEN_PROGRAM_ID,
    ...over,
  });
  const buy = (who: Keypair, slot: number, over: Partial<Record<string, PublicKey>> = {}) =>
    program.methods.buyUpgrade(slot).accountsStrict(spendAccounts(who, over)).signers([who]).rpc();
  const craft = (who: Keypair, recipe: number) =>
    program.methods.craft(recipe).accountsStrict(spendAccounts(who)).signers([who]).rpc();
  const synth = (who: Keypair, slot: number) =>
    program.methods.synthUpgrade(slot).accountsStrict(spendAccounts(who)).signers([who]).rpc();
  const setPath = (owner: Keypair, signer: Keypair, slot: number, path: number) =>
    program.methods.setPath(slot, path).accountsStrict({ authority: signer.publicKey, player: playerPda(owner.publicKey) }).signers([signer]).rpc();
  const sharkBite = (owner: Keypair, signer: Keypair) =>
    program.methods.sharkBite().accountsStrict({ authority: signer.publicKey, player: playerPda(owner.publicKey) }).signers([signer]).rpc();
  const updatePrices = (t: Table, signer: Keypair = admin) =>
    program.methods.updatePrices(priceArg(t)).accountsStrict({ admin: signer.publicKey, config }).signers([signer]).rpc();
  const feed = (who: Keypair, food: number, fish: Buffer[]) =>
    feedIx(who, food, fish).rpc();
  const feedIx = (who: Keypair, food: number, fish: Buffer[]) =>
    program.methods
      .feed(food, fish.map((f) => Array.from(f)))
      .accountsStrict({
        owner: who.publicKey,
        config,
        aquarium: aquariumPda(who.publicKey),
        pearlMint: pearl,
        ownerPearl: ata[who.publicKey.toBase58()],
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([who]);
  const forget = (who: Keypair, fish: Buffer[], signer: Keypair = who) =>
    program.methods
      .forgetFish(fish.map((f) => Array.from(f)))
      .accountsStrict({ owner: signer.publicKey, aquarium: aquariumPda(who.publicKey) })
      .signers([signer])
      .rpc();
  const initPlayer = (who: Keypair, sessionKey: PublicKey) =>
    program.methods
      .initPlayer(sessionKey)
      .accountsStrict({
        owner: who.publicKey,
        config,
        player: playerPda(who.publicKey),
        aquarium: aquariumPda(who.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([who])
      .rpc();
  const initConfig = (signer: Keypair, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) =>
    program.methods
      .initializeConfig(oracle, priceArg(GAME))
      .accountsStrict({
        admin: signer.publicKey,
        config,
        pearlMint: mint,
        tokenProgram,
        program: pid,
        programData,
        systemProgram: SystemProgram.programId,
      })
      .signers([signer])
      .rpc();

  // PLAYER_STATE_WRITE_FIXTURES=1 saves real account bytes for game/tests/player-state.test.mjs.
  const snapshots: Record<string, unknown> = {};
  const snap = async (name: string, address: PublicKey, extra: Record<string, unknown> = {}) => {
    const info = await connection.getAccountInfo(address);
    snapshots[name] = { address: address.toBase58(), data: info!.data.toString("base64"), ...extra };
  };
  after(() => {
    if (process.env.PLAYER_STATE_WRITE_FIXTURES !== "1") return;
    const dir = path.join(__dirname, "../../game/tests/fixtures");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "player-state-accounts.json"), JSON.stringify({ programId: pid.toBase58(), ...snapshots }, null, 2) + "\n");
  });

  before(async () => {
    const fund = new Transaction();
    for (const kp of [alice, bob, carol, session, stranger]) {
      fund.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: kp.publicKey, lamports: 5 * LAMPORTS_PER_SOL }));
    }
    await sendAndConfirmTransaction(connection, fund, [admin]);
    // A local stand-in for PEARL: 0 decimals, like the live mint.
    pearl = await createMint(connection, admin, admin.publicKey, null, 0);
    fakeMint = await createMint(connection, admin, admin.publicKey, null, 0);
    for (const [kp, amount] of [[alice, 100_000], [bob, 50], [carol, 10_000], [stranger, 10_000]] as const) {
      const acc = await getOrCreateAssociatedTokenAccount(connection, admin, pearl, kp.publicKey);
      ata[kp.publicKey.toBase58()] = acc.address;
      await mintTo(connection, admin, pearl, acc.address, admin, amount);
    }
    fakeAta = (await getOrCreateAssociatedTokenAccount(connection, admin, fakeMint, alice.publicKey)).address;
    await mintTo(connection, admin, fakeMint, fakeAta, admin, 100_000);
  });

  describe("config", () => {
    it("rejects initialize_config from anyone but the upgrade authority", async () => {
      await expectFail(() => initConfig(stranger, pearl), "Unauthorized");
    });

    it("rejects a mint that the token program does not own", async () => {
      await expectFail(() => initConfig(admin, pearl, TOKEN_2022_PROGRAM_ID), "WrongTokenProgram");
    });

    it("the upgrade authority initializes it with the game's prices", async () => {
      await initConfig(admin, pearl);
      const cfg = await program.account.config.fetch(config);
      expect(cfg.admin.toBase58()).to.equal(admin.publicKey.toBase58());
      expect(cfg.oracle.toBase58()).to.equal(oracle.toBase58());
      expect(cfg.pearlMint.toBase58()).to.equal(pearl.toBase58());
      expect(cfg.tokenProgram.toBase58()).to.equal(TOKEN_PROGRAM_ID.toBase58());
      expect(cfg.prices.upgrade.map((r: BN[]) => r.map(Number))).to.deep.equal(GAME.upgrade);
      expect(cfg.prices.foodCooldownMilli).to.deep.equal(GAME.foodCooldownMilli);
      expect((await connection.getAccountInfo(config))!.data.length).to.equal(612);
      await expectFail(() => initConfig(admin, pearl), "already in use");
      await snap("config", config, { admin: admin.publicKey.toBase58(), oracle: oracle.toBase58(), pearlMint: pearl.toBase58() });
    });

    it("update_prices and set_oracle are admin only, and update_prices validates", async () => {
      await expectFail(() => updatePrices(GAME, stranger), "Unauthorized");
      await expectFail(
        () => program.methods.setOracle(stranger.publicKey).accountsStrict({ admin: stranger.publicKey, config }).signers([stranger]).rpc(),
        "Unauthorized"
      );
      const bad = clone(GAME);
      bad.upgrade[ROD][0] = 5;
      await expectFail(() => updatePrices(bad), "InvalidPriceTable");
      const zero = clone(GAME);
      zero.foodPrice[0] = 0;
      await expectFail(() => updatePrices(zero), "InvalidPriceTable");
      const other = Keypair.generate().publicKey;
      await program.methods.setOracle(other).accountsStrict({ admin: admin.publicKey, config }).rpc();
      expect((await program.account.config.fetch(config)).oracle.toBase58()).to.equal(other.toBase58());
      await program.methods.setOracle(oracle).accountsStrict({ admin: admin.publicKey, config }).rpc();
    });
  });

  describe("init_player / set_session", () => {
    it("starts everyone from zero with the default materials", async () => {
      await initPlayer(alice, session.publicKey);
      const p = await player(alice);
      expect(p.owner.toBase58()).to.equal(alice.publicKey.toBase58());
      expect(p.session.toBase58()).to.equal(session.publicKey.toBase58());
      expect(p.levels).to.deep.equal([1, 1, 1, 1, 1, 1, 1]);
      expect(p.paths).to.deep.equal([0, 0, 0, 0, 0, 0]);
      expect(p.materials).to.deep.equal([8, 8, 10, 3]);
      expect(p.crafted).to.deep.equal([0, 0]);
      expect(p.bestValue.toNumber()).to.equal(0);
      expect(p.version).to.equal(1);
      expect((await connection.getAccountInfo(playerPda(alice.publicKey)))!.data.length).to.equal(249);
      const aq = await aquarium(alice);
      expect(aq.entries).to.deep.equal([]);
      expect((await connection.getAccountInfo(aquariumPda(alice.publicKey)))!.data.length).to.equal(62);
      await initPlayer(bob, PublicKey.default);
      await initPlayer(carol, PublicKey.default);
    });

    it("cannot init twice", async () => {
      await expectFail(() => initPlayer(alice, session.publicKey), "already in use");
    });

    it("set_session is owner only", async () => {
      await expectFail(
        () => program.methods.setSession(stranger.publicKey).accountsStrict({ owner: stranger.publicKey, player: playerPda(alice.publicKey) }).signers([stranger]).rpc(),
        "ConstraintSeeds"
      );
      const temp = Keypair.generate().publicKey;
      await program.methods.setSession(temp).accountsStrict({ owner: alice.publicKey, player: playerPda(alice.publicKey) }).signers([alice]).rpc();
      expect((await player(alice)).session.toBase58()).to.equal(temp.toBase58());
      await program.methods.setSession(session.publicKey).accountsStrict({ owner: alice.publicKey, player: playerPda(alice.publicKey) }).signers([alice]).rpc();
    });
  });

  describe("buy_upgrade", () => {
    it("burns exactly the config price at each level boundary, for every slot", async () => {
      for (let slot = 0; slot < SLOTS.length; slot++) {
        for (const level of [2, 3]) {
          const before = await balance(alice);
          await buy(alice, slot);
          expect(before - (await balance(alice)), `${SLOTS[slot]} Lv${level}`).to.equal(GAME.upgrade[slot][level - 1]);
          expect((await player(alice)).levels[slot]).to.equal(level);
        }
        const before = await balance(alice);
        await expectFail(() => buy(alice, slot), "MaxLevel");
        expect(await balance(alice)).to.equal(before);
      }
      await expectFail(() => buy(alice, 7), "InvalidSlot");
    });

    it("emits UpgradeBought", async () => {
      await sharkBite(alice, alice);
      const sig = await program.methods.buyUpgrade(NET).accountsStrict(spendAccounts(alice)).signers([alice]).rpc({ commitment: "confirmed" });
      const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const events = [...new anchor.EventParser(pid, program.coder).parseLogs(tx!.meta!.logMessages!)];
      expect(events.map((e) => e.name)).to.deep.equal(["upgradeBought"]);
      expect(events[0].data.level).to.equal(2);
      expect(Number(events[0].data.price)).to.equal(300);
    });

    it("fails without enough PEARL and changes nothing", async () => {
      const state = await rawState(bob);
      const before = await balance(bob);
      await expectFail(() => buy(bob, NET), "InsufficientPearl");
      expect(await rawState(bob)).to.equal(state);
      expect(await balance(bob)).to.equal(before);
    });

    it("rejects the wrong mint, someone else's token account and the wrong token program", async () => {
      const state = await rawState(alice);
      await expectFail(() => buy(alice, ROD, { pearlMint: fakeMint, ownerPearl: fakeAta }), "WrongMint");
      await expectFail(() => buy(alice, ROD, { ownerPearl: fakeAta }), "WrongMint");
      await expectFail(() => buy(alice, ROD, { ownerPearl: ata[carol.publicKey.toBase58()] }), "WrongTokenOwner");
      await expectFail(() => buy(alice, ROD, { tokenProgram: TOKEN_2022_PROGRAM_ID }), "WrongTokenProgram");
      // Someone else's player account with the signer's tokens.
      await expectFail(() => buy(alice, ROD, { player: playerPda(carol.publicKey) }), "ConstraintSeeds");
      expect(await rawState(alice)).to.equal(state);
    });

    it("burns the new price after update_prices", async () => {
      const t = clone(GAME);
      t.upgrade[ROD][1] = 7;
      await updatePrices(t);
      const before = await balance(alice);
      await buy(alice, ROD);
      expect(before - (await balance(alice))).to.equal(7);
      await updatePrices(GAME);
    });
  });

  describe("set_path", () => {
    it("is locked below Lv2, absent on the sonar, and bounded to two paths", async () => {
      await expectFail(() => setPath(alice, alice, 1, 1), "PathLocked"); // reel is Lv1 after the bite
      await expectFail(() => setPath(alice, alice, SONAR, 0), "NoPathsForSlot");
      await expectFail(() => setPath(alice, alice, ROD, 2), "InvalidPath");
    });

    it("switches freely at Lv2+, by the owner or the session key, never a stranger", async () => {
      await setPath(alice, alice, ROD, 1);
      expect((await player(alice)).paths[ROD]).to.equal(1);
      await setPath(alice, session, ROD, 0);
      expect((await player(alice)).paths[ROD]).to.equal(0);
      await setPath(alice, alice, NET, 1);
      await expectFail(() => setPath(alice, stranger, NET, 0), "Unauthorized");
      expect((await player(alice)).paths[NET]).to.equal(1);
    });
  });

  describe("shark_bite", () => {
    it("rejects a stranger", async () => {
      const state = await rawState(alice);
      await expectFail(() => sharkBite(alice, stranger), "Unauthorized");
      expect(await rawState(alice)).to.equal(state);
    });

    it("the session key resets every level and path but nothing else", async () => {
      await craft(alice, BAIT);
      const before = await player(alice);
      const pearls = await balance(alice);
      expect(before.levels.some((l: number) => l > 1)).to.equal(true);
      await sharkBite(alice, session);
      const after = await player(alice);
      expect(after.levels).to.deep.equal([1, 1, 1, 1, 1, 1, 1]);
      expect(after.paths).to.deep.equal([0, 0, 0, 0, 0, 0]);
      expect(after.materials).to.deep.equal(before.materials);
      expect(after.crafted).to.deep.equal(before.crafted);
      expect(await balance(alice)).to.equal(pearls);
    });

    it("a cleared session key can no longer sign", async () => {
      await program.methods.setSession(PublicKey.default).accountsStrict({ owner: alice.publicKey, player: playerPda(alice.publicKey) }).signers([alice]).rpc();
      await expectFail(() => sharkBite(alice, session), "Unauthorized");
      await sharkBite(alice, alice);
      await program.methods.setSession(session.publicKey).accountsStrict({ owner: alice.publicKey, player: playerPda(alice.publicKey) }).signers([alice]).rpc();
    });
  });

  describe("craft / synth_upgrade", () => {
    it("crafts with the recipe's materials and price", async () => {
      const p0 = await player(carol);
      let before = await balance(carol);
      await craft(carol, BAIT);
      expect(before - (await balance(carol))).to.equal(38);
      let p = await player(carol);
      expect(p.materials).to.deep.equal([6, 7, 10, 3]);
      expect(p.crafted).to.deep.equal([1, 0]);
      before = await balance(carol);
      await craft(carol, COMPOSITE);
      expect(before - (await balance(carol))).to.equal(128);
      p = await player(carol);
      expect(p.materials).to.deep.equal([6, 5, 7, 2]);
      expect(p.crafted).to.deep.equal([1, 1]);
      expect(p0.levels).to.deep.equal(p.levels);
      await expectFail(() => craft(carol, 2), "InvalidRecipe");
    });

    it("refuses a craft with missing materials and burns nothing", async () => {
      await craft(carol, COMPOSITE); // scrap 7 -> 4, crystal 2 -> 1
      await craft(carol, COMPOSITE); // scrap 4 -> 1, crystal 1 -> 0
      const state = await rawState(carol);
      const before = await balance(carol);
      await expectFail(() => craft(carol, COMPOSITE), "MissingMaterials");
      expect(await balance(carol)).to.equal(before);
      expect(await rawState(carol)).to.equal(state);
    });

    it("synth_upgrade spends one composite and the station fee per level", async () => {
      expect((await player(carol)).crafted[COMPOSITE]).to.equal(3);
      let before = await balance(carol);
      await synth(carol, SONAR);
      expect(before - (await balance(carol))).to.equal(149);
      before = await balance(carol);
      await synth(carol, SONAR);
      expect(before - (await balance(carol))).to.equal(899);
      let p = await player(carol);
      expect(p.levels[SONAR]).to.equal(3);
      expect(p.crafted[COMPOSITE]).to.equal(1);
      await expectFail(() => synth(carol, SONAR), "MaxLevel");
      await synth(carol, ROD);
      p = await player(carol);
      expect(p.levels[ROD]).to.equal(2);
      expect(p.crafted[COMPOSITE]).to.equal(0);
      before = await balance(carol);
      await expectFail(() => synth(carol, ROD), "NoComposite");
      expect(await balance(carol)).to.equal(before);
      await snap("player", playerPda(carol.publicKey), { owner: carol.publicKey.toBase58() });
    });
  });

  describe("feed / forget_fish", () => {
    const fishA = randomBytes(8);
    const fishB = randomBytes(8);

    it("burns the food's price once per pour and grows every listed fish", async () => {
      const before = await balance(carol);
      await feed(carol, PLANKTON, [fishA, fishB]);
      expect(before - (await balance(carol))).to.equal(8);
      const aq = await aquarium(carol);
      expect(aq.entries.length).to.equal(2);
      for (const e of aq.entries) {
        expect(e.growthMilli).to.equal(400);
        expect(e.feedCount).to.equal(1);
        expect(e.food).to.equal(PLANKTON);
        expect(e.lastFed).to.be.greaterThan(0);
      }
      // Sorted by key.
      const keys = aq.entries.map((e: any) => Buffer.from(e.key).toString("hex"));
      expect(keys).to.deep.equal([...keys].sort());
    });

    it("enforces the cooldown: a full school fails and burns nothing", async () => {
      const before = await balance(carol);
      await expectFail(() => feed(carol, GLOW_CORAL, [fishA, fishB]), "FeedCooldown");
      expect(await balance(carol)).to.equal(before);
    });

    it("feeds only the fish that can eat, still for one price", async () => {
      const fishC = randomBytes(8);
      const before = await balance(carol);
      await feed(carol, GLOW_CORAL, [fishA, fishC]);
      expect(before - (await balance(carol))).to.equal(648);
      const aq = await aquarium(carol);
      const byKey = new Map(aq.entries.map((e: any) => [Buffer.from(e.key).toString("hex"), e]));
      expect((byKey.get(fishA.toString("hex")) as any).growthMilli).to.equal(400);
      expect((byKey.get(fishC.toString("hex")) as any).growthMilli).to.equal(1900);
      await snap("aquarium", aquariumPda(carol.publicKey), {
        owner: carol.publicKey.toBase58(),
        growth: Object.fromEntries([fishA, fishB, fishC].map((k) => [k.toString("hex"), (byKey.get(k.toString("hex")) as any).growthMilli])),
      });
    });

    it("lets a fish eat again once the cooldown has passed", async () => {
      const t = clone(GAME);
      t.feedCooldownMs = 1000; // plankton's x1.15 makes it 1.15 s
      await updatePrices(t);
      await new Promise((r) => setTimeout(r, 2500));
      await feed(carol, PLANKTON, [fishA]);
      const e = (await aquarium(carol)).entries.find((x: any) => Buffer.from(x.key).equals(fishA));
      expect(e.growthMilli).to.equal(800);
      expect(e.feedCount).to.equal(2);
    });

    it("caps growth and refuses fully grown fish without burning", async () => {
      const t = clone(GAME);
      t.feedCooldownMs = 0;
      await updatePrices(t);
      const fishD = randomBytes(8);
      for (const want of [1900, 3800, 5000]) {
        await feed(carol, GLOW_CORAL, [fishD]);
        const e = (await aquarium(carol)).entries.find((x: any) => Buffer.from(x.key).equals(fishD));
        expect(e.growthMilli).to.equal(want);
      }
      const before = await balance(carol);
      await expectFail(() => feed(carol, GLOW_CORAL, [fishD]), "FullyGrown");
      expect(await balance(carol)).to.equal(before);
      await updatePrices(GAME);
    });

    it("grows the account by a full tank of 50 fish per transaction, up to 5 tanks (owner pays rent)", async () => {
      const pda = aquariumPda(carol.publicKey);
      const n0 = (await aquarium(carol)).entries.length;
      for (let t = 1; t <= 5; t++) {
        const tank = Array.from({ length: 50 }, () => randomBytes(8));
        const sig = await feedIx(carol, PLANKTON, tank).rpc({ commitment: "confirmed" });
        const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        const cu = tx!.meta!.computeUnitsConsumed!;
        console.log(`      feed of 50 new fish into ${n0 + 50 * (t - 1)} entries: ${cu} CU, tx ${tx!.transaction.message.serialize().length + 64} bytes`);
        expect(cu).to.be.below(200_000);
      }
      const info = (await connection.getAccountInfo(pda))!;
      expect((await aquarium(carol)).entries.length).to.equal(n0 + 250);
      expect(info.data.length).to.equal(62 + (n0 + 250) * 16);
      expect(info.lamports).to.be.at.least(await connection.getMinimumBalanceForRentExemption(info.data.length));
      await expectFail(() => feed(carol, PLANKTON, Array.from({ length: 65 }, () => randomBytes(8))), "");
      await expectFail(() => feed(carol, 5, [randomBytes(8)]), "InvalidFood");
    });

    it("forget_fish drops entries, shrinks the account and refunds the owner; owner only", async () => {
      const pda = aquariumPda(carol.publicKey);
      await expectFail(() => forget(carol, [fishA], stranger), "ConstraintSeeds");
      const n0 = (await aquarium(carol)).entries.length;
      const lamports0 = (await connection.getAccountInfo(pda))!.lamports;
      await forget(carol, [fishA, fishB, randomBytes(8)]);
      const info = (await connection.getAccountInfo(pda))!;
      expect((await aquarium(carol)).entries.length).to.equal(n0 - 2);
      expect(info.data.length).to.equal(62 + (n0 - 2) * 16);
      expect(info.lamports).to.equal(await connection.getMinimumBalanceForRentExemption(info.data.length));
      expect(lamports0 - info.lamports).to.equal(2 * 16 * 6960);
    });
  });

  // ------------------------------------------------------------------ v2

  describe("v2: progress (boats, ships, lifetime banked value)", () => {
    // BOAT_IDS (game/src/gear-nft.ts) and their prices (upgrades.ts); SHIPS thresholds (ships.ts);
    // map unlocks fjord / tianchi / ocean (maps.ts, before "Open every map from the start").
    const BOAT_SLOT = { bait: 0, boat: 1, boatSpeed: 2, boatHull: 3, boatDeck: 4 };
    const RULES = {
      boatPrices: [[0, 40, 300], [0, 120, 700], [0, 80, 500], [0, 80, 500], [0, 80, 500]],
      shipThresholds: [0, 50, 150, 500, 1200, 2500],
      mapThresholds: [0, 150, 1000],
    };
    type Rules = typeof RULES;
    const rulesArg = (r: Rules) => ({
      boatPrices: r.boatPrices.map((row) => row.map(bn)),
      shipThresholds: r.shipThresholds.map(bn),
      mapThresholds: r.mapThresholds.map(bn),
    });
    const cloneRules = (r: Rules): Rules => JSON.parse(JSON.stringify(r));
    const HEADER = 100;

    const [progressConfig] = PublicKey.findProgramAddressSync([Buffer.from("progress_config")], pid);
    const progressPda = (o: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("progress"), o.toBuffer()], pid)[0];
    const progress = (who: Keypair | PublicKey) =>
      program.account.progress.fetch(progressPda(who instanceof Keypair ? who.publicKey : who));
    const catchLog = async (who: PublicKey) => {
      const data = (await connection.getAccountInfo(progressPda(who)))!.data;
      const out: bigint[] = [];
      for (let o = HEADER; o < data.length; o += 8) out.push(data.readBigUInt64LE(o));
      return out;
    };

    const testOracle = Keypair.generate(); // stands in for the market wallet
    const dave = Keypair.generate(); // mints fish before ever creating a PlayerState
    const daveSession = Keypair.generate(); // the game's session key: fee payer of the mint tx
    const erin = Keypair.generate(); // someone pre-funds her Progress address

    const initRules = (r: Rules, signer: Keypair = admin) =>
      program.methods
        .initProgressConfig(rulesArg(r))
        .accountsStrict({ admin: signer.publicKey, config, progressConfig, systemProgram: SystemProgram.programId })
        .signers([signer])
        .rpc();
    const setRules = (r: Rules, signer: Keypair = admin) =>
      program.methods.setProgressConfig(rulesArg(r)).accountsStrict({ admin: signer.publicKey, config, progressConfig }).signers([signer]).rpc();
    const recordIx = (owner: PublicKey, fish: bigint | number, value: number, o: { oracle?: Keypair; payer?: Keypair; progress?: PublicKey } = {}) =>
      program.methods
        .recordCatch(new BN(fish.toString()), bn(value))
        .accountsStrict({
          oracle: (o.oracle ?? testOracle).publicKey,
          payer: (o.payer ?? daveSession).publicKey,
          config,
          owner,
          progress: o.progress ?? progressPda(owner),
          systemProgram: SystemProgram.programId,
        });
    const record = (owner: PublicKey, fish: bigint | number, value: number, o: { oracle?: Keypair; payer?: Keypair; progress?: PublicKey } = {}) => {
      const signers = [o.oracle ?? testOracle, o.payer ?? daveSession];
      return recordIx(owner, fish, value, o).signers(signers).rpc();
    };
    const boatAccounts = (who: Keypair, over: Partial<Record<string, PublicKey>> = {}) => ({
      owner: who.publicKey,
      config,
      progressConfig,
      progress: progressPda(who.publicKey),
      pearlMint: pearl,
      ownerPearl: ata[who.publicKey.toBase58()],
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      ...over,
    });
    const buyBoat = (who: Keypair, slot: number, level: number, over: Partial<Record<string, PublicKey>> = {}, signer: Keypair = who) =>
      program.methods.buyBoat(slot, level).accountsStrict(boatAccounts(who, over)).signers([signer]).rpc();
    const setShip = (who: Keypair, ship: number, signer: Keypair = who, owner: PublicKey = who.publicKey) =>
      program.methods.setShip(ship).accountsStrict({ owner, progressConfig, progress: progressPda(who.publicKey) }).signers([signer]).rpc();

    // Raw v1 accounts before any v2 instruction runs: v2 must never touch them.
    let v1Before: Record<string, string> = {};
    const v1Accounts = () => ({ config, alicePlayer: playerPda(alice.publicKey), aliceAquarium: aquariumPda(alice.publicKey), carolAquarium: aquariumPda(carol.publicKey) });
    const rawAll = async () => {
      const out: Record<string, string> = {};
      for (const [k, a] of Object.entries(v1Accounts())) out[k] = (await connection.getAccountInfo(a))!.data.toString("hex");
      return out;
    };

    before(async () => {
      const fund = new Transaction();
      for (const kp of [testOracle, dave, daveSession, erin]) {
        fund.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: kp.publicKey, lamports: 2 * LAMPORTS_PER_SOL }));
      }
      await sendAndConfirmTransaction(connection, fund, [admin]);
      for (const [kp, amount] of [[dave, 5_000], [erin, 1_000]] as const) {
        const acc = await getOrCreateAssociatedTokenAccount(connection, admin, pearl, kp.publicKey);
        ata[kp.publicKey.toBase58()] = acc.address;
        await mintTo(connection, admin, pearl, acc.address, admin, amount);
      }
      v1Before = await rawAll();
      await program.methods.setOracle(testOracle.publicKey).accountsStrict({ admin: admin.publicKey, config }).rpc();
    });

    after(async () => {
      await program.methods.setOracle(oracle).accountsStrict({ admin: admin.publicKey, config }).rpc();
    });

    describe("progress_config", () => {
      it("init is Config-admin only and validates the rules", async () => {
        await expectFail(() => initRules(RULES, stranger), "Unauthorized");
        const freeLv2 = cloneRules(RULES);
        freeLv2.boatPrices[BOAT_SLOT.boat][1] = 0;
        await expectFail(() => initRules(freeLv2), "InvalidProgressRules");
        const paidLv1 = cloneRules(RULES);
        paidLv1.boatPrices[BOAT_SLOT.bait][0] = 1;
        await expectFail(() => initRules(paidLv1), "InvalidProgressRules");
        const lockedStarter = cloneRules(RULES);
        lockedStarter.shipThresholds[0] = 10;
        await expectFail(() => initRules(lockedStarter), "InvalidProgressRules");
        const decreasing = cloneRules(RULES);
        decreasing.mapThresholds = [0, 1000, 150];
        await expectFail(() => initRules(decreasing), "InvalidProgressRules");
      });

      it("the admin creates it with the game's boat prices and unlock thresholds", async () => {
        await initRules(RULES);
        const pc = await program.account.progressConfig.fetch(progressConfig);
        expect(pc.version).to.equal(1);
        expect(pc.rules.boatPrices.map((r: BN[]) => r.map(Number))).to.deep.equal(RULES.boatPrices);
        expect(pc.rules.shipThresholds.map(Number)).to.deep.equal(RULES.shipThresholds);
        expect(pc.rules.mapThresholds.map(Number)).to.deep.equal(RULES.mapThresholds);
        expect((await connection.getAccountInfo(progressConfig))!.data.length).to.equal(8 + 2 + 15 * 8 + 6 * 8 + 3 * 8 + 64);
        await expectFail(() => initRules(RULES), "already in use");
      });

      it("set_progress_config is admin only and validates", async () => {
        await expectFail(() => setRules(RULES, stranger), "Unauthorized");
        const bad = cloneRules(RULES);
        bad.boatPrices[BOAT_SLOT.boatDeck][2] = 0;
        await expectFail(() => setRules(bad), "InvalidProgressRules");
        const other = cloneRules(RULES);
        other.mapThresholds = [0, 10, 20];
        await setRules(other);
        expect((await program.account.progressConfig.fetch(progressConfig)).rules.mapThresholds.map(Number)).to.deep.equal([0, 10, 20]);
        await setRules(RULES);
      });
    });

    describe("record_catch", () => {
      it("rejects any signer but Config.oracle", async () => {
        await expectFail(() => record(dave.publicKey, 1, 10, { oracle: stranger }), "Unauthorized");
        await expectFail(() => record(dave.publicKey, 1, 10, { oracle: dave, payer: dave }), "Unauthorized");
        expect(await connection.getAccountInfo(progressPda(dave.publicKey))).to.equal(null);
      });

      it("works before the owner has a PlayerState: creates Progress, the payer funds the rent", async () => {
        expect(await connection.getAccountInfo(playerPda(dave.publicKey))).to.equal(null);
        const payer0 = await connection.getBalance(daveSession.publicKey);
        const sig = await record(dave.publicKey, 0x0badf00d, 60);
        const p = await progress(dave);
        expect(p.owner.toBase58()).to.equal(dave.publicKey.toBase58());
        expect(p.version).to.equal(1);
        expect(Number(p.lifetimeValue)).to.equal(60);
        expect(Number(p.bestValue)).to.equal(60);
        expect(p.catches).to.equal(1);
        expect(p.boatLevels).to.deep.equal([1, 1, 1, 1, 1]);
        expect(p.ship).to.equal(0);
        const info = (await connection.getAccountInfo(progressPda(dave.publicKey)))!;
        expect(info.data.length).to.equal(HEADER + 8);
        expect(info.lamports).to.equal(await connection.getMinimumBalanceForRentExemption(HEADER + 8));
        // The provider wallet paid the fee here; daveSession paid exactly the rent.
        expect(payer0 - (await connection.getBalance(daveSession.publicKey))).to.equal(info.lamports);
        expect(await catchLog(dave.publicKey)).to.deep.equal([0x0badf00dn]);
        expect(await connection.getAccountInfo(playerPda(dave.publicKey))).to.equal(null);
        const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        console.log(`      record_catch creating Progress: ${tx!.meta!.computeUnitsConsumed} CU`);
      });

      it("a duplicate fish is a successful no-op: nothing double-counts, no rent is taken", async () => {
        const before = (await connection.getAccountInfo(progressPda(dave.publicKey)))!;
        const payer0 = await connection.getBalance(daveSession.publicKey);
        await record(dave.publicKey, 0x0badf00d, 60);
        await record(dave.publicKey, 0x0badf00d, 9_999); // a forged retry with another value changes nothing either
        const after = (await connection.getAccountInfo(progressPda(dave.publicKey)))!;
        expect(after.data.toString("hex")).to.equal(before.data.toString("hex"));
        expect(after.lamports).to.equal(before.lamports);
        expect(await connection.getBalance(daveSession.publicKey)).to.equal(payer0);
        // The same fish twice in one transaction counts once too.
        const tx = new Transaction()
          .add(await recordIx(dave.publicKey, 7, 5).instruction())
          .add(await recordIx(dave.publicKey, 7, 5).instruction());
        await sendAndConfirmTransaction(connection, tx, [admin, testOracle, daveSession]);
        const p = await progress(dave);
        expect(Number(p.lifetimeValue)).to.equal(65);
        expect(p.catches).to.equal(2);
      });

      it("adds every new fish, keeps the best and a sorted log; lifetime value only grows", async () => {
        const keys = [0xffffffffn, 0n, 0x12345678n, 3n, 0xdeadbeefn, (1n << 64n) - 1n, 0x0a11ce00n];
        const values = [10, 0, 250, 1, 40, 3, 7];
        let lifetime = 65;
        for (let i = 0; i < keys.length; i++) {
          await record(dave.publicKey, keys[i], values[i]);
          lifetime += values[i];
          const p = await progress(dave);
          expect(Number(p.lifetimeValue)).to.equal(lifetime);
        }
        const p = await progress(dave);
        expect(Number(p.bestValue)).to.equal(250);
        expect(p.catches).to.equal(9);
        const log = await catchLog(dave.publicKey);
        expect(log.length).to.equal(9);
        expect(log).to.deep.equal([...log].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
        expect(log).to.include.members([7n, 0x0badf00dn, ...keys]);
      });

      it("the oracle may pay for itself (a standalone backfill), and a pre-funded address still works", async () => {
        const pda = progressPda(erin.publicKey);
        // A system account must be rent exempt, so the smallest griefing deposit is the 0-byte minimum.
        const lamports = await connection.getMinimumBalanceForRentExemption(0);
        await sendAndConfirmTransaction(
          connection,
          new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: pda, lamports })),
          [admin]
        );
        await record(erin.publicKey, 42, 30, { payer: testOracle });
        const info = (await connection.getAccountInfo(pda))!;
        expect(info.owner.toBase58()).to.equal(pid.toBase58());
        expect(info.lamports).to.equal(await connection.getMinimumBalanceForRentExemption(HEADER + 8));
        expect(Number((await progress(erin)).lifetimeValue)).to.equal(30);
      });

      it("rejects another owner's Progress account", async () => {
        await expectFail(() => record(dave.publicKey, 99, 1, { progress: progressPda(erin.publicKey) }), "ConstraintSeeds");
      });

      it("stays cheap as the log grows (10 catches per transaction)", async () => {
        let last = 0;
        for (let t = 0; t < 5; t++) {
          const tx = new Transaction();
          for (let i = 0; i < 10; i++) tx.add(await recordIx(dave.publicKey, BigInt("0x" + randomBytes(4).toString("hex")) + 0x1_0000_0000n, 1).instruction());
          const sig = await sendAndConfirmTransaction(connection, tx, [admin, testOracle, daveSession], { commitment: "confirmed" });
          last = (await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.computeUnitsConsumed!;
        }
        const p = await progress(dave);
        console.log(`      10 x record_catch into a ${p.catches - 10}-fish log: ${last} CU (${Math.round(last / 10)} per catch)`);
        expect(last / 10).to.be.below(20_000);
        expect((await connection.getAccountInfo(progressPda(dave.publicKey)))!.data.length).to.equal(HEADER + 8 * p.catches);
      });
    });

    describe("buy_boat", () => {
      it("burns the ProgressConfig price for exactly the next level, creating Progress on first use", async () => {
        expect(await connection.getAccountInfo(progressPda(alice.publicKey))).to.equal(null);
        let pearls = await balance(alice);
        for (const [name, slot] of Object.entries(BOAT_SLOT)) {
          for (const level of [2, 3]) {
            await buyBoat(alice, slot, level);
            pearls -= RULES.boatPrices[slot][level - 1];
            expect(await balance(alice), `${name} Lv${level}`).to.equal(pearls);
            expect((await progress(alice)).boatLevels[slot]).to.equal(level);
          }
        }
        const p = await progress(alice);
        expect(p.boatLevels).to.deep.equal([3, 3, 3, 3, 3]);
        expect(Number(p.lifetimeValue)).to.equal(0);
        expect((await connection.getAccountInfo(progressPda(alice.publicKey)))!.data.length).to.equal(HEADER);
      });

      it("rejects going above the max", async () => {
        await expectFail(() => buyBoat(alice, BOAT_SLOT.bait, 4), "MaxLevel");
        await expectFail(() => buyBoat(alice, BOAT_SLOT.bait, 3), "MaxLevel");
      });

      it("rejects skipping a level or re-buying the current one", async () => {
        const before = await balance(dave);
        await expectFail(() => buyBoat(dave, BOAT_SLOT.boat, 3), "NotNextLevel");
        await expectFail(() => buyBoat(dave, BOAT_SLOT.boat, 1), "NotNextLevel");
        await expectFail(() => buyBoat(dave, BOAT_SLOT.boat, 0), "NotNextLevel");
        await buyBoat(dave, BOAT_SLOT.boat, 2);
        await expectFail(() => buyBoat(dave, BOAT_SLOT.boat, 2), "NotNextLevel");
        expect(await balance(dave)).to.equal(before - 120);
      });

      it("keeps the catch log and lifetime value intact", async () => {
        const p0 = await progress(dave);
        const log0 = await catchLog(dave.publicKey);
        await buyBoat(dave, BOAT_SLOT.bait, 2);
        const p = await progress(dave);
        expect(Number(p.lifetimeValue)).to.equal(Number(p0.lifetimeValue));
        expect(p.catches).to.equal(p0.catches);
        expect(await catchLog(dave.publicKey)).to.deep.equal(log0);
        expect(p.boatLevels).to.deep.equal([2, 2, 1, 1, 1]);
      });

      it("rejects an unknown boat piece", async () => {
        await expectFail(() => buyBoat(dave, 5, 2), "InvalidBoatSlot");
      });

      it("rejects the wrong mint, someone else's token account and the wrong token program", async () => {
        await expectFail(() => buyBoat(dave, BOAT_SLOT.boatHull, 2, { pearlMint: fakeMint }), "WrongMint");
        await expectFail(() => buyBoat(alice, BOAT_SLOT.boatHull, 2, { ownerPearl: fakeAta }), "WrongMint");
        await expectFail(() => buyBoat(dave, BOAT_SLOT.boatHull, 2, { ownerPearl: ata[carol.publicKey.toBase58()] }), "WrongTokenOwner");
        await expectFail(() => buyBoat(dave, BOAT_SLOT.boatHull, 2, { tokenProgram: TOKEN_2022_PROGRAM_ID }), "WrongTokenProgram");
      });

      it("rejects the wrong signer", async () => {
        // A stranger signing for dave's Progress: the seeds bind it to the signer.
        await expectFail(() => buyBoat(stranger, BOAT_SLOT.boatHull, 2, { progress: progressPda(dave.publicKey) }), "ConstraintSeeds");
        // dave's accounts without dave's signature.
        await expectFail(() => buyBoat(dave, BOAT_SLOT.boatHull, 2, {}, stranger), "unknown signer");
        expect((await progress(dave)).boatLevels[BOAT_SLOT.boatHull]).to.equal(1);
      });

      it("without enough PEARL fails and creates nothing", async () => {
        await expectFail(() => buyBoat(bob, BOAT_SLOT.boat, 2), "InsufficientPearl");
        expect(await connection.getAccountInfo(progressPda(bob.publicKey))).to.equal(null);
        expect(await balance(bob)).to.be.at.most(50);
      });

      it("burns the new price after set_progress_config", async () => {
        const r = cloneRules(RULES);
        r.boatPrices[BOAT_SLOT.boatDeck][1] = 7;
        await setRules(r);
        const before = await balance(dave);
        await buyBoat(dave, BOAT_SLOT.boatDeck, 2);
        expect(await balance(dave)).to.equal(before - 7);
        await setRules(RULES);
      });

      it("a shark bite never lowers a boat level", async () => {
        const p0 = await progress(alice);
        await sharkBite(alice, session);
        expect((await progress(alice)).boatLevels).to.deep.equal(p0.boatLevels);
      });
    });

    describe("set_ship", () => {
      it("sails any ship the lifetime banked value has unlocked; owner only", async () => {
        await record(erin.publicKey, 43, 30); // erin: lifetime 60
        await setShip(erin, 1);
        expect((await progress(erin)).ship).to.equal(1);
        await expectFail(() => setShip(erin, 2), "ShipLocked");
        await expectFail(() => setShip(erin, 6), "InvalidShip");
        await expectFail(() => setShip(erin, 1, stranger, stranger.publicKey), "ConstraintSeeds");
        await record(erin.publicKey, 44, 90); // lifetime 150
        await setShip(erin, 2);
        await setShip(erin, 0);
        expect((await progress(erin)).ship).to.equal(0);
      });

      it("needs a Progress account", async () => {
        await expectFail(() => setShip(bob, 0), "AccountNotInitialized");
      });
    });

    describe("v1 compatibility", () => {
      const v1Idl = require("./idl/player_state.v1.json");
      const byName = (xs: any[]) => Object.fromEntries(xs.map((x) => [x.name, x]));

      it("every v1 instruction, account, type and error code is unchanged in the IDL", () => {
        const now = idl as any;
        const ixNow = byName(now.instructions);
        for (const ix of v1Idl.instructions) expect(ixNow[ix.name], ix.name).to.deep.equal(ix);
        const accNow = byName(now.accounts);
        for (const a of v1Idl.accounts) expect(accNow[a.name], a.name).to.deep.equal(a);
        const typeNow = byName(now.types);
        for (const t of v1Idl.types) expect(typeNow[t.name], t.name).to.deep.equal(t);
        const errNow = byName(now.errors);
        for (const e of v1Idl.errors) expect(errNow[e.name], e.name).to.deep.equal(e);
        expect(now.address).to.equal(v1Idl.address);
      });

      it("v2 instructions never touched the v1 accounts, and their sizes are the deployed ones", async () => {
        const now = await rawAll();
        // Config differs only while the test oracle is set; compare with it swapped back.
        await program.methods.setOracle(oracle).accountsStrict({ admin: admin.publicKey, config }).rpc();
        const nowRestored = await rawAll();
        await program.methods.setOracle(testOracle.publicKey).accountsStrict({ admin: admin.publicKey, config }).rpc();
        expect(nowRestored.config).to.equal(v1Before.config);
        expect(now.aliceAquarium).to.equal(v1Before.aliceAquarium);
        expect(now.carolAquarium).to.equal(v1Before.carolAquarium);
        expect((await connection.getAccountInfo(config))!.data.length).to.equal(612);
        // alice's PlayerState only changed through the v1 shark_bite above.
        expect((await connection.getAccountInfo(playerPda(alice.publicKey)))!.data.length).to.equal(249);
      });

      it("a fresh v1 player still works end to end on the v2 binary", async () => {
        const fay = Keypair.generate();
        await sendAndConfirmTransaction(
          connection,
          new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: fay.publicKey, lamports: LAMPORTS_PER_SOL })),
          [admin]
        );
        const acc = await getOrCreateAssociatedTokenAccount(connection, admin, pearl, fay.publicKey);
        ata[fay.publicKey.toBase58()] = acc.address;
        await mintTo(connection, admin, pearl, acc.address, admin, 1_000);
        await initPlayer(fay, PublicKey.default);
        await buy(fay, ROD);
        await setPath(fay, fay, ROD, 1);
        await craft(fay, BAIT);
        const p = await player(fay);
        expect(p.levels[ROD]).to.equal(2);
        expect(p.paths[ROD]).to.equal(1);
        expect(p.crafted[BAIT]).to.equal(1);
        expect(await balance(fay)).to.equal(1_000 - GAME.upgrade[ROD][1] - GAME.recipeCost[BAIT]);
        expect((await connection.getAccountInfo(playerPda(fay.publicKey)))!.data.length).to.equal(249);
        expect((await connection.getAccountInfo(aquariumPda(fay.publicKey)))!.data.length).to.equal(62);
        // A v1 player has no Progress until a v2 instruction makes one.
        expect(await connection.getAccountInfo(progressPda(fay.publicKey))).to.equal(null);
      });
    });
  });
});
