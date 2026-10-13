# fish_market on devnet

Cluster: **devnet** (`https://api.devnet.solana.com`). Deployed 2026-10-10.

| what | address |
| --- | --- |
| Program id | [`5HEuVNCHKjpfnsdJzov3zDy9UFSj8V2tzF8L9eQnKsDG`](https://explorer.solana.com/address/5HEuVNCHKjpfnsdJzov3zDy9UFSj8V2tzF8L9eQnKsDG?cluster=devnet) |
| ProgramData | [`CYjCmwEgCtaJMts4cuUhZSKs88yoSXUqFR3SfDnP5s8`](https://explorer.solana.com/address/CYjCmwEgCtaJMts4cuUhZSKs88yoSXUqFR3SfDnP5s8?cluster=devnet) |
| `config` PDA (`["config"]`) | [`7V7wfzDb7yhKPn5dSGSJt2QuwfwLar4bHJwwqUxa6F9B`](https://explorer.solana.com/address/7V7wfzDb7yhKPn5dSGSJt2QuwfwLar4bHJwwqUxa6F9B?cluster=devnet) |
| PEARL mint PDA (`["pearl"]`) | [`4ySNDwps7KhPQwF5YxDzPFfDn5yijMebCTU98SS4Fe77`](https://explorer.solana.com/address/4ySNDwps7KhPQwF5YxDzPFfDn5yijMebCTU98SS4Fe77?cluster=devnet) |
| `mint_authority` PDA (`["mint_authority"]`) | [`2GDbCgaARSHaiYzu5xww4xpaHc6Spt5QyKAspNC5utSu`](https://explorer.solana.com/address/2GDbCgaARSHaiYzu5xww4xpaHc6Spt5QyKAspNC5utSu?cluster=devnet) |
| PEARL token metadata | [`HHqCoW6ScacNQqnE7XLwPKp4SKNsg9mzQpWPtZKcBx5T`](https://explorer.solana.com/address/HHqCoW6ScacNQqnE7XLwPKp4SKNsg9mzQpWPtZKcBx5T?cluster=devnet) |
| Oracle pubkey | [`91UQUijR663d8Zbs7fgFRytdo3W22sy1Tfj5fvgq6EkV`](https://explorer.solana.com/address/91UQUijR663d8Zbs7fgFRytdo3W22sy1Tfj5fvgq6EkV?cluster=devnet) |
| Deployer = admin = upgrade authority | [`7faQNtnWuyg2hFuDLYDuS9rdMY49baq9XKQNhhCeeoPb`](https://explorer.solana.com/address/7faQNtnWuyg2hFuDLYDuS9rdMY49baq9XKQNhhCeeoPb?cluster=devnet) |
| mpl-core program | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` |

Config: `max_value = 30000`. PEARL: decimals 0, mint authority =
`mint_authority` PDA, no freeze authority, name "Pearl" / symbol "PEARL",
metadata URI `https://gateway.irys.xyz/9P6UXG8f2A6nk39CHzN79DXCeAXkgtZi723DANEA42tE`
(Irys devnet, so not permanent).

Secret keys (git-ignored, never commit): `contracts/.keys/deployer.json`,
`contracts/.keys/oracle.json` (the market server needs this one),
`contracts/.keys/fish_market-program.json` (copy of
`target/deploy/fish_market-keypair.json`).

Deployed binary: `target/deploy/fish_market.so`, 291904 bytes, sha256
`61764587cf96880c564fdcce8bc43b76311651834667665ade209f2f17d7c57d`.

## Transactions

- Deploy: [`2eXqf5Jz…Fu5c`](https://explorer.solana.com/tx/2eXqf5JzNrPoyzNH6wC8oYtzw8BX7vLoxwqNZGQynXcuY4Qs1zjnXYavgv9LJX4G64JSAxKRgkzRrorB53y1Fu5c?cluster=devnet)
- `initialize(oracle, 30000)`: [`5Krh8Q56…M2Y3`](https://explorer.solana.com/tx/5Krh8Q56hvwt9FhAkeHnaNT89YHNmtw4XRFdZxerun5mW9ymhPf6x5arTD1w6iXLKURQvCkV3QPCTVF82qQoM2Y3?cluster=devnet)
- `create_pearl_metadata`: [`5yPpAgfu…JThmv`](https://explorer.solana.com/tx/5yPpAgfuCX82PARq6JwaV3dPT5KTfJcuPxhLLt3XTn4WHkzVpkd96ati6suXhv2Q8gRqi23gJokZw2x3PPzJThmv?cluster=devnet)

## End-to-end sale (scripts/e2e-devnet.ts)

A fresh burner wallet minted a Core fish (legendary "Abyssal Sunfish" with
on-chain Attributes rarity / species / depth / Catch value / seed), then sold
it for 375 PEARL with the oracle co-signing:

- Player: [`4uKAMgmbi5dxgmZJWbrUgaEkc5nzrkGqAaFzZCVnnwkE`](https://explorer.solana.com/address/4uKAMgmbi5dxgmZJWbrUgaEkc5nzrkGqAaFzZCVnnwkE?cluster=devnet)
- Fish (now burned, a 1-byte tombstone): [`svqxg366t8nZ1ccbC1et1rZsBhiw2TXJvd7vMe7vx8N`](https://explorer.solana.com/address/svqxg366t8nZ1ccbC1et1rZsBhiw2TXJvd7vMe7vx8N?cluster=devnet)
- `sell_fish(375)`: [`7qPHmnR1…h3D`](https://explorer.solana.com/tx/7qPHmnR1fWmBnZTZubAm2YaMSs4KChJvpeLsjBuLktt8f1okJtbbLKpcKLFaz6HTbrLruMd133zbKxuUkKJbh3D?cluster=devnet), 39,726 CU (fits the default 200k limit, including creating the ATA)
- Player's PEARL ATA, balance 375: [`G5khBJFrRAAGLec5a3x4s1wM5XwUySrxpaBVbgo6Pykq`](https://explorer.solana.com/address/G5khBJFrRAAGLec5a3x4s1wM5XwUySrxpaBVbgo6Pykq?cluster=devnet)

# player_state on devnet

Cluster: **devnet**. Deployed 2026-10-11 from `main` 28689d8.

| what | address |
| --- | --- |
| Program id | [`EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ`](https://explorer.solana.com/address/EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ?cluster=devnet) |
| ProgramData | [`F3t9gekMBdbBatNqdHWYPGccJK3wi7wfjX8fR2373jDp`](https://explorer.solana.com/address/F3t9gekMBdbBatNqdHWYPGccJK3wi7wfjX8fR2373jDp?cluster=devnet) |
| `config` PDA (`["config"]`) | [`3xrnDesVHmrpYZi6R52ux7FmoxaWL5ege53iFN44DtMj`](https://explorer.solana.com/address/3xrnDesVHmrpYZi6R52ux7FmoxaWL5ege53iFN44DtMj?cluster=devnet) |
| Deployer = admin = upgrade authority | [`EA77L4HGz15Urk1Ycohju77Ufb1hJCa4g5z4Xfdwz9To`](https://explorer.solana.com/address/EA77L4HGz15Urk1Ycohju77Ufb1hJCa4g5z4Xfdwz9To?cluster=devnet) |
| Oracle (market wallet) | [`12b3GY2Pbh4HnNaLqL7GszmeFrcrfiULwfLz5HcF7gRd`](https://explorer.solana.com/address/12b3GY2Pbh4HnNaLqL7GszmeFrcrfiULwfLz5HcF7gRd?cluster=devnet) |
| PEARL mint | [`3aX1muNxajg9VuxfigrVk2f7dGdCedJ67kUsAqCc9drp`](https://explorer.solana.com/address/3aX1muNxajg9VuxfigrVk2f7dGdCedJ67kUsAqCc9drp?cluster=devnet) |
| Token program (owner of the mint) | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |

Config (version 1) holds the game's price table, `GAME_PRICE_TABLE` in
`game/src/player-state.ts`; change it with `update_prices` (admin only).

Secret keys (git-ignored, never commit): `contracts/.keys/player_state-program.json`,
`contracts/.keys/player_state-deployer.json`.

v1 binary (2026-10-11, `main` 28689d8): 381848 bytes, sha256
`e518da31c305ce237df2bce34b10da52725923a67de7244ce9481b895559829e`.

## Transactions

- Deploy: [`s2tWGwYA…bHN`](https://explorer.solana.com/tx/s2tWGwYAVrggMgPkbmeXkJnVCC1MSwkQ2TozEVf2Eq3fShrxZQ7YTcaF8ZvDLXuZnoderR9qyuPQPdCNH748bHN?cluster=devnet)
- `initialize_config` (scripts/init-player-state.ts): [`5k4zWmB9…yM9M`](https://explorer.solana.com/tx/5k4zWmB9WRBswmkKUicjM7NmVWWvDk6wMbZGyafgcBiZ4ReKvTMzQu6BeWyKJwwhUnDvPQwJYCc5r2xu2KdryM9M?cluster=devnet)

## v2 upgrade (2026-10-11, branch `feat/player-state-v2`)

Additive: Progress (boats, ship, lifetime banked value, catch log) and ProgressConfig
(boat prices, ship / map thresholds); `buy_boat`, `set_ship`, `record_catch`,
`init_progress_config`, `set_progress_config`. v1 accounts and instructions unchanged
(see README.md). Before the upgrade the program owned one account (Config); no
PlayerState or Aquarium existed on devnet.

| what | address |
| --- | --- |
| `progress_config` PDA (`["progress_config"]`, 266 bytes, bump 254) | [`3NueXxn6WNCJaA3dUNKznvskWqgFZENHuxzo5CPMiKx3`](https://explorer.solana.com/address/3NueXxn6WNCJaA3dUNKznvskWqgFZENHuxzo5CPMiKx3?cluster=devnet) |
| `progress` PDA per wallet | `["progress", owner]`, created by `buy_boat` / `record_catch` |

ProgressConfig rules (`GAME_PROGRESS_RULES` in game/src/player-state.ts): boat prices
bait / boat / boatSpeed / boatHull / boatDeck = [0,40,300] / [0,120,700] / [0,80,500] x3;
ship thresholds [0,50,150,500,1200,2500]; map thresholds fjord 0, tianchi 150, ocean 1000.

Only the server-mode market (co-signed fish mints) sends `record_catch`. A program-mode market
(`FISH_MARKET_PROGRAM_ID`, the game's `mintRoute` 'legacy') mints without it, so lifetime value
stays 0 there and maps past the fjord and ships past the first stay locked.

Binary: 455216 bytes, sha256
`c1a920aaa5522d650f601a3b7ee2dab5db2ff7b58e4720777ec7b53da9566660` (the dumped
on-chain program matches). ProgramData extended by 73368 bytes (381848 -> 455216).

- SOL for the upgrade: 2.2 SOL from the market wallet 12b3… to EA77…: [`AQUBM1eh…uTi`](https://explorer.solana.com/tx/AQUBM1ehogJJTXYYtY1Kf9gny85oygnYv3GUwXDk6C8MUWSXkeMv7HUJ8LvJQwbKh4jx4yqhWxtMtEfQnH17uTi?cluster=devnet)
  (EA77 0.5527 -> 2.7527; the 2.3133 SOL buffer was refunded after the upgrade, the
  extend kept 0.3727; EA77 holds 2.3757 SOL afterwards)
- `solana program extend … 73368`: [`g3icdG1y…qFx`](https://explorer.solana.com/tx/g3icdG1yy7aSTgfAaH8ULcgTRqEwi9JURpq6nT9gLztTjoCehXVnH8B5oJ1h5RXbdRybRnk2Brq3hh4cxtMHqFx?cluster=devnet)
- Upgrade from buffer `HNUfL8xQ7kRqrybC8ErX7Xn7M1xfRErDPihRPfHdBvpV` (closed), slot 509901184: [`L4z6QbHE…eSZ`](https://explorer.solana.com/tx/L4z6QbHE3WwxuhCA8gz7r6D7GyzPUvqvb8esbJXygTS9Q4QrpyifyJ6nsP583kHC49zhTiL1q5xyFxkFXHJceSZ?cluster=devnet)
- `init_progress_config` (scripts/init-progress-config.ts): [`3X5Zp87R…A4a`](https://explorer.solana.com/tx/3X5Zp87RkdTpbShmmt9HYNw8eMJwSuypqkzc2taVGBcWtVcW4jqerDCQK7Vuzx6EFNhHeuS3unPXpB24fact5A4a?cluster=devnet)
- Read-only devnet simulations (scripts/measure-record-catch.ts, nothing sent): Core
  fish mint + `record_catch` for a new owner, 1066 bytes, 34.7k-39.2k CU, success;
  `buy_boat` bait Lv2, 411 bytes, 14.8k CU, success.

# player_state TEST copy on devnet (Vercel pre-cutover only)

Cluster: **devnet**. Deployed 2026-10-13 from `main` 0d6d2f7, with only `declare_id!` changed
(built in a scratch copy; the repo keeps the live id). A separate program for the Vercel
deployment's TEST market wallet: the live Config's oracle is the live market wallet, so a TEST
market's co-signed fish mints fail `record_catch` with `Unauthorized` (0x1770). Vercel uses it
through `PLAYER_STATE_PROGRAM_ID` and `VITE_PLAYER_STATE_PROGRAM_ID` until cutover, then both are
deleted (deploy/VERCEL.md). Never point the live market or the Dell at it.

| what | address |
| --- | --- |
| Program id | [`4tdodYRKyHKMPs7ZzY4yPs7CM3PnGrJV6FWfYbp7473L`](https://explorer.solana.com/address/4tdodYRKyHKMPs7ZzY4yPs7CM3PnGrJV6FWfYbp7473L?cluster=devnet) |
| ProgramData | [`3Kun56APS62jzLNLogJdMpytvFMdFwbGiahK9UggbCYQ`](https://explorer.solana.com/address/3Kun56APS62jzLNLogJdMpytvFMdFwbGiahK9UggbCYQ?cluster=devnet) |
| `config` PDA | [`BhrxVEScqpVCvfCYc3NP2DoVEhJfkNMLYWJXmpJ1XGyg`](https://explorer.solana.com/address/BhrxVEScqpVCvfCYc3NP2DoVEhJfkNMLYWJXmpJ1XGyg?cluster=devnet) |
| `progress_config` PDA | [`BzkMp9YJEGEXHZF9LreajTjXSfrRKVofYbn4oaiMSqYT`](https://explorer.solana.com/address/BzkMp9YJEGEXHZF9LreajTjXSfrRKVofYbn4oaiMSqYT?cluster=devnet) |
| Upgrade authority = admin = oracle (the TEST market wallet) | [`8RJHaqvY2EjsezPU8PX6Cakz6DWPkzjcNTumR7x6tiax`](https://explorer.solana.com/address/8RJHaqvY2EjsezPU8PX6Cakz6DWPkzjcNTumR7x6tiax?cluster=devnet) |
| PEARL mint (the TEST market's own) | [`92GEca6UrCLJrXtwHYJGtukuE6wqFkiswjYWkQzuEgVv`](https://explorer.solana.com/address/92GEca6UrCLJrXtwHYJGtukuE6wqFkiswjYWkQzuEgVv?cluster=devnet) |
| Token program (owner of the mint) | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |

Config and ProgressConfig are the live ones field for field (price table, boat prices, ship and
map thresholds, versions), except `admin`, `oracle` and `pearl_mint` above and the
ProgressConfig bump. The PEARL mint is fixed at `initialize_config`, so the program serves this
one TEST wallet only.

Secret keys (git-ignored, never commit): `contracts/.keys/test-player_state-program.json`,
`contracts/.keys/test-market.json`.

Binary: 455216 bytes, sha256
`b495c82412e0f7618effb41f21d5666d5606a63f88c1e9e77fec09c5bf407d31` (the dumped on-chain program
matches). Same player_state source as the live v2 binary and the same size; the two differ in
1392 bytes, every differing 32-bit word being a word of the live id swapped for the TEST id.

- Deploy: [`41sD1Tdb…aRCDy`](https://explorer.solana.com/tx/41sD1TdbJgiK68jCentRN8UTFSTzWW5dzEUi3xWhASBMxsxLCzxmqx8ErPxJiRTroZJn2cVd2anQARHjsh7aRCDy?cluster=devnet)
- `initialize_config` (scripts/init-player-state.ts, `PLAYER_STATE_ORACLE` / `PEARL_MINT` set): [`4QQrUjy9…QttF`](https://explorer.solana.com/tx/4QQrUjy9w1PaeVxXjSdTeVcYJjjs2qJrcz9nHzoB2Ef4eQPmDH1GV5j5oDxuFc7JcYjGJFw6eDvf7ZJd8itZQttF?cluster=devnet)
- `init_progress_config` (scripts/init-progress-config.ts): [`3n8Z8t28…usY`](https://explorer.solana.com/tx/3n8Z8t28QQQ8btjQXGbRkP6kcNdPnNjhZYy7zCtL4RWLEUkh1qHeXzAehEwh9QwsgpMmmijiM3fkXQdCiUtcusY?cluster=devnet)
- Read-only simulation of the server's co-signed fish mint (sensor/fish-collection.mjs
  `buildMintTx`, TEST market as oracle and collection authority, collection
  `8ppuvcgUVQnbeZ57suBofVQH5g4kYhhSaPMhihxPi7M3`): against the live program `record_catch` fails
  with 0x1770; against this program the transaction succeeds, 30.7k CU.
