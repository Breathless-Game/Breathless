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
//!
//! v2 (additive: the v1 accounts, instructions and error codes are unchanged)
//! adds one `Progress` PDA per wallet (`["progress", owner]`) with the boat
//! levels (upgrades.ts group 'boat'), the shipyard ship sailed, the lifetime
//! banked value that unlocks ships and maps, the best single catch, and a
//! sorted log of every recorded fish key so `record_catch` is idempotent.
//! Boat prices and the ship / map thresholds live in a separate admin-set
//! `ProgressConfig` PDA (`["progress_config"]`), so the Config layout is
//! untouched. `record_catch` is signed by `Config.oracle` (the market wallet)
//! and needs no PlayerState: new players mint fish before they buy anything.

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

// ---- v2
pub const PROGRESS_SEED: &[u8] = b"progress";
pub const PROGRESS_CONFIG_SEED: &[u8] = b"progress_config";
pub const PROGRESS_VERSION: u8 = 1;
pub const PROGRESS_CONFIG_VERSION: u8 = 1;
/// Boat pieces, in the order of BOAT_IDS (game/src/gear-nft.ts): bait, boat,
/// boatSpeed, boatHull, boatDeck. Levels 1..=MAX_LEVEL like the dive gear.
pub const BOAT_SLOT_COUNT: usize = 5;
/// Shipyard ships, in the order of SHIPS (game/src/ships.ts).
pub const SHIP_COUNT: usize = 6;
/// Maps, in the order of MAPS (game/src/maps.ts): fjord, tianchi (Heaven Lake), ocean.
pub const MAP_COUNT: usize = 3;
/// Bytes per fish key in the Progress catch log.
pub const CATCH_KEY_SIZE: usize = 8;

// The v1 layouts that the deployed program writes and v1 clients decode. v2
// must never change them (game/src/player-state.ts CONFIG_SIZE etc.).
const _: () = assert!(8 + Config::INIT_SPACE == 612);
const _: () = assert!(8 + PlayerState::INIT_SPACE == 249);
const _: () = assert!(Aquarium::BASE == 62);
const _: () = assert!(Progress::SIZE == 100);

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

/// v2 rules, admin-set in `ProgressConfig`. Amounts are PEARL / banked value units.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct ProgressRules {
    /// `[boat slot][level - 1]`: PEARL to buy that level (upgrades.ts prices). Level 1 must be 0.
    pub boat_prices: [[u64; 3]; BOAT_SLOT_COUNT],
    /// Lifetime banked value that unlocks each ship (ships.ts SHIPS[].threshold). Ship 0 must be 0.
    pub ship_thresholds: [u64; SHIP_COUNT],
    /// Lifetime banked value that unlocks each map (maps.ts unlockValue). Map 0 must be 0.
    pub map_thresholds: [u64; MAP_COUNT],
}

impl ProgressRules {
    pub fn validate(&self) -> Result<()> {
        for slot in self.boat_prices.iter() {
            require!(slot[0] == 0, PlayerStateError::InvalidProgressRules);
            require!(slot[1] > 0 && slot[2] > 0, PlayerStateError::InvalidProgressRules);
        }
        require!(non_decreasing_from_zero(&self.ship_thresholds), PlayerStateError::InvalidProgressRules);
        require!(non_decreasing_from_zero(&self.map_thresholds), PlayerStateError::InvalidProgressRules);
        Ok(())
    }
}

