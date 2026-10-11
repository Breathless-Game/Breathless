//! player_state: a Breathless player's progress, on chain.
//!
//! One `PlayerState` PDA per wallet (`["player", owner]`) holds the dive-gear
//! levels and module paths, the synthesis materials and crafted items, and room
//! for later phases (best catch value, dive flags). One `Aquarium` PDA per
//! wallet (`["aquarium", owner]`) holds the per-fish feeding growth table.
//!
//! Everything that costs PEARL burns it from the owner's token account through
//! a CPI to the mint's token program in the same instruction that changes the
//! state, so a purchase is atomic: either both happen or neither does. Prices
//! live in the `Config` PDA (`["config"]`), set by the admin (the program's
//! upgrade authority), never by the client.
//!
//! The rules mirror the game (game/src/equipment.ts, synthesis.ts, main.ts,
//! aquarium-state.ts, fish-food.ts). Health and breath data never come here.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};

declare_id!("EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ");

pub const CONFIG_SEED: &[u8] = b"config";
pub const PLAYER_SEED: &[u8] = b"player";
pub const AQUARIUM_SEED: &[u8] = b"aquarium";

/// Upgradeable slots, in the order of DIVE_GEAR_SLOTS (game/src/equipment.ts):
/// rod, reel, net, fins, tank, lamp, sonar. The first six have module paths.
pub const SLOT_COUNT: usize = 7;
pub const PATH_SLOT_COUNT: usize = 6;
/// Levels are 1-based like the game: 1 is the starting gear, 3 the top.
pub const MAX_LEVEL: u8 = 3;
/// Two mutually exclusive paths per slot; 0 is the game's default path.
pub const PATH_COUNT: u8 = 2;
/// Materials: scale, fiber, scrap, crystal (MATERIALS in synthesis.ts).
pub const MATERIAL_COUNT: usize = 4;
/// Recipes: bait, composite (RECIPES in synthesis.ts).
pub const RECIPE_COUNT: usize = 2;
pub const RECIPE_COMPOSITE: usize = 1;
/// Foods: plankton, pellet, krill, shrimp, glowCoral (FISH_FOODS in fish-food.ts).
pub const FOOD_COUNT: usize = 5;
/// Most fish one `feed` / `forget_fish` call takes. A tank holds 50 (aquarium.ts TANK_SIZE).
pub const MAX_FISH_PER_CALL: usize = 64;
/// Growth and multipliers are fixed point, 1000 = 1.0.
pub const MILLI: u64 = 1000;

pub const PLAYER_VERSION: u8 = 1;
pub const CONFIG_VERSION: u8 = 1;
pub const AQUARIUM_VERSION: u8 = 1;

/// Every price and rule number the program reads. Amounts are PEARL base units
/// (the mint has 0 decimals, so 1 unit = 1 PEARL).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct PriceTable {
    /// `[slot][level - 1]`: PEARL to buy that level. Level 1 is the starting gear and must be 0.
    pub upgrade: [[u64; 3]; SLOT_COUNT],
    /// `[slot][current level - 1]`: the synthesis station's fee for Lv1->2 and Lv2->3.
    pub synth_upgrade: [[u64; 2]; SLOT_COUNT],
    /// PEARL per craft, per recipe.
    pub recipe_cost: [u64; RECIPE_COUNT],
    /// `[recipe][material]`: materials one craft consumes.
    pub recipe_needs: [[u32; MATERIAL_COUNT]; RECIPE_COUNT],
    /// Materials a new player starts with (DEFAULT_SYNTHESIS).
    pub starting_materials: [u32; MATERIAL_COUNT],
    /// PEARL per pour, per food.
    pub food_price: [u64; FOOD_COUNT],
    /// Growth units per feed, x1000 (growthMultiplier).
    pub food_growth_milli: [u16; FOOD_COUNT],
    /// Cooldown multiplier of the food a fish last ate, x1000 (feedCooldownMultiplier).
    pub food_cooldown_milli: [u16; FOOD_COUNT],
    /// Base cooldown between feeds of one fish, in ms (FEED_COOLDOWN_MS).
    pub feed_cooldown_ms: u32,
    /// Growth cap, x1000 (MAX_GROWTH_UNITS).
    pub max_growth_milli: u16,
}

