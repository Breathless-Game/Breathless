# fish_market: the on-chain fish market for Breathless

An Anchor program on Solana **devnet**. Selling a fish burns its Metaplex Core
NFT and mints **PEARL** (SPL token, 0 decimals) to the seller, atomically, with
a server "oracle" co-signing to vouch for the price.

Deployed addresses: [`DEPLOYED.md`](DEPLOYED.md). IDL:
`target/idl/fish_market.json`, also copied to `game/src/idl/fish_market.json`.

## Interface

PDAs (all seeds are ASCII, program = `fish_market`):

| PDA | seeds | what |
| --- | --- | --- |
| `config` | `["config"]` | `{ admin, oracle, pearl_mint, max_value: u64, bump, mint_bump }` (`mint_bump` = bump of `pearl_mint`) |
| `mint_authority` | `["mint_authority"]` | PEARL mint authority (no data) |
| `pearl_mint` | `["pearl"]` | the PEARL mint: decimals 0, authority `mint_authority`, **no freeze authority** |

Instructions:

| instruction | signers | effect |
| --- | --- | --- |
| `initialize(oracle, max_value)` | admin (payer) | creates `config` + `pearl_mint`; signer becomes admin |
| `sell_fish(value)` | seller (fee payer) + oracle | checks, burns the Core asset (CPI `BurnV1`), `mint_to` `value` PEARL into the seller's ATA (created if needed), emits `FishSold { asset, seller, value }` |
| `set_oracle(new_oracle)` | admin | rotate the oracle key |
| `set_max_value(new_max_value)` | admin | change the per-fish cap (*addition*) |
| `create_pearl_metadata(uri)` | admin | one-time Metaplex token-metadata for PEARL ("Pearl" / "PEARL"), signed by the `mint_authority` PDA; admin is the metadata update authority (*addition*) |

`sell_fish` accounts, in order: `seller`, `oracle`, `config`, `asset`,
`collection` (optional: pass `null` in Anchor TS, which sends the program id;
only needed if the asset belongs to a Core collection, and the game mints
without one), `pearl_mint`, `mint_authority`, `seller_pearl_ata`,
`mpl_core_program`, `token_program`, `associated_token_program`,
`system_program`. With Anchor TS only four need passing; the rest resolve from
the IDL:

```ts
const tx = await program.methods
  .sellFish(new BN(value))
  .accounts({ seller, oracle: oraclePubkey, asset, collection: null })
  .transaction();
tx.feePayer = seller;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
tx.partialSign(oracleKeypair); // on the market server, after validating the tx
// ...send back to the client, which signs as seller and submits
```

Errors (`6000+`): `WrongOracle`, `ZeroValue`, `ValueTooHigh`, `NotACoreAsset`,
`AssetBurned` (already sold), `NotOwner`, `CollectionMismatch`, `NotAdmin`,
`InvalidMaxValue`.

Spending PEARL needs no program: the holder burns with the SPL token program
(`burn` / `burnChecked` from `@solana/spl-token`).

## Trust model (honest version)

- **The oracle decides what a fish is worth.** Fish are caught client-side, so
  the chain cannot know whether a catch was legit or what it is worth. The
  market server (holder of the oracle key) vouches for `value` by co-signing.
  A compromised oracle key can mint up to `max_value` PEARL per Core asset it
  is shown, so rotate it with `set_oracle` if it leaks.
- **What the program enforces:** the configured oracle signed; `0 < value <=
  max_value`; the asset is a live Metaplex Core asset owned by the seller; the
  burn and the payment happen in one instruction (both or neither); a fish can
  be sold once (after the burn, mpl-core leaves a 1-byte tombstone and a resale
  fails with `AssetBurned`).
- **What the server must do before co-signing:** check that the transaction is
  exactly one `sell_fish` (plus optional compute-budget instructions) with the
  expected `asset`, `seller` and `value`, and that the fee payer is the seller,
  not the oracle. The oracle's signature covers the *whole* transaction, so
  never co-sign instructions you did not inspect. Keep the oracle wallet
  unfunded; it never needs SOL.
- **Admin powers:** the admin can change the oracle and the cap, and (as
  deployer) holds the program upgrade authority. There is no admin mint and no
  freeze authority on PEARL.
- `initialize` can be called once, by whoever calls it first; it was called
  right after deploy (see `DEPLOYED.md`).

## Toolchain (what this was built and tested with)

| tool | version |
| --- | --- |
| rustc / cargo (rustup stable) | 1.99.0 |
| Solana CLI (Agave, `release.anza.xyz/stable`) | 4.3.0, `cargo-build-sbf` 4.4.0, platform-tools v1.57 (SBPF v3, active on devnet) |
| Anchor CLI | 0.31.2 (prebuilt `anchor-0.31.2-aarch64-apple-darwin` from the Anchor GitHub release) |
| `anchor-lang` / `anchor-spl` | `=0.31.2` (`anchor-spl` features `token`, `associated_token`, `metadata`) |
| `mpl-core` (Rust) | `=0.11.2`, feature `anchor` (its anchor dep is `^0.31.1`) |
| `mpl-token-metadata` | 5.1.1 (through `anchor-spl/metadata`) |
| TS | `@coral-xyz/anchor` 0.31.1, `@metaplex-foundation/mpl-core` 1.10.0, umi 1.6.0, `@solana/web3.js` 1.99.0 |

Everything resolves to a single `solana-program` 2.3.0. Anchor 1.x and
`mpl-core` 0.12 (solana 3.x crates) were deliberately not used.

## Build, test, deploy

```sh
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd contracts
npm install
npm run fixtures          # dumps mpl-core + token-metadata from devnet into tests/fixtures/
CARGO_BUILD_JOBS=2 anchor build
anchor test --skip-build  # local validator with both programs loaded via [[test.genesis]]
```

Local validator notes (in `Anchor.toml`): it listens on **8999** because the
game's sensor server owns 8899, and binds `127.0.0.1` because Agave 4.x rejects
Anchor 0.31's default `0.0.0.0` gossip address.

Deploy to devnet (keys live in `contracts/.keys/`, git-ignored):

```sh
solana program deploy target/deploy/fish_market.so \
  --program-id target/deploy/fish_market-keypair.json \
  --keypair .keys/deployer.json --upgrade-authority .keys/deployer.json \
  --url devnet --with-compute-unit-price 20000
# (avoid --use-rpc: it pushes every write through the public RPC and stalls on 429s)
npx tsx scripts/init-devnet.ts   # initialize(oracle, 30000) + PEARL metadata (Irys devnet)
npx tsx scripts/e2e-devnet.ts    # mint a Core fish, oracle co-signs, sell, check balance
npm run copy-idl                 # target/idl -> game/src/idl
```

`target/deploy/fish_market-keypair.json` is backed up as
`.keys/fish_market-program.json`; keep it, or you cannot upgrade at the same id.

## Notes

- `max_value` is 30000. Today's biggest catch is mythic 800 × 2.5 (The Abyss) =
  2000, or 4800 with the ×6 depth multiplier on another branch, so 30000 leaves
  room for rebalancing; tighten it with `set_max_value` if you like.
- The PEARL image/JSON are on Irys **devnet**, which only keeps data for a
  limited time. If the logo disappears, re-upload and update the metadata URI
  with the admin key (standard Metaplex `updateV1` / `update_metadata_accounts_v2`).