fn non_decreasing_from_zero(v: &[u64]) -> bool {
    v.first() == Some(&0) && v.windows(2).all(|w| w[0] <= w[1])
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

    // ---------------------------------------------------------- v2: progress

    /// Creates the `ProgressConfig` (boat prices, ship and map thresholds). Config admin only.
    pub fn init_progress_config(ctx: Context<InitProgressConfig>, rules: ProgressRules) -> Result<()> {
        rules.validate()?;
        let pc = &mut ctx.accounts.progress_config;
        pc.version = PROGRESS_CONFIG_VERSION;
        pc.bump = ctx.bumps.progress_config;
        pc.rules = rules;
        pc.reserved = [0; 64];
        emit!(ProgressRulesSet { admin: ctx.accounts.admin.key() });
        Ok(())
    }

    /// Replaces the boat prices and the ship / map thresholds. Config admin only.
    pub fn set_progress_config(ctx: Context<AdminProgressConfig>, rules: ProgressRules) -> Result<()> {
        rules.validate()?;
        ctx.accounts.progress_config.rules = rules;
        emit!(ProgressRulesSet { admin: ctx.accounts.admin.key() });
        Ok(())
    }

    /// Buys `level` of a boat piece at the ProgressConfig price, burning the
    /// PEARL in the same instruction (the boat twin of `buy_upgrade`). `level`
    /// must be exactly the next one, so a resent or doubled transaction can
    /// never buy two levels. Creates the owner's Progress on first use (the
    /// owner pays its rent). Nothing ever lowers a boat level: a shark bite
    /// only resets the dive gear (equipment.ts DIVE_GEAR_SLOTS).
    pub fn buy_boat(ctx: Context<BuyBoat>, slot: u8, level: u8) -> Result<()> {
        let s = slot as usize;
        require!(s < BOAT_SLOT_COUNT, PlayerStateError::InvalidBoatSlot);
        let a = &ctx.accounts;
        let owner = a.owner.key();
        let info = a.progress.to_account_info();
        let mut progress =
            load_or_create_progress(&info, &owner, &a.owner.to_account_info(), &a.system_program, ctx.bumps.progress)?;
        let current = progress.boat_levels[s];
        require!(current < MAX_LEVEL && level <= MAX_LEVEL, PlayerStateError::MaxLevel);
        require!(level == current + 1, PlayerStateError::NotNextLevel);
        let price = a.progress_config.rules.boat_prices[s][(level - 1) as usize];
        burn_pearl(&a.owner, &a.pearl_mint, &a.owner_pearl, &a.token_program, price)?;
        progress.boat_levels[s] = level;
        store_progress(&info, &progress)?;
        emit!(BoatBought { owner, slot, level, price });
        Ok(())
    }

    /// Sails a shipyard ship (ships.ts equip): free, any ship whose threshold
    /// the lifetime banked value has reached. Owner only. Ship 0 needs no call.
    pub fn set_ship(ctx: Context<SetShip>, ship: u8) -> Result<()> {
        let s = ship as usize;
        require!(s < SHIP_COUNT, PlayerStateError::InvalidShip);
        let need = ctx.accounts.progress_config.rules.ship_thresholds[s];
        let progress = &mut ctx.accounts.progress;
        require!(progress.lifetime_value >= need, PlayerStateError::ShipLocked);
        progress.ship = ship;
        emit!(ShipSet { owner: progress.owner, ship });
        Ok(())
    }

    /// The oracle (Config.oracle, the market wallet) records one banked fish:
    /// its value is added to the owner's lifetime banked value (which unlocks
    /// ships and maps and never goes down) and the best single catch is kept.
    ///
    /// Idempotent per fish: `fish` (the fish's seed, the u32 of its 8-hex id,
    /// zero-extended) goes into the sorted catch log at the end of the
    /// Progress account. A fish already in the log is a no-op that succeeds,
    /// so a retried mint never double-counts and never fails the mint it rides
    /// with. Creates the Progress on first use; `payer` funds its rent and the
    /// 8 bytes of rent each new fish adds (in the cosigned mint tx that is the
    /// game's session key, the fee payer, so no extra signature is needed).
    pub fn record_catch(ctx: Context<RecordCatch>, fish: u64, value: u64) -> Result<()> {
        let a = &ctx.accounts;
        let owner = a.owner.key();
        let payer = a.payer.to_account_info();
        let info = a.progress.to_account_info();
        let mut progress = load_or_create_progress(&info, &owner, &payer, &a.system_program, ctx.bumps.progress)?;
        let n = progress.catches as usize;
        let log_end = Progress::SIZE + n * CATCH_KEY_SIZE;
        let at = {
            let data = info.try_borrow_data()?;
            require!(data.len() == log_end, PlayerStateError::BadCatchLog);
            match find_catch(&data[Progress::SIZE..log_end], fish) {
                Ok(_) => {
                    emit!(CatchAlreadyRecorded { owner, fish });
                    return Ok(());
                }
                Err(i) => i,
            }
        };
        let lifetime_value = progress.lifetime_value.checked_add(value).ok_or(PlayerStateError::Overflow)?;
        let catches = progress.catches.checked_add(1).ok_or(PlayerStateError::Overflow)?;
        grow_account(&info, &payer, &a.system_program, log_end + CATCH_KEY_SIZE)?;
        {
            let mut data = info.try_borrow_mut_data()?;
            let slot = Progress::SIZE + at * CATCH_KEY_SIZE;
            data.copy_within(slot..log_end, slot + CATCH_KEY_SIZE);
            data[slot..slot + CATCH_KEY_SIZE].copy_from_slice(&fish.to_le_bytes());
        }
        progress.lifetime_value = lifetime_value;
        progress.best_value = progress.best_value.max(value);
        progress.catches = catches;
        store_progress(&info, &progress)?;
        emit!(CatchRecorded { owner, fish, value, lifetime_value, best_value: progress.best_value, catches });
        Ok(())
    }
}