impl PriceTable {
    pub fn validate(&self) -> Result<()> {
        for slot in self.upgrade.iter() {
            require!(slot[0] == 0, PlayerStateError::InvalidPriceTable);
            require!(slot[1] > 0 && slot[2] > 0, PlayerStateError::InvalidPriceTable);
        }
        for slot in self.synth_upgrade.iter() {
            require!(slot[0] > 0 && slot[1] > 0, PlayerStateError::InvalidPriceTable);
        }
        for cost in self.recipe_cost.iter() {
            require!(*cost > 0, PlayerStateError::InvalidPriceTable);
        }
        for i in 0..FOOD_COUNT {
            require!(self.food_price[i] > 0, PlayerStateError::InvalidPriceTable);
            require!(self.food_growth_milli[i] > 0, PlayerStateError::InvalidPriceTable);
            require!(self.food_cooldown_milli[i] > 0, PlayerStateError::InvalidPriceTable);
        }
        require!(self.max_growth_milli > 0, PlayerStateError::InvalidPriceTable);
        Ok(())
    }
}

#[program]
pub mod player_state {
    use super::*;

    /// Creates the config. Only the program's upgrade authority may call it,
    /// so nobody can front-run the deploy and take the admin seat.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        oracle: Pubkey,
        prices: PriceTable,
    ) -> Result<()> {
        prices.validate()?;
        let config = &mut ctx.accounts.config;
        config.version = CONFIG_VERSION;
        config.bump = ctx.bumps.config;
        config.admin = ctx.accounts.admin.key();
        config.oracle = oracle;
        config.pearl_mint = ctx.accounts.pearl_mint.key();
        config.token_program = ctx.accounts.token_program.key();
        config.prices = prices;
        config.reserved = [0; 64];
        emit!(ConfigInitialized {
            admin: config.admin,
            oracle,
            pearl_mint: config.pearl_mint,
            token_program: config.token_program,
        });
        Ok(())
    }

    /// Replaces every price table at once. Admin only.
    pub fn update_prices(ctx: Context<AdminOnly>, prices: PriceTable) -> Result<()> {
        prices.validate()?;
        ctx.accounts.config.prices = prices;
        emit!(PricesUpdated { admin: ctx.accounts.admin.key() });
        Ok(())
    }

    /// Replaces the oracle (the market wallet that records catches in later phases). Admin only.
    pub fn set_oracle(ctx: Context<AdminOnly>, oracle: Pubkey) -> Result<()> {
        ctx.accounts.config.oracle = oracle;
        emit!(OracleSet { oracle });
        Ok(())
    }

    /// Creates the player's state and aquarium. The owner signs and pays rent.
    /// Everyone starts from zero: gear at Lv1, default paths, the default materials.
    pub fn init_player(ctx: Context<InitPlayer>, session: Pubkey) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        let player = &mut ctx.accounts.player;
        player.version = PLAYER_VERSION;
        player.bump = ctx.bumps.player;
        player.flags = 0;
        player.owner = owner;
        player.session = session;
        player.levels = [1; SLOT_COUNT];
        player.paths = [0; PATH_SLOT_COUNT];
        player.materials = ctx.accounts.config.prices.starting_materials;
        player.crafted = [0; RECIPE_COUNT];
        player.best_value = 0;
        player.reserved = [0; 128];

        let aquarium = &mut ctx.accounts.aquarium;
        aquarium.version = AQUARIUM_VERSION;
        aquarium.bump = ctx.bumps.aquarium;
        aquarium.owner = owner;
        aquarium.reserved = [0; 16];
        aquarium.entries = Vec::new();

        emit!(PlayerInitialized { owner, session, materials: player.materials });
        Ok(())
    }

    /// Sets (or clears, with the default pubkey) the session key that may sign
    /// non-paying events for this player. Owner only.
    pub fn set_session(ctx: Context<OwnerOnly>, session: Pubkey) -> Result<()> {
        ctx.accounts.player.session = session;
        emit!(SessionSet { owner: ctx.accounts.owner.key(), session });
        Ok(())
    }

    /// Buys the next level of a slot at the Config price (main.ts buyNextUpgrade).
    pub fn buy_upgrade(ctx: Context<Spend>, slot: u8) -> Result<()> {
        let s = slot_index(slot)?;
        let level = ctx.accounts.player.levels[s];
        require!(level < MAX_LEVEL, PlayerStateError::MaxLevel);
        let next = level + 1;
        let price = ctx.accounts.config.prices.upgrade[s][(next - 1) as usize];
        ctx.accounts.burn(price)?;
        ctx.accounts.player.levels[s] = next;
        emit!(UpgradeBought { owner: ctx.accounts.owner.key(), slot, level: next, price });
        Ok(())
    }

    /// Chooses a slot's module path (equipment.ts setEquipmentPath): free, any
    /// number of times, only once the slot is Lv2+, sonar has none. The owner
    /// or the session key signs.
    pub fn set_path(ctx: Context<OwnerOrSession>, slot: u8, path: u8) -> Result<()> {
        let s = slot_index(slot)?;
        require!(s < PATH_SLOT_COUNT, PlayerStateError::NoPathsForSlot);
        require!(path < PATH_COUNT, PlayerStateError::InvalidPath);
        let player = &mut ctx.accounts.player;
        require!(player.levels[s] >= 2, PlayerStateError::PathLocked);
        player.paths[s] = path;
        emit!(PathSet { owner: player.owner, slot, path });
        Ok(())
    }

    /// Crafts one recipe (synthesis.ts craft): needs the materials, burns the
    /// recipe cost, consumes the materials, adds one crafted item.
    pub fn craft(ctx: Context<Spend>, recipe: u8) -> Result<()> {
        let r = recipe as usize;
        require!(r < RECIPE_COUNT, PlayerStateError::InvalidRecipe);
        let needs = ctx.accounts.config.prices.recipe_needs[r];
        let price = ctx.accounts.config.prices.recipe_cost[r];
        let mut materials = ctx.accounts.player.materials;
        for i in 0..MATERIAL_COUNT {
            materials[i] = materials[i]
                .checked_sub(needs[i])
                .ok_or(PlayerStateError::MissingMaterials)?;
        }
        let crafted = ctx.accounts.player.crafted[r]
            .checked_add(1)
            .ok_or(PlayerStateError::Overflow)?;
        ctx.accounts.burn(price)?;
        let player = &mut ctx.accounts.player;
        player.materials = materials;
        player.crafted[r] = crafted;
        emit!(Crafted {
            owner: player.owner,
            recipe,
            price,
            materials,
            crafted: player.crafted,
        });
        Ok(())
    }

    /// Upgrades a slot at the synthesis station (main.ts synthUpgrade): one
    /// composite plate plus the station's own fee buys the next level.
    pub fn synth_upgrade(ctx: Context<Spend>, slot: u8) -> Result<()> {
        let s = slot_index(slot)?;
        let level = ctx.accounts.player.levels[s];
        require!(level < MAX_LEVEL, PlayerStateError::MaxLevel);
        require!(
            ctx.accounts.player.crafted[RECIPE_COMPOSITE] >= 1,
            PlayerStateError::NoComposite
        );
        let price = ctx.accounts.config.prices.synth_upgrade[s][(level - 1) as usize];
        ctx.accounts.burn(price)?;
        let player = &mut ctx.accounts.player;
        player.crafted[RECIPE_COMPOSITE] -= 1;
        player.levels[s] = level + 1;
        emit!(SynthUpgraded { owner: player.owner, slot, level: level + 1, price });
        Ok(())
    }

    /// A shark bite (equipment.ts resetDiveGear): every dive slot back to Lv1
    /// and every path back to the default. PEARL, materials and crafted items
    /// are untouched. The owner or the session key signs.
    pub fn shark_bite(ctx: Context<OwnerOrSession>) -> Result<()> {
        let player = &mut ctx.accounts.player;
        let dropped = player.levels;
        player.levels = [1; SLOT_COUNT];
        player.paths = [0; PATH_SLOT_COUNT];
        emit!(SharkBite { owner: player.owner, by: ctx.accounts.authority.key(), dropped });
        Ok(())
    }

    /// One pour of food over a school (aquarium.ts feedSchool): every listed
    /// fish that is neither fully grown nor still in its cooldown grows by the
    /// food's weight, and the food's price is burned once. If no listed fish
    /// can eat, the whole call fails and nothing is burned.
    pub fn feed(ctx: Context<Feed>, food: u8, fish: Vec<[u8; 8]>) -> Result<()> {
        let f = food as usize;
        require!(f < FOOD_COUNT, PlayerStateError::InvalidFood);
        require!(
            !fish.is_empty() && fish.len() <= MAX_FISH_PER_CALL,
            PlayerStateError::BadFishList
        );
        let prices = ctx.accounts.config.prices.clone();
        let now = Clock::get()?.unix_timestamp;
        require!(now > 0 && now <= u32::MAX as i64, PlayerStateError::BadClock);
        let now = now as u32;

        let entries = &mut ctx.accounts.aquarium.entries;
        let mut fed: u32 = 0;
        let mut first_block: Option<PlayerStateError> = None;
        for key in fish.iter() {
            let idx = match entries.binary_search_by(|e| e.key.cmp(key)) {
                Ok(i) => i,
                Err(i) => {
                    entries.insert(i, FishGrowth { key: *key, ..FishGrowth::default() });
                    i
                }
            };
            let e = &mut entries[idx];
            match feed_one(e, f, now, &prices) {
                Ok(()) => fed += 1,
                Err(reason) => {
                    first_block.get_or_insert(reason);
                }
            }
        }
        if fed == 0 {
            return Err(first_block.unwrap_or(PlayerStateError::BadFishList).into());
        }
        // Entries the call created but could not feed are dropped again (cannot happen for
        // a fresh fish today, but keep the table to fed fish only).
        entries.retain(|e| e.last_fed != 0);
        let len = entries.len();

        let price = prices.food_price[f];
        ctx.accounts.burn(price)?;
        ctx.accounts.resize_aquarium(len)?;
        emit!(Fed { owner: ctx.accounts.owner.key(), food, price, fed, entries: len as u32 });
        Ok(())
    }

    /// Drops growth entries for fish the client says are gone (sold or burned)
    /// and refunds the freed rent to the owner. Unknown keys are ignored.
    pub fn forget_fish(ctx: Context<ForgetFish>, fish: Vec<[u8; 8]>) -> Result<()> {
        require!(
            !fish.is_empty() && fish.len() <= MAX_FISH_PER_CALL,
            PlayerStateError::BadFishList
        );
        let aquarium = &mut ctx.accounts.aquarium;
        let before = aquarium.entries.len();
        aquarium.entries.retain(|e| !fish.contains(&e.key));
        let removed = before - aquarium.entries.len();
        let new_size = Aquarium::space(aquarium.entries.len());
        let info = aquarium.to_account_info();
        if new_size < info.data_len() {
            info.resize(new_size)?;
            let keep = Rent::get()?.minimum_balance(new_size);
            let excess = info.lamports().saturating_sub(keep);
            if excess > 0 {
                **info.try_borrow_mut_lamports()? -= excess;
                **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += excess;
            }
        }
        emit!(FishForgotten {
            owner: ctx.accounts.owner.key(),
            removed: removed as u32,
            entries: aquarium.entries.len() as u32,
        });
        Ok(())
    }
}

