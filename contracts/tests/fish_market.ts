import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  burn,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { expect } from "chai";
import { FishMarket } from "../target/types/fish_market";
import {
  MPL_CORE_ID,
  TOKEN_METADATA_ID,
  mintCollection,
  mintFish,
  pdas,
} from "./helpers";

const MAX_VALUE = 30_000;

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

describe("fish_market", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.fishMarket as Program<FishMarket>;
  const connection = provider.connection;
  const rpcUrl = connection.rpcEndpoint;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const { config, mintAuthority, pearlMint, pearlMetadata } = pdas(
    program.programId
  );
  const oracle = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  const ata = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(pearlMint, owner);
  const pearlBalance = async (owner: PublicKey) => {
    try {
      return Number((await getAccount(connection, ata(owner))).amount);
    } catch {
      return 0;
    }
  };

  /** sell_fish with the oracle co-signing; collection defaults to none. */
  const sell = (
    seller: Keypair,
    asset: PublicKey,
    value: number,
    opts: { oracleSigner?: Keypair; collection?: PublicKey | null } = {}
  ) => {
    const oracleSigner = opts.oracleSigner ?? oracle;
    return program.methods
      .sellFish(new BN(value))
      .accounts({
        seller: seller.publicKey,
        oracle: oracleSigner.publicKey,
        asset,
        collection: opts.collection ?? null,
      })
      .signers([seller, oracleSigner])
      .rpc({ commitment: "confirmed" });
  };

  const fish = (name: string, catchValue: number) => ({
    name,
    rarity: "legendary",
    species: "Ghost Lanternfish",
    depthM: 52,
    catchValue,
    seed: Math.random().toString(36).slice(2),
  });

  before(async () => {
    for (const kp of [alice, bob]) {
      const sig = await connection.requestAirdrop(
        kp.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
    }
  });

  it("initialize creates config and the PEARL mint", async () => {
    await program.methods
      .initialize(oracle.publicKey, new BN(MAX_VALUE))
      .accounts({ admin: admin.publicKey })
      .rpc();

    const cfg = await program.account.config.fetch(config);
    expect(cfg.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(cfg.oracle.toBase58()).to.equal(oracle.publicKey.toBase58());
    expect(cfg.pearlMint.toBase58()).to.equal(pearlMint.toBase58());
    expect(cfg.maxValue.toNumber()).to.equal(MAX_VALUE);

    const mint = await getMint(connection, pearlMint);
    expect(mint.decimals).to.equal(0);
    expect(Number(mint.supply)).to.equal(0);
    expect(mint.mintAuthority?.toBase58()).to.equal(mintAuthority.toBase58());
    expect(mint.freezeAuthority).to.equal(null);
  });

  it("initialize cannot run twice", async () => {
    await expectFail(
      () =>
        program.methods
          .initialize(bob.publicKey, new BN(1))
          .accounts({ admin: bob.publicKey })
          .signers([bob])
          .rpc(),
      "already in use"
    );
  });

  it("admin creates PEARL token metadata", async () => {
    await program.methods
      .createPearlMetadata("https://example.com/pearl.json")
      .accounts({ admin: admin.publicKey })
      .rpc();
    const info = await connection.getAccountInfo(pearlMetadata);
    expect(info?.owner.toBase58()).to.equal(TOKEN_METADATA_ID.toBase58());
    expect(info!.data.includes(Buffer.from("PEARL"))).to.equal(true);
  });

  let soldAsset: PublicKey;

  it("sell_fish burns the Core asset and pays PEARL (happy path)", async () => {
    const { asset } = await mintFish(rpcUrl, alice, fish("Lantern Ghost", 150));
    const before = await connection.getAccountInfo(asset);
    expect(before?.owner.toBase58()).to.equal(MPL_CORE_ID.toBase58());

    const sig = await sell(alice, asset, 150);
    soldAsset = asset;

    // The asset is gone: mpl-core leaves at most a 1-byte "Uninitialized" tombstone.
    const after = await connection.getAccountInfo(asset);
    expect(after === null || after.data.length <= 1).to.equal(true);
    if (after) expect(after.data[0]).to.equal(0);

    expect(await pearlBalance(alice.publicKey)).to.equal(150);

    // The FishSold event is in the logs.
    const tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const parser = new anchor.EventParser(program.programId, program.coder);
    const events = [...parser.parseLogs(tx!.meta!.logMessages!)];
    const sold = events.find((e) => e.name === "fishSold");
    expect(sold, "FishSold event").to.not.equal(undefined);
    expect(sold!.data.asset.toBase58()).to.equal(asset.toBase58());
    expect(sold!.data.seller.toBase58()).to.equal(alice.publicKey.toBase58());
    expect(sold!.data.value.toNumber()).to.equal(150);
  });

  it("a second sale credits the existing ATA", async () => {
    const { asset } = await mintFish(rpcUrl, alice, fish("Second", 35));
    await sell(alice, asset, 35);
    expect(await pearlBalance(alice.publicKey)).to.equal(185);
  });

  it("rejects a wrong oracle", async () => {
    const { asset } = await mintFish(rpcUrl, alice, fish("Wrong oracle", 10));
    const impostor = Keypair.generate();
    await expectFail(
      () => sell(alice, asset, 10, { oracleSigner: impostor }),
      "WrongOracle"
    );
    // ...and the fish survives.
    expect((await connection.getAccountInfo(asset))!.data.length).to.be.greaterThan(1);
  });

  it("rejects a missing oracle signature", async () => {
    const { asset } = await mintFish(rpcUrl, alice, fish("Unsigned", 10));
    const ix = await program.methods
      .sellFish(new BN(10))
      .accounts({
        seller: alice.publicKey,
        oracle: oracle.publicKey,
        asset,
        collection: null,
      })
      .instruction();
    // Present the oracle account but strip its signer flag, so the program
    // itself (not the client) has to catch it.
    const meta = ix.keys.find((k) => k.pubkey.equals(oracle.publicKey))!;
    meta.isSigner = false;
    await expectFail(
      () =>
        sendAndConfirmTransaction(connection, new Transaction().add(ix), [alice]),
      "AccountNotSigner"
    );
    expect(await pearlBalance(alice.publicKey)).to.equal(185);
  });

  it("rejects value > max_value and value == 0", async () => {
    const { asset } = await mintFish(rpcUrl, alice, fish("Greedy", 10));
    await expectFail(() => sell(alice, asset, MAX_VALUE + 1), "ValueTooHigh");
    await expectFail(() => sell(alice, asset, 0), "ZeroValue");
    // Exactly max_value is allowed.
    await sell(alice, asset, MAX_VALUE);
    expect(await pearlBalance(alice.publicKey)).to.equal(185 + MAX_VALUE);
  });

  it("rejects selling an asset the seller does not own", async () => {
    const { asset } = await mintFish(rpcUrl, alice, fish("Alice's fish", 10));
    await expectFail(() => sell(bob, asset, 10), "NotOwner");
    expect(await pearlBalance(bob.publicKey)).to.equal(0);
  });

  it("rejects a double sell", async () => {
    await expectFail(() => sell(alice, soldAsset, 150), "AssetBurned");
  });

  it("rejects an account that is not a Core asset", async () => {
    await expectFail(() => sell(alice, pearlMint, 10), "NotACoreAsset");
  });

  it("sells a fish that belongs to a collection (and requires the collection)", async () => {
    const collection = await mintCollection(rpcUrl, bob);
    const { asset } = await mintFish(rpcUrl, bob, fish("In a collection", 3), collection);
    await expectFail(() => sell(bob, asset, 3), "CollectionMismatch");
    await sell(bob, asset, 3, { collection });
    expect(await pearlBalance(bob.publicKey)).to.equal(3);
  });

  it("holder can spend PEARL with a plain SPL burn", async () => {
    const supplyBefore = Number((await getMint(connection, pearlMint)).supply);
    const balanceBefore = await pearlBalance(alice.publicKey);
    await burn(connection, alice, ata(alice.publicKey), pearlMint, alice, 100);
    expect(await pearlBalance(alice.publicKey)).to.equal(balanceBefore - 100);
    const supplyAfter = Number((await getMint(connection, pearlMint)).supply);
    expect(supplyAfter).to.equal(supplyBefore - 100);
  });

  it("set_oracle / set_max_value are admin-only and take effect", async () => {
    const newOracle = Keypair.generate();
    await expectFail(
      () =>
        program.methods
          .setOracle(bob.publicKey)
          .accounts({ admin: bob.publicKey })
          .signers([bob])
          .rpc(),
      "NotAdmin"
    );
    await expectFail(
      () =>
        program.methods
          .setMaxValue(new BN(1))
          .accounts({ admin: bob.publicKey })
          .signers([bob])
          .rpc(),
      "NotAdmin"
    );

    await program.methods
      .setOracle(newOracle.publicKey)
      .accounts({ admin: admin.publicKey })
      .rpc();
    const { asset } = await mintFish(rpcUrl, alice, fish("Rotated", 10));
    await expectFail(() => sell(alice, asset, 10), "WrongOracle");
    const before = await pearlBalance(alice.publicKey);
    await sell(alice, asset, 10, { oracleSigner: newOracle });
    expect(await pearlBalance(alice.publicKey)).to.equal(before + 10);

    await program.methods
      .setMaxValue(new BN(5))
      .accounts({ admin: admin.publicKey })
      .rpc();
    const { asset: a2 } = await mintFish(rpcUrl, alice, fish("Capped", 10));
    await expectFail(
      () => sell(alice, a2, 6, { oracleSigner: newOracle }),
      "ValueTooHigh"
    );

    // Restore.
    await program.methods
      .setOracle(oracle.publicKey)
      .accounts({ admin: admin.publicKey })
      .rpc();
    await program.methods
      .setMaxValue(new BN(MAX_VALUE))
      .accounts({ admin: admin.publicKey })
      .rpc();
    const cfg = await program.account.config.fetch(config);
    expect(cfg.oracle.toBase58()).to.equal(oracle.publicKey.toBase58());
    expect(cfg.maxValue.toNumber()).to.equal(MAX_VALUE);
  });
});