/// Binary search of a sorted log of little-endian u64 fish keys:
/// Ok(index) if present, Err(insertion index) if not.
fn find_catch(log: &[u8], fish: u64) -> std::result::Result<usize, usize> {
    let key_at = |i: usize| {
        let mut b = [0u8; CATCH_KEY_SIZE];
        b.copy_from_slice(&log[i * CATCH_KEY_SIZE..(i + 1) * CATCH_KEY_SIZE]);
        u64::from_le_bytes(b)
    };
    let (mut lo, mut hi) = (0usize, log.len() / CATCH_KEY_SIZE);
    while lo < hi {
        let mid = (lo + hi) / 2;
        match key_at(mid).cmp(&fish) {
            std::cmp::Ordering::Equal => return Ok(mid),
            std::cmp::Ordering::Less => lo = mid + 1,
            std::cmp::Ordering::Greater => hi = mid,
        }
    }
    Err(lo)
}

/// Loads the owner's Progress header, or creates the account (header only, no
/// catches yet) with `payer` funding the rent. Done by hand rather than with
/// Anchor's `init_if_needed` because the account grows with its catch log and
/// `init_if_needed` rejects an existing account whose size differs from
/// `space`. Like Anchor's `init`, it copes with an address someone pre-funded.
fn load_or_create_progress<'info>(
    info: &AccountInfo<'info>,
    owner: &Pubkey,
    payer: &AccountInfo<'info>,
    system: &Program<'info, System>,
    bump: u8,
) -> Result<Progress> {
    if info.owner == &crate::ID {
        let data = info.try_borrow_data()?;
        require!(data.len() >= Progress::SIZE, PlayerStateError::BadCatchLog);
        let progress = Progress::try_deserialize(&mut &data[..])?;
        require_keys_eq!(progress.owner, *owner, PlayerStateError::Unauthorized);
        return Ok(progress);
    }
    require_keys_eq!(*info.owner, system_program::ID, PlayerStateError::Unauthorized);
    let bump_seed = [bump];
    let seeds: &[&[u8]] = &[PROGRESS_SEED, owner.as_ref(), &bump_seed];
    let signer = &[seeds];
    let space = Progress::SIZE;
    let rent = Rent::get()?.minimum_balance(space);
    let held = info.lamports();
    let sys = system.to_account_info();
    if held == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(sys, system_program::CreateAccount { from: payer.clone(), to: info.clone() }, signer),
            rent,
            space as u64,
            &crate::ID,
        )?;
    } else {
        if rent > held {
            system_program::transfer(
                CpiContext::new(sys.clone(), system_program::Transfer { from: payer.clone(), to: info.clone() }),
                rent - held,
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(sys.clone(), system_program::Allocate { account_to_allocate: info.clone() }, signer),
            space as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(sys, system_program::Assign { account_to_assign: info.clone() }, signer),
            &crate::ID,
        )?;
    }
    Ok(Progress {
        version: PROGRESS_VERSION,
        bump,
        owner: *owner,
        lifetime_value: 0,
        best_value: 0,
        catches: 0,
        boat_levels: [1; BOAT_SLOT_COUNT],
        ship: 0,
        reserved: [0; 32],
    })
}

/// Writes the Progress header (discriminator + fields); the catch log after it is untouched.
fn store_progress(info: &AccountInfo, progress: &Progress) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut header: &mut [u8] = &mut data[..Progress::SIZE];
    progress.try_serialize(&mut header)
}