/// aquarium-state.ts feedFish: fully grown first, then the cooldown of the
/// food the fish last ate, then growth capped at the maximum.
fn feed_one(e: &mut FishGrowth, food: usize, now: u32, p: &PriceTable) -> std::result::Result<(), PlayerStateError> {
    if e.growth_milli >= p.max_growth_milli {
        return Err(PlayerStateError::FullyGrown);
    }
    if e.last_fed != 0 {
        let prev = (e.food as usize).min(FOOD_COUNT - 1);
        let cooldown_ms = (p.feed_cooldown_ms as u64) * (p.food_cooldown_milli[prev] as u64) / MILLI;
        let elapsed_ms = (now.saturating_sub(e.last_fed) as u64) * 1000;
        if elapsed_ms < cooldown_ms {
            return Err(PlayerStateError::FeedCooldown);
        }
    }
    let grown = (e.growth_milli as u32 + p.food_growth_milli[food] as u32).min(p.max_growth_milli as u32);
    e.growth_milli = grown as u16;
    e.feed_count = e.feed_count.saturating_add(1);
    e.food = food as u8;
    e.last_fed = now;
    Ok(())
}

fn slot_index(slot: u8) -> Result<usize> {
    let s = slot as usize;
    require!(s < SLOT_COUNT, PlayerStateError::InvalidSlot);
    Ok(s)
}

