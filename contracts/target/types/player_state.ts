/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/player_state.json`.
 */
export type PlayerState = {
  "address": "EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ",
  "metadata": {
    "name": "playerState",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Breathless player state: per-wallet equipment, synthesis and aquarium progress, paid for by burning PEARL"
  },
  "instructions": [
    {
      "name": "buyUpgrade",
      "docs": [
        "Buys the next level of a slot at the Config price (main.ts buyNextUpgrade)."
      ],
      "discriminator": [
        136,
        43,
        33,
        208,
        15,
        32,
        65,
        61
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "player"
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
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "pearlMint",
          "writable": true
        },
        {
          "name": "ownerPearl",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "slot",
          "type": "u8"
        }
      ]
    },
    {
      "name": "craft",
      "docs": [
        "Crafts one recipe (synthesis.ts craft): needs the materials, burns the",
        "recipe cost, consumes the materials, adds one crafted item."
      ],
      "discriminator": [
        161,
        233,
        177,
        214,
        243,
        109,
        161,
        224
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "player"
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
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "pearlMint",
          "writable": true
        },
        {
          "name": "ownerPearl",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "recipe",
          "type": "u8"
        }
      ]
    },
    {
      "name": "feed",
      "docs": [
        "One pour of food over a school (aquarium.ts feedSchool): every listed",
        "fish that is neither fully grown nor still in its cooldown grows by the",
        "food's weight, and the food's price is burned once. If no listed fish",
        "can eat, the whole call fails and nothing is burned."
      ],
      "discriminator": [
        46,
        213,
        237,
        176,
        190,
        113,
        182,
        94
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "aquarium"
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
          "name": "aquarium",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  113,
                  117,
                  97,
                  114,
                  105,
                  117,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "pearlMint",
          "writable": true
        },
        {
          "name": "ownerPearl",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "food",
          "type": "u8"
        },
        {
          "name": "fish",
          "type": {
            "vec": {
              "array": [
                "u8",
                8
              ]
            }
          }
        }
      ]
    },
    {
      "name": "forgetFish",
      "docs": [
        "Drops growth entries for fish the client says are gone (sold or burned)",
        "and refunds the freed rent to the owner. Unknown keys are ignored."
      ],
      "discriminator": [
        89,
        97,
        234,
        13,
        207,
        58,
        15,
        203
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "aquarium"
          ]
        },
        {
          "name": "aquarium",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  113,
                  117,
                  97,
                  114,
                  105,
                  117,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "fish",
          "type": {
            "vec": {
              "array": [
                "u8",
                8
              ]
            }
          }
        }
      ]
    },
    {
      "name": "initPlayer",
      "docs": [
        "Creates the player's state and aquarium. The owner signs and pays rent.",
        "Everyone starts from zero: gear at Lv1, default paths, the default materials."
      ],
      "discriminator": [
        114,
        27,
        219,
        144,
        50,
        15,
        228,
        66
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
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
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "aquarium",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  113,
                  117,
                  97,
                  114,
                  105,
                  117,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "session",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initializeConfig",
      "docs": [
        "Creates the config. Only the program's upgrade authority may call it,",
        "so nobody can front-run the deploy and take the admin seat."
      ],
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
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
          "name": "pearlMint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "program",
          "address": "EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ"
        },
        {
          "name": "programData"
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
          "name": "prices",
          "type": {
            "defined": {
              "name": "priceTable"
            }
          }
        }
      ]
    },
    {
      "name": "setOracle",
      "docs": [
        "Replaces the oracle (the market wallet that records catches in later phases). Admin only."
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
          "name": "oracle",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setPath",
      "docs": [
        "Chooses a slot's module path (equipment.ts setEquipmentPath): free, any",
        "number of times, only once the slot is Lv2+, sonar has none. The owner",
        "or the session key signs."
      ],
      "discriminator": [
        63,
        93,
        91,
        67,
        201,
        6,
        195,
        189
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The owner, or the player's registered session key."
          ],
          "signer": true
        },
        {
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "player.owner",
                "account": "playerState"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "slot",
          "type": "u8"
        },
        {
          "name": "path",
          "type": "u8"
        }
      ]
    },
    {
      "name": "setSession",
      "docs": [
        "Sets (or clears, with the default pubkey) the session key that may sign",
        "non-paying events for this player. Owner only."
      ],
      "discriminator": [
        156,
        135,
        126,
        111,
        184,
        206,
        194,
        141
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "player"
          ]
        },
        {
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "session",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "sharkBite",
      "docs": [
        "A shark bite (equipment.ts resetDiveGear): every dive slot back to Lv1",
        "and every path back to the default. PEARL, materials and crafted items",
        "are untouched. The owner or the session key signs."
      ],
      "discriminator": [
        93,
        58,
        72,
        158,
        252,
        114,
        249,
        96
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The owner, or the player's registered session key."
          ],
          "signer": true
        },
        {
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "player.owner",
                "account": "playerState"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "synthUpgrade",
      "docs": [
        "Upgrades a slot at the synthesis station (main.ts synthUpgrade): one",
        "composite plate plus the station's own fee buys the next level."
      ],
      "discriminator": [
        54,
        192,
        10,
        15,
        127,
        69,
        156,
        46
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "player"
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
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "pearlMint",
          "writable": true
        },
        {
          "name": "ownerPearl",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "slot",
          "type": "u8"
        }
      ]
    },
    {
      "name": "updatePrices",
      "docs": [
        "Replaces every price table at once. Admin only."
      ],
      "discriminator": [
        62,
        161,
        234,
        136,
        106,
        26,
        18,
        160
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
          "name": "prices",
          "type": {
            "defined": {
              "name": "priceTable"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "aquarium",
      "discriminator": [
        83,
        39,
        33,
        207,
        228,
        184,
        2,
        132
      ]
    },
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
    },
    {
      "name": "playerState",
      "discriminator": [
        56,
        3,
        60,
        86,
        174,
        16,
        244,
        195
      ]
    }
  ],
  "events": [
    {
      "name": "configInitialized",
      "discriminator": [
        181,
        49,
        200,
        156,
        19,
        167,
        178,
        91
      ]
    },
    {
      "name": "crafted",
      "discriminator": [
        169,
        195,
        232,
        146,
        229,
        14,
        57,
        149
      ]
    },
    {
      "name": "fed",
      "discriminator": [
        123,
        143,
        103,
        16,
        214,
        190,
        110,
        102
      ]
    },
    {
      "name": "fishForgotten",
      "discriminator": [
        79,
        72,
        174,
        124,
        158,
        58,
        54,
        68
      ]
    },
    {
      "name": "oracleSet",
      "discriminator": [
        115,
        135,
        7,
        243,
        213,
        60,
        174,
        119
      ]
    },
    {
      "name": "pathSet",
      "discriminator": [
        213,
        247,
        91,
        194,
        111,
        98,
        44,
        184
      ]
    },
    {
      "name": "playerInitialized",
      "discriminator": [
        214,
        37,
        153,
        142,
        63,
        109,
        206,
        15
      ]
    },
    {
      "name": "pricesUpdated",
      "discriminator": [
        208,
        47,
        38,
        134,
        151,
        224,
        207,
        37
      ]
    },
    {
      "name": "sessionSet",
      "discriminator": [
        217,
        40,
        191,
        250,
        153,
        135,
        184,
        144
      ]
    },
    {
      "name": "sharkBite",
      "discriminator": [
        163,
        38,
        14,
        213,
        17,
        225,
        176,
        165
      ]
    },
    {
      "name": "synthUpgraded",
      "discriminator": [
        229,
        27,
        164,
        135,
        42,
        106,
        254,
        176
      ]
    },
    {
      "name": "upgradeBought",
      "discriminator": [
        142,
        82,
        129,
        123,
        102,
        228,
        164,
        240
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Signer is not allowed to do this"
    },
    {
      "code": 6001,
      "name": "invalidSlot",
      "msg": "Unknown equipment slot"
    },
    {
      "code": 6002,
      "name": "invalidPath",
      "msg": "Unknown path"
    },
    {
      "code": 6003,
      "name": "noPathsForSlot",
      "msg": "This slot has no module paths"
    },
    {
      "code": 6004,
      "name": "pathLocked",
      "msg": "Upgrade this slot to Lv2 before choosing a path"
    },
    {
      "code": 6005,
      "name": "maxLevel",
      "msg": "Already at the top level"
    },
    {
      "code": 6006,
      "name": "invalidRecipe",
      "msg": "Unknown recipe"
    },
    {
      "code": 6007,
      "name": "missingMaterials",
      "msg": "Not enough materials"
    },
    {
      "code": 6008,
      "name": "noComposite",
      "msg": "Craft a composite plate first"
    },
    {
      "code": 6009,
      "name": "insufficientPearl",
      "msg": "Not enough PEARL"
    },
    {
      "code": 6010,
      "name": "wrongMint",
      "msg": "Token account or mint is not the configured PEARL mint"
    },
    {
      "code": 6011,
      "name": "wrongTokenProgram",
      "msg": "Token program does not match the PEARL mint's"
    },
    {
      "code": 6012,
      "name": "wrongTokenOwner",
      "msg": "Token account is not owned by the signer"
    },
    {
      "code": 6013,
      "name": "invalidPriceTable",
      "msg": "Invalid price table"
    },
    {
      "code": 6014,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6015,
      "name": "invalidFood",
      "msg": "Unknown food"
    },
    {
      "code": 6016,
      "name": "badFishList",
      "msg": "Fish list must hold 1 to 64 keys"
    },
    {
      "code": 6017,
      "name": "fullyGrown",
      "msg": "Every listed fish is fully grown"
    },
    {
      "code": 6018,
      "name": "feedCooldown",
      "msg": "The school is still full (feeding cooldown)"
    },
    {
      "code": 6019,
      "name": "badClock",
      "msg": "Clock out of range"
    }
  ],
  "types": [
    {
      "name": "aquarium",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "entries",
            "docs": [
              "Sorted by key, so lookups are a binary search."
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "fishGrowth"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "admin",
            "docs": [
              "May change prices and the oracle. Set to the upgrade authority at init."
            ],
            "type": "pubkey"
          },
          {
            "name": "oracle",
            "docs": [
              "The market wallet that records catches (phase 2)."
            ],
            "type": "pubkey"
          },
          {
            "name": "pearlMint",
            "docs": [
              "The PEARL mint every payment burns."
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenProgram",
            "docs": [
              "The token program that owns the PEARL mint."
            ],
            "type": "pubkey"
          },
          {
            "name": "prices",
            "type": {
              "defined": {
                "name": "priceTable"
              }
            }
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "configInitialized",
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
            "name": "tokenProgram",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "crafted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "recipe",
            "type": "u8"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "materials",
            "type": {
              "array": [
                "u32",
                4
              ]
            }
          },
          {
            "name": "crafted",
            "type": {
              "array": [
                "u32",
                2
              ]
            }
          }
        ]
      }
    },
    {
      "name": "fed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "food",
            "type": "u8"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "fed",
            "docs": [
              "Fish that grew."
            ],
            "type": "u32"
          },
          {
            "name": "entries",
            "docs": [
              "Entries in the growth table afterwards."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "fishForgotten",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "removed",
            "type": "u32"
          },
          {
            "name": "entries",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "fishGrowth",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "key",
            "docs": [
              "The fish's 8-byte key (the client's choice: fish id or asset-id prefix)."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "growthMilli",
            "docs": [
              "Growth units x1000, capped at max_growth_milli."
            ],
            "type": "u16"
          },
          {
            "name": "feedCount",
            "type": "u8"
          },
          {
            "name": "food",
            "docs": [
              "The food it last ate (its cooldown multiplier applies to the next feed)."
            ],
            "type": "u8"
          },
          {
            "name": "lastFed",
            "docs": [
              "Unix seconds of the last accepted feed; 0 = never."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "oracleSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oracle",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "pathSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "slot",
            "type": "u8"
          },
          {
            "name": "path",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "playerInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "session",
            "type": "pubkey"
          },
          {
            "name": "materials",
            "type": {
              "array": [
                "u32",
                4
              ]
            }
          }
        ]
      }
    },
    {
      "name": "playerState",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "flags",
            "docs": [
              "Bit flags, all 0 in phase 1 (phase 2: in-dive, etc.)."
            ],
            "type": "u16"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "session",
            "docs": [
              "Optional delegate for non-paying events; the default pubkey means none."
            ],
            "type": "pubkey"
          },
          {
            "name": "levels",
            "docs": [
              "Level per slot (rod, reel, net, fins, tank, lamp, sonar), 1..=3."
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          },
          {
            "name": "paths",
            "docs": [
              "Path per slot (rod, reel, net, fins, tank, lamp), 0 = default."
            ],
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          },
          {
            "name": "materials",
            "docs": [
              "scale, fiber, scrap, crystal."
            ],
            "type": {
              "array": [
                "u32",
                4
              ]
            }
          },
          {
            "name": "crafted",
            "docs": [
              "bait, composite."
            ],
            "type": {
              "array": [
                "u32",
                2
              ]
            }
          },
          {
            "name": "bestValue",
            "docs": [
              "Best catch value, recorded by the oracle in phase 2."
            ],
            "type": "u64"
          },
          {
            "name": "reserved",
            "docs": [
              "Zeroed space for later fields (dive start/end, counters)."
            ],
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          }
        ]
      }
    },
    {
      "name": "priceTable",
      "docs": [
        "Every price and rule number the program reads. Amounts are PEARL base units",
        "(the mint has 0 decimals, so 1 unit = 1 PEARL)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "upgrade",
            "docs": [
              "`[slot][level - 1]`: PEARL to buy that level. Level 1 is the starting gear and must be 0."
            ],
            "type": {
              "array": [
                {
                  "array": [
                    "u64",
                    3
                  ]
                },
                7
              ]
            }
          },
          {
            "name": "synthUpgrade",
            "docs": [
              "`[slot][current level - 1]`: the synthesis station's fee for Lv1->2 and Lv2->3."
            ],
            "type": {
              "array": [
                {
                  "array": [
                    "u64",
                    2
                  ]
                },
                7
              ]
            }
          },
          {
            "name": "recipeCost",
            "docs": [
              "PEARL per craft, per recipe."
            ],
            "type": {
              "array": [
                "u64",
                2
              ]
            }
          },
          {
            "name": "recipeNeeds",
            "docs": [
              "`[recipe][material]`: materials one craft consumes."
            ],
            "type": {
              "array": [
                {
                  "array": [
                    "u32",
                    4
                  ]
                },
                2
              ]
            }
          },
          {
            "name": "startingMaterials",
            "docs": [
              "Materials a new player starts with (DEFAULT_SYNTHESIS)."
            ],
            "type": {
              "array": [
                "u32",
                4
              ]
            }
          },
          {
            "name": "foodPrice",
            "docs": [
              "PEARL per pour, per food."
            ],
            "type": {
              "array": [
                "u64",
                5
              ]
            }
          },
          {
            "name": "foodGrowthMilli",
            "docs": [
              "Growth units per feed, x1000 (growthMultiplier)."
            ],
            "type": {
              "array": [
                "u16",
                5
              ]
            }
          },
          {
            "name": "foodCooldownMilli",
            "docs": [
              "Cooldown multiplier of the food a fish last ate, x1000 (feedCooldownMultiplier)."
            ],
            "type": {
              "array": [
                "u16",
                5
              ]
            }
          },
          {
            "name": "feedCooldownMs",
            "docs": [
              "Base cooldown between feeds of one fish, in ms (FEED_COOLDOWN_MS)."
            ],
            "type": "u32"
          },
          {
            "name": "maxGrowthMilli",
            "docs": [
              "Growth cap, x1000 (MAX_GROWTH_UNITS)."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "pricesUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "sessionSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "session",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "sharkBite",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "by",
            "docs": [
              "Who signed: the owner or the session key."
            ],
            "type": "pubkey"
          },
          {
            "name": "dropped",
            "docs": [
              "The levels before the reset."
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          }
        ]
      }
    },
    {
      "name": "synthUpgraded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "slot",
            "type": "u8"
          },
          {
            "name": "level",
            "type": "u8"
          },
          {
            "name": "price",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "upgradeBought",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "slot",
            "type": "u8"
          },
          {
            "name": "level",
            "type": "u8"
          },
          {
            "name": "price",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
