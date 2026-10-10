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
