//! fish_market: the on-chain fish market for Breathless.
//!
//! A caught fish is a Metaplex Core asset owned by the player's wallet. Selling
//! it burns the asset and mints PEARL (an SPL token, 0 decimals) to the seller,
//! in one atomic instruction. Fish are caught client-side, so a server "oracle"
//! key must co-sign every sale to vouch for the value; the program enforces the
//! oracle signature, the per-fish cap, ownership, and burn-before-pay.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::metadata::{
    create_metadata_accounts_v3, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3,
    Metadata,
};
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use mpl_core::accounts::BaseAssetV1;
use mpl_core::instructions::BurnV1CpiBuilder;
use mpl_core::types::{Key as CoreKey, UpdateAuthority};

declare_id!("5HEuVNCHKjpfnsdJzov3zDy9UFSj8V2tzF8L9eQnKsDG");

pub const CONFIG_SEED: &[u8] = b"config";
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";
pub const PEARL_SEED: &[u8] = b"pearl";

pub const PEARL_NAME: &str = "Pearl";
pub const PEARL_SYMBOL: &str = "PEARL";

#[program]
pub mod fish_market {
    use super::*;

    /// Creates the config and the PEARL mint (decimals 0, authority = the
    /// `mint_authority` PDA, no freeze authority). The signer becomes admin.
    pub fn initialize(ctx: Context<Initialize>, oracle: Pubkey, max_value: u64) -> Result<()> {
        require!(max_value > 0, FishMarketError::InvalidMaxValue);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.oracle = oracle;
        config.pearl_mint = ctx.accounts.pearl_mint.key();
        config.max_value = max_value;
        config.bump = ctx.bumps.config;
        config.mint_bump = ctx.bumps.pearl_mint;
        Ok(())
    }

    /// Burns the seller's Core fish and mints `value` PEARL to the seller's ATA.
    /// The oracle must co-sign the transaction.
    pub fn sell_fish(ctx: Context<SellFish>, value: u64) -> Result<()> {
        require!(value > 0, FishMarketError::ZeroValue);
        require!(
            value <= ctx.accounts.config.max_value,
            FishMarketError::ValueTooHigh
        );

        let seller_key = ctx.accounts.seller.key();
        let asset_info = ctx.accounts.asset.to_account_info();

        // The asset must be a live Metaplex Core asset owned by the seller.
        {
            if *asset_info.owner != mpl_core::ID {
                if asset_info.data_is_empty() {
                    return err!(FishMarketError::AssetBurned);
                }
                return err!(FishMarketError::NotACoreAsset);
            }
            let data = asset_info.try_borrow_data()?;
            match data.first() {
                None => return err!(FishMarketError::AssetBurned),
                Some(k) if *k == CoreKey::Uninitialized as u8 => {
                    return err!(FishMarketError::AssetBurned)
                }
                Some(k) if *k != CoreKey::AssetV1 as u8 => {
                    return err!(FishMarketError::NotACoreAsset)
                }
                _ => {}
            }
            let base =
                BaseAssetV1::from_bytes(&data).map_err(|_| error!(FishMarketError::NotACoreAsset))?;
            require_keys_eq!(base.owner, seller_key, FishMarketError::NotOwner);
            if let UpdateAuthority::Collection(collection) = base.update_authority {
                let passed = ctx
                    .accounts
                    .collection
                    .as_ref()
                    .ok_or(error!(FishMarketError::CollectionMismatch))?;
                require_keys_eq!(passed.key(), collection, FishMarketError::CollectionMismatch);
            }
        }

        // Burn the fish (seller is owner, payer and authority).
        let core_program = ctx.accounts.mpl_core_program.to_account_info();
        let seller_info = ctx.accounts.seller.to_account_info();
        let system_info = ctx.accounts.system_program.to_account_info();
        let collection_info = ctx.accounts.collection.as_ref().map(|c| c.to_account_info());
        BurnV1CpiBuilder::new(&core_program)
            .asset(&asset_info)
            .collection(collection_info.as_ref())
            .payer(&seller_info)
            .authority(Some(&seller_info))
            .system_program(Some(&system_info))
            .invoke()?;

        // Pay the seller.
        let signer_seeds: &[&[&[u8]]] = &[&[MINT_AUTHORITY_SEED, &[ctx.bumps.mint_authority]]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.pearl_mint.to_account_info(),
                    to: ctx.accounts.seller_pearl_ata.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer_seeds,
            ),
            value,
        )?;