/// Grows a program account to `new_size`, `payer` topping up the rent.
fn grow_account<'info>(
    info: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system: &Program<'info, System>,
    new_size: usize,
) -> Result<()> {
    let need = Rent::get()?.minimum_balance(new_size).saturating_sub(info.lamports());
    if need > 0 {
        system_program::transfer(
            CpiContext::new(system.to_account_info(), system_program::Transfer { from: payer.clone(), to: info.clone() }),
            need,
        )?;
    }
    info.resize(new_size)?;
    Ok(())
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

// ------------------------------------------------------------- v2 accounts

/// Admin-set v2 rules. Separate from Config so the v1 Config layout never changes.
#[account]
#[derive(InitSpace)]
pub struct ProgressConfig {
    pub version: u8,
    pub bump: u8,
    pub rules: ProgressRules,
    pub reserved: [u8; 64],
}

/// One per wallet (`["progress", owner]`), created by `buy_boat` or `record_catch`.
/// The fixed header below is followed by `catches` little-endian u64 fish
/// keys, sorted ascending (the catch log), so the account is
/// `Progress::SIZE + 8 * catches` bytes.
#[account]
#[derive(InitSpace)]
pub struct Progress {
    pub version: u8,
    pub bump: u8,
    pub owner: Pubkey,
    /// Value of every fish ever banked (oracle-recorded). Never decreases.
    pub lifetime_value: u64,
    /// The most valuable single fish recorded.
    pub best_value: u64,
    /// Fish keys in the catch log.
    pub catches: u32,
    /// Level per boat piece (bait, boat, boatSpeed, boatHull, boatDeck), 1..=3.
    pub boat_levels: [u8; BOAT_SLOT_COUNT],
    /// The shipyard ship sailed (SHIPS index); 0 = the starter.
    pub ship: u8,
    pub reserved: [u8; 32],
}

impl Progress {
    /// Header size, discriminator included; the catch log starts here.
    pub const SIZE: usize = 8 + Progress::INIT_SPACE;
}

// ---------------------------------------------------------- v2 instructions

#[derive(Accounts)]
pub struct InitProgressConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ PlayerStateError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = 8 + ProgressConfig::INIT_SPACE,
        seeds = [PROGRESS_CONFIG_SEED],
        bump
    )]
    pub progress_config: Account<'info, ProgressConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminProgressConfig<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ PlayerStateError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [PROGRESS_CONFIG_SEED], bump = progress_config.bump)]
    pub progress_config: Account<'info, ProgressConfig>,
}

#[derive(Accounts)]
pub struct BuyBoat<'info> {
    /// Signs, pays the burn and (on first use) the Progress rent.
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [PROGRESS_CONFIG_SEED], bump = progress_config.bump)]
    pub progress_config: Account<'info, ProgressConfig>,
    /// CHECK: the owner's Progress PDA (address checked by the seeds); loaded,
    /// created and written by hand in load_or_create_progress / store_progress.
    #[account(mut, seeds = [PROGRESS_SEED, owner.key().as_ref()], bump)]
    pub progress: UncheckedAccount<'info>,
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

#[derive(Accounts)]
pub struct SetShip<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [PROGRESS_CONFIG_SEED], bump = progress_config.bump)]
    pub progress_config: Account<'info, ProgressConfig>,
    #[account(
        mut,
        seeds = [PROGRESS_SEED, owner.key().as_ref()],
        bump = progress.bump,
        has_one = owner @ PlayerStateError::Unauthorized
    )]
    pub progress: Account<'info, Progress>,
}

#[derive(Accounts)]
pub struct RecordCatch<'info> {
    /// Must be Config.oracle (the market wallet). Signs, pays nothing.
    pub oracle: Signer<'info>,
    /// Funds the Progress rent and its growth; any signer (the mint tx's fee payer).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = oracle @ PlayerStateError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: the fish's owner wallet; only used as the Progress seed.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: the owner's Progress PDA (address checked by the seeds); loaded,
    /// created, grown and written by hand.
    #[account(mut, seeds = [PROGRESS_SEED, owner.key().as_ref()], bump)]
    pub progress: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
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

#[event]
pub struct ProgressRulesSet {
    pub admin: Pubkey,
}

#[event]
pub struct BoatBought {
    pub owner: Pubkey,
    pub slot: u8,
    pub level: u8,
    pub price: u64,
}

#[event]
pub struct ShipSet {
    pub owner: Pubkey,
    pub ship: u8,
}

#[event]
pub struct CatchRecorded {
    pub owner: Pubkey,
    pub fish: u64,
    pub value: u64,
    pub lifetime_value: u64,
    pub best_value: u64,
    pub catches: u32,
}

#[event]
pub struct CatchAlreadyRecorded {
    pub owner: Pubkey,
    pub fish: u64,
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
    // v2: appended so every v1 error code keeps its number.
    #[msg("Unknown boat piece")]
    InvalidBoatSlot,
    #[msg("Only the next level can be bought")]
    NotNextLevel,
    #[msg("Unknown ship")]
    InvalidShip,
    #[msg("This ship needs more lifetime banked value")]
    ShipLocked,
    #[msg("Invalid boat prices or unlock thresholds")]
    InvalidProgressRules,
    #[msg("Progress account size does not match its catch log")]
    BadCatchLog,
}