// ---------------------------------------------------------------- accounts

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    /// May change prices and the oracle. Set to the upgrade authority at init.
    pub admin: Pubkey,
    /// The market wallet that records catches (phase 2).
    pub oracle: Pubkey,
    /// The PEARL mint every payment burns.
    pub pearl_mint: Pubkey,
    /// The token program that owns the PEARL mint.
    pub token_program: Pubkey,
    pub prices: PriceTable,
    pub reserved: [u8; 64],
}

#[account]
#[derive(InitSpace)]
pub struct PlayerState {
    pub version: u8,
    pub bump: u8,
    /// Bit flags, all 0 in phase 1 (phase 2: in-dive, etc.).
    pub flags: u16,
    pub owner: Pubkey,
    /// Optional delegate for non-paying events; the default pubkey means none.
    pub session: Pubkey,
    /// Level per slot (rod, reel, net, fins, tank, lamp, sonar), 1..=3.
    pub levels: [u8; SLOT_COUNT],
    /// Path per slot (rod, reel, net, fins, tank, lamp), 0 = default.
    pub paths: [u8; PATH_SLOT_COUNT],
    /// scale, fiber, scrap, crystal.
    pub materials: [u32; MATERIAL_COUNT],
    /// bait, composite.
    pub crafted: [u32; RECIPE_COUNT],
    /// Best catch value, recorded by the oracle in phase 2.
    pub best_value: u64,
    /// Zeroed space for later fields (dive start/end, counters).
    pub reserved: [u8; 128],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug, InitSpace)]