        emit!(FishSold {
            asset: asset_info.key(),
            seller: seller_key,
            value,
        });
        Ok(())
    }

    /// Admin only: rotate the oracle key.
    pub fn set_oracle(ctx: Context<AdminOnly>, new_oracle: Pubkey) -> Result<()> {
        ctx.accounts.config.oracle = new_oracle;
        Ok(())
    }

    /// Admin only: change the per-fish PEARL cap (e.g. if game balance changes).
    pub fn set_max_value(ctx: Context<AdminOnly>, new_max_value: u64) -> Result<()> {
        require!(new_max_value > 0, FishMarketError::InvalidMaxValue);
        ctx.accounts.config.max_value = new_max_value;
        Ok(())
    }

    /// Admin only, one-time: create Metaplex token metadata for PEARL so wallets
    /// and explorers show "Pearl" / "PEARL". Signed by the `mint_authority` PDA;
    /// the admin is the metadata update authority (so the URI can be changed
    /// later with standard Metaplex tooling).
    pub fn create_pearl_metadata(ctx: Context<CreatePearlMetadata>, uri: String) -> Result<()> {
        let signer_seeds: &[&[&[u8]]] = &[&[MINT_AUTHORITY_SEED, &[ctx.bumps.mint_authority]]];
        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.pearl_metadata.to_account_info(),
                    mint: ctx.accounts.pearl_mint.to_account_info(),
                    mint_authority: ctx.accounts.mint_authority.to_account_info(),
                    payer: ctx.accounts.admin.to_account_info(),
                    update_authority: ctx.accounts.admin.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
                signer_seeds,
            ),
            DataV2 {
                name: PEARL_NAME.to_string(),
                symbol: PEARL_SYMBOL.to_string(),
                uri,
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            },
            true,
            true,
            None,
        )
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub pearl_mint: Pubkey,
    pub max_value: u64,
    /// Bump of the `config` PDA.
    pub bump: u8,
    /// Bump of the `pearl_mint` PDA (seeds `[b"pearl"]`).
    pub mint_bump: u8,
}

#[event]
pub struct FishSold {
    pub asset: Pubkey,
    pub seller: Pubkey,
    pub value: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// CHECK: PDA used only as the PEARL mint authority; holds no data.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [PEARL_SEED],
        bump,
        mint::decimals = 0,
        mint::authority = mint_authority,
    )]
    pub pearl_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SellFish<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(address = config.oracle @ FishMarketError::WrongOracle)]
    pub oracle: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: Metaplex Core asset; owner program, key and owner == seller are
    /// checked in the handler, and mpl-core validates it again during BurnV1.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,

    /// CHECK: the asset's collection, required only when the asset belongs to
    /// one (checked in the handler and by mpl-core). Pass None for no collection.
    #[account(mut)]
    pub collection: Option<UncheckedAccount<'info>>,

    #[account(
        mut,
        seeds = [PEARL_SEED],
        bump = config.mint_bump,
        address = config.pearl_mint,
    )]
    pub pearl_mint: Account<'info, Mint>,

    /// CHECK: PDA that is the PEARL mint authority; signs mint_to.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = pearl_mint,
        associated_token::authority = seller,
        associated_token::token_program = token_program,
    )]
    pub seller_pearl_ata: Account<'info, TokenAccount>,

    /// CHECK: the Metaplex Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ FishMarketError::NotAdmin,
    )]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct CreatePearlMetadata<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ FishMarketError::NotAdmin,
    )]
    pub config: Account<'info, Config>,

    /// CHECK: PDA that is the PEARL mint authority; signs the metadata CPI.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(seeds = [PEARL_SEED], bump = config.mint_bump)]
    pub pearl_mint: Account<'info, Mint>,

    /// CHECK: the Metaplex metadata PDA for the PEARL mint; created by the
    /// token-metadata program.
    #[account(
        mut,
        seeds = [b"metadata", token_metadata_program.key().as_ref(), pearl_mint.key().as_ref()],
        bump,
        seeds::program = token_metadata_program.key(),
    )]
    pub pearl_metadata: UncheckedAccount<'info>,

    pub token_metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[error_code]
pub enum FishMarketError {
    #[msg("The oracle signer is not the configured oracle")]
    WrongOracle,
    #[msg("Sale value must be greater than zero")]
    ZeroValue,
    #[msg("Sale value exceeds config.max_value")]
    ValueTooHigh,
    #[msg("Account is not a Metaplex Core asset")]
    NotACoreAsset,
    #[msg("Asset has already been burned (sold)")]
    AssetBurned,
    #[msg("Seller does not own this asset")]
    NotOwner,
    #[msg("Collection account missing or does not match the asset's collection")]
    CollectionMismatch,
    #[msg("Only the admin can do this")]
    NotAdmin,
    #[msg("max_value must be greater than zero")]
    InvalidMaxValue,
}
