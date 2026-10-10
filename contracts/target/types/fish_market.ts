/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/fish_market.json`.
 */
export type FishMarket = {
  "address": "5HEuVNCHKjpfnsdJzov3zDy9UFSj8V2tzF8L9eQnKsDG",
  "metadata": {
    "name": "fishMarket",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Breathless fish market: burn a Metaplex Core fish, get PEARL"
  },
  "instructions": [
    {
      "name": "createPearlMetadata",
      "docs": [
        "Admin only, one-time: create Metaplex token metadata for PEARL so wallets",
        "and explorers show \"Pearl\" / \"PEARL\". Signed by the `mint_authority` PDA;",
        "the admin is the metadata update authority (so the URI can be changed",
        "later with standard Metaplex tooling)."
      ],
      "discriminator": [
        176,
        107,
        25,
        142,
        210,
        17,
        119,
        242
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "pearlMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  97,
                  114,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "pearlMetadata",
          "docs": [
            "token-metadata program."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "tokenMetadataProgram"
              },
              {
                "kind": "account",
                "path": "pearlMint"
              }
            ],
            "program": {
              "kind": "account",
              "path": "tokenMetadataProgram"
            }
          }
        },
        {
          "name": "tokenMetadataProgram",
          "address": "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "uri",
          "type": "string"
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "Creates the config and the PEARL mint (decimals 0, authority = the",
        "`mint_authority` PDA, no freeze authority). The signer becomes admin."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "pearlMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  97,
                  114,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "oracle",
          "type": "pubkey"
        },
        {
          "name": "maxValue",
          "type": "u64"
        }
      ]
    },
    {
      "name": "sellFish",
      "docs": [
        "Burns the seller's Core fish and mints `value` PEARL to the seller's ATA.",
        "The oracle must co-sign the transaction."
      ],
      "discriminator": [
        202,
        178,
        229,
        28,
        243,
        203,
        69,
        115
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "oracle",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "asset",
          "docs": [
            "checked in the handler, and mpl-core validates it again during BurnV1."
          ],
          "writable": true
        },
        {
          "name": "collection",
          "docs": [
            "one (checked in the handler and by mpl-core). Pass None for no collection."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "pearlMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  97,
                  114,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "sellerPearlAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "seller"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "pearlMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "value",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setMaxValue",
      "docs": [
        "Admin only: change the per-fish PEARL cap (e.g. if game balance changes)."
      ],
      "discriminator": [
        221,
        124,
        139,
        221,
        164,
        186,
        12,
        255
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newMaxValue",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setOracle",
      "docs": [
        "Admin only: rotate the oracle key."
      ],
      "discriminator": [
        186,
        128,
        81,
        104,
        74,
        79,
        18,
        224
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newOracle",
          "type": "pubkey"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    }
  ],
  "events": [
    {
      "name": "fishSold",
      "discriminator": [
        194,
        170,
        75,
        144,
        58,
        242,
        189,
        184
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "wrongOracle",
      "msg": "The oracle signer is not the configured oracle"
    },
    {
      "code": 6001,
      "name": "zeroValue",
      "msg": "Sale value must be greater than zero"
    },
    {
      "code": 6002,
      "name": "valueTooHigh",
      "msg": "Sale value exceeds config.max_value"
    },
    {
      "code": 6003,
      "name": "notACoreAsset",
      "msg": "Account is not a Metaplex Core asset"
    },
    {
      "code": 6004,
      "name": "assetBurned",
      "msg": "Asset has already been burned (sold)"
    },
    {
      "code": 6005,
      "name": "notOwner",
      "msg": "Seller does not own this asset"
    },
    {
      "code": 6006,
      "name": "collectionMismatch",
      "msg": "Collection account missing or does not match the asset's collection"
    },
    {
      "code": 6007,
      "name": "notAdmin",
      "msg": "Only the admin can do this"
    },
    {
      "code": 6008,
      "name": "invalidMaxValue",
      "msg": "max_value must be greater than zero"
    }
  ],
  "types": [
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "oracle",
            "type": "pubkey"
          },
          {
            "name": "pearlMint",
            "type": "pubkey"
          },
          {
            "name": "maxValue",
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "Bump of the `config` PDA."
            ],
            "type": "u8"
          },
          {
            "name": "mintBump",
            "docs": [
              "Bump of the `pearl_mint` PDA (seeds `[b\"pearl\"]`)."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "fishSold",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "asset",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "value",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