pub struct FishGrowth {
    /// The fish's 8-byte key (the client's choice: fish id or asset-id prefix).
    pub key: [u8; 8],
    /// Growth units x1000, capped at max_growth_milli.
    pub growth_milli: u16,
    pub feed_count: u8,
    /// The food it last ate (its cooldown multiplier applies to the next feed).
    pub food: u8,
    /// Unix seconds of the last accepted feed; 0 = never.
    pub last_fed: u32,
}

impl FishGrowth {
    pub const SIZE: usize = 8 + 2 + 1 + 1 + 4;
}

#[account]
pub struct Aquarium {
    pub version: u8,
    pub bump: u8,
    pub owner: Pubkey,
    pub reserved: [u8; 16],
    /// Sorted by key, so lookups are a binary search.
    pub entries: Vec<FishGrowth>,
}

impl Aquarium {
    pub const BASE: usize = 8 + 1 + 1 + 32 + 16 + 4;
    pub fn space(entries: usize) -> usize {
        Self::BASE + entries * FishGrowth::SIZE
    }
}

// ------------------------------------------------------------ instructions

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(
        constraint = *pearl_mint.to_account_info().owner == token_program.key() @ PlayerStateError::WrongTokenProgram
    )]
    pub pearl_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ PlayerStateError::Unauthorized)]
    pub program: Program<'info, crate::program::PlayerState>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ PlayerStateError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ PlayerStateError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct InitPlayer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = owner,
        space = 8 + PlayerState::INIT_SPACE,
        seeds = [PLAYER_SEED, owner.key().as_ref()],
        bump
    )]
    pub player: Account<'info, PlayerState>,
    #[account(
        init,
        payer = owner,
        space = Aquarium::space(0),
        seeds = [AQUARIUM_SEED, owner.key().as_ref()],
        bump
    )]
    pub aquarium: Account<'info, Aquarium>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [PLAYER_SEED, owner.key().as_ref()],
        bump = player.bump,
        has_one = owner @ PlayerStateError::Unauthorized
    )]
    pub player: Account<'info, PlayerState>,
}

