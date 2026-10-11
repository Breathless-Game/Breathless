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

Deployed binary: `target/deploy/player_state.so`, 381848 bytes, sha256
`e518da31c305ce237df2bce34b10da52725923a67de7244ce9481b895559829e`.

## Transactions

- Deploy: [`s2tWGwYA…bHN`](https://explorer.solana.com/tx/s2tWGwYAVrggMgPkbmeXkJnVCC1MSwkQ2TozEVf2Eq3fShrxZQ7YTcaF8ZvDLXuZnoderR9qyuPQPdCNH748bHN?cluster=devnet)
- `initialize_config` (scripts/init-player-state.ts): [`5k4zWmB9…yM9M`](https://explorer.solana.com/tx/5k4zWmB9WRBswmkKUicjM7NmVWWvDk6wMbZGyafgcBiZ4ReKvTMzQu6BeWyKJwwhUnDvPQwJYCc5r2xu2KdryM9M?cluster=devnet)