#[derive(Accounts)]
pub struct OwnerOrSession<'info> {
    /// The owner, or the player's registered session key.
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [PLAYER_SEED, player.owner.as_ref()],
        bump = player.bump,
        constraint = authority.key() == player.owner
            || (player.session != Pubkey::default() && authority.key() == player.session)
            @ PlayerStateError::Unauthorized
    )]
    pub player: Account<'info, PlayerState>,
}

/// Accounts for every instruction that burns the owner's PEARL.
#[derive(Accounts)]
pub struct Spend<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [PLAYER_SEED, owner.key().as_ref()],
        bump = player.bump,
        has_one = owner @ PlayerStateError::Unauthorized
    )]
    pub player: Account<'info, PlayerState>,
    #[account(mut, address = config.pearl_mint @ PlayerStateError::WrongMint)]
    pub pearl_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        constraint = owner_pearl.mint == pearl_mint.key() @ PlayerStateError::WrongMint,
        constraint = owner_pearl.owner == owner.key() @ PlayerStateError::WrongTokenOwner,
        constraint = *owner_pearl.to_account_info().owner == token_program.key() @ PlayerStateError::WrongTokenProgram
    )]
    pub owner_pearl: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.token_program @ PlayerStateError::WrongTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> Spend<'info> {
    fn burn(&self, amount: u64) -> Result<()> {
        burn_pearl(&self.owner, &self.pearl_mint, &self.owner_pearl, &self.token_program, amount)
    }
}

#[derive(Accounts)]
pub struct Feed<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [AQUARIUM_SEED, owner.key().as_ref()],
        bump = aquarium.bump,
        has_one = owner @ PlayerStateError::Unauthorized
    )]
    pub aquarium: Account<'info, Aquarium>,
    #[account(mut, address = config.pearl_mint @ PlayerStateError::WrongMint)]
    pub pearl_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        constraint = owner_pearl.mint == pearl_mint.key() @ PlayerStateError::WrongMint,
        constraint = owner_pearl.owner == owner.key() @ PlayerStateError::WrongTokenOwner,
        constraint = *owner_pearl.to_account_info().owner == token_program.key() @ PlayerStateError::WrongTokenProgram
    )]
    pub owner_pearl: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.token_program @ PlayerStateError::WrongTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> Feed<'info> {
    fn burn(&self, amount: u64) -> Result<()> {
        burn_pearl(&self.owner, &self.pearl_mint, &self.owner_pearl, &self.token_program, amount)
    }

    /// Grows the aquarium account to fit `entries` (the owner pays the extra rent).
    fn resize_aquarium(&self, entries: usize) -> Result<()> {
        let new_size = Aquarium::space(entries);
        let info = self.aquarium.to_account_info();
        if new_size <= info.data_len() {
            return Ok(());
        }
        let need = Rent::get()?.minimum_balance(new_size).saturating_sub(info.lamports());
        if need > 0 {
            system_program::transfer(
                CpiContext::new(
                    self.system_program.to_account_info(),
                    system_program::Transfer { from: self.owner.to_account_info(), to: info.clone() },
                ),
                need,
            )?;
        }
        info.resize(new_size)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ForgetFish<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [AQUARIUM_SEED, owner.key().as_ref()],
        bump = aquarium.bump,
        has_one = owner @ PlayerStateError::Unauthorized
    )]
    pub aquarium: Account<'info, Aquarium>,
}

/// Burns `amount` PEARL from the owner's token account; the owner signs. The
/// balance is checked first so a short wallet fails with a clear error.
fn burn_pearl<'info>(
    owner: &Signer<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    from: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, PlayerStateError::InvalidPriceTable);
    require!(from.amount >= amount, PlayerStateError::InsufficientPearl);
    token_interface::burn(
        CpiContext::new(
            token_program.to_account_info(),
            Burn {
                mint: mint.to_account_info(),
                from: from.to_account_info(),
                authority: owner.to_account_info(),
            },
        ),
        amount,
    )
}

// ------------------------------------------------------------------ events

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub pearl_mint: Pubkey,
    pub token_program: Pubkey,
}

#[event]
pub struct PricesUpdated {
    pub admin: Pubkey,
}

#[event]
pub struct OracleSet {
    pub oracle: Pubkey,
}

#[event]
pub struct PlayerInitialized {
    pub owner: Pubkey,
    pub session: Pubkey,
    pub materials: [u32; MATERIAL_COUNT],
}

#[event]
pub struct SessionSet {
    pub owner: Pubkey,
    pub session: Pubkey,
}

#[event]
pub struct UpgradeBought {
    pub owner: Pubkey,
    pub slot: u8,
    pub level: u8,
    pub price: u64,
}

#[event]
pub struct PathSet {
    pub owner: Pubkey,
    pub slot: u8,
    pub path: u8,
}

#[event]
pub struct Crafted {
    pub owner: Pubkey,
    pub recipe: u8,
    pub price: u64,
    pub materials: [u32; MATERIAL_COUNT],
    pub crafted: [u32; RECIPE_COUNT],
}

#[event]
pub struct SynthUpgraded {
    pub owner: Pubkey,
    pub slot: u8,
    pub level: u8,
    pub price: u64,
}

#[event]
pub struct SharkBite {
    pub owner: Pubkey,
    /// Who signed: the owner or the session key.
    pub by: Pubkey,
    /// The levels before the reset.
    pub dropped: [u8; SLOT_COUNT],
}

#[event]
pub struct Fed {
    pub owner: Pubkey,
    pub food: u8,
    pub price: u64,
    /// Fish that grew.
    pub fed: u32,
    /// Entries in the growth table afterwards.
    pub entries: u32,
}

#[event]
pub struct FishForgotten {
    pub owner: Pubkey,
    pub removed: u32,
    pub entries: u32,
}

// ------------------------------------------------------------------ errors

#[error_code]
pub enum PlayerStateError {
    #[msg("Signer is not allowed to do this")]
    Unauthorized,
    #[msg("Unknown equipment slot")]
    InvalidSlot,
    #[msg("Unknown path")]
    InvalidPath,
    #[msg("This slot has no module paths")]
    NoPathsForSlot,
    #[msg("Upgrade this slot to Lv2 before choosing a path")]
    PathLocked,
    #[msg("Already at the top level")]
    MaxLevel,
    #[msg("Unknown recipe")]
    InvalidRecipe,
    #[msg("Not enough materials")]
    MissingMaterials,
    #[msg("Craft a composite plate first")]
    NoComposite,
    #[msg("Not enough PEARL")]
    InsufficientPearl,
    #[msg("Token account or mint is not the configured PEARL mint")]
    WrongMint,
    #[msg("Token program does not match the PEARL mint's")]
    WrongTokenProgram,
    #[msg("Token account is not owned by the signer")]
    WrongTokenOwner,
    #[msg("Invalid price table")]
    InvalidPriceTable,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Unknown food")]
    InvalidFood,
    #[msg("Fish list must hold 1 to 64 keys")]
    BadFishList,
    #[msg("Every listed fish is fully grown")]
    FullyGrown,
    #[msg("The school is still full (feeding cooldown)")]
    FeedCooldown,
    #[msg("Clock out of range")]
    BadClock,
}
