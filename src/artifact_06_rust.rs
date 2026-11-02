use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

pub mod errors;
pub mod state;

use errors::KineticVaultError;
use state::VaultConfig;

declare_id!("Kinet1cReba1ance1111111111111111111111111111");

#[program]
pub mod kinetic_rebalance_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        max_tick_shift_per_rebalance: u32,
        min_tick_width: u32,
        max_tick_width: u32,
        max_allowed_slippage_bps: u16,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault_config;
        vault.admin = ctx.accounts.admin.key();
        vault.keeper = ctx.accounts.keeper.key();
        vault.token_mint_a = ctx.accounts.token_mint_a.key();
        vault.token_mint_b = ctx.accounts.token_mint_b.key();
        vault.token_vault_a = ctx.accounts.token_vault_a.key();
        vault.token_vault_b = ctx.accounts.token_vault_b.key();
        vault.whirlpool = ctx.accounts.whirlpool.key();
        vault.current_position = Pubkey::default();
        vault.lower_tick = 0;
        vault.upper_tick = 0;
        vault.max_tick_shift_per_rebalance = max_tick_shift_per_rebalance;
        vault.min_tick_width = min_tick_width;
        vault.max_tick_width = max_tick_width;
        vault.max_allowed_slippage_bps = max_allowed_slippage_bps;
        vault.is_paused = false;
        vault.bump = ctx.bumps.vault_config;
        vault.vault_a_bump = ctx.bumps.token_vault_a;
        vault.vault_b_bump = ctx.bumps.token_vault_b;

        msg!("Kinetic Vault initialized successfully.");
        Ok(())
    }

    pub fn rebalance_position(
        ctx: Context<RebalancePosition>,
        new_lower_tick: i32,
        new_upper_tick: i32,
        kinetic_energy_index: u64,
        max_price_slippage_bps: u16,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault_config;

        require!(!vault.is_paused, KineticVaultError::VaultPaused);
        require!(
            ctx.accounts.keeper.key() == vault.keeper,
            KineticVaultError::UnauthorizedKeeper
        );
        require!(
            max_price_slippage_bps <= vault.max_allowed_slippage_bps,
            KineticVaultError::ExcessiveSlippage
        );

        let tick_width = new_upper_tick
            .checked_sub(new_lower_tick)
            .ok_or(KineticVaultError::MathOverflow)?;

        require!(tick_width > 0, KineticVaultError::TickSpreadTooNarrow);
        require!(
            tick_width as u32 >= vault.min_tick_width,
            KineticVaultError::TickSpreadTooNarrow
        );
        require!(
            tick_width as u32 <= vault.max_tick_width,
            KineticVaultError::TickSpreadTooWide
        );

        // Verify shift magnitude when updating existing position
        if vault.lower_tick != 0 || vault.upper_tick != 0 {
            let shift_lower = (new_lower_tick - vault.lower_tick).abs() as u32;
            let shift_upper = (new_upper_tick - vault.upper_tick).abs() as u32;
            let max_shift = shift_lower.max(shift_upper);
            require!(
                max_shift <= vault.max_tick_shift_per_rebalance,
                KineticVaultError::KineticShockTriggered
            );
        }

        // Commit updated state bounds
        vault.lower_tick = new_lower_tick;
        vault.upper_tick = new_upper_tick;

        emit!(RebalanceCommittedEvent {
            vault: vault.key(),
            new_lower_tick,
            new_upper_tick,
            kinetic_energy_index,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!(
            "Position shifted to [{}, {}]. Kinetic metric: {}",
            new_lower_tick,
            new_upper_tick,
            kinetic_energy_index
        );
        Ok(())
    }

    pub fn set_circuit_breaker(ctx: Context<ManageSecurity>, pause: bool) -> Result<()> {
        let vault = &mut ctx.accounts.vault_config;
        vault.is_paused = pause;
        emit!(SecurityStatusChangedEvent {
            vault: vault.key(),
            is_paused: pause,
            admin: ctx.accounts.admin.key(),
        });
        Ok(())
    }

    pub fn update_keeper(ctx: Context<ManageSecurity>, new_keeper: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.vault_config;
        vault.keeper = new_keeper;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        seeds = [b"kinetic_vault", admin.key().as_ref(), token_mint_a.key().as_ref(), token_mint_b.key().as_ref()],
        bump,
        payer = admin,
        space = VaultConfig::LEN
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Keeper authorized public key
    pub keeper: AccountInfo<'info>,

    pub token_mint_a: Account<'info, anchor_spl::token::Mint>,
    pub token_mint_b: Account<'info, anchor_spl::token::Mint>,

    #[account(
        init,
        seeds = [b"token_a", vault_config.key().as_ref()],
        bump,
        payer = admin,
        token::mint = token_mint_a,
        token::authority = vault_config,
    )]
    pub token_vault_a: Account<'info, TokenAccount>,

    #[account(
        init,
        seeds = [b"token_b", vault_config.key().as_ref()],
        bump,
        payer = admin,
        token::mint = token_mint_b,
        token::authority = vault_config,
    )]
    pub token_vault_b: Account<'info, TokenAccount>,

    /// CHECK: Whirlpool or CLMM pool target account
    pub whirlpool: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RebalancePosition<'info> {
    #[account(mut)]
    pub vault_config: Account<'info, VaultConfig>,
    pub keeper: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ManageSecurity<'info> {
    #[account(
        mut,
        has_one = admin @ KineticVaultError::UnauthorizedKeeper
    )]
    pub vault_config: Account<'info, VaultConfig>,
    pub admin: Signer<'info>,
}

#[event]
pub struct RebalanceCommittedEvent {
    pub vault: Pubkey,
    pub new_lower_tick: i32,
    pub new_upper_tick: i32,
    pub kinetic_energy_index: u64,
    pub timestamp: i64,
}

#[event]
pub struct SecurityStatusChangedEvent {
    pub vault: Pubkey,
    pub is_paused: bool,
    pub admin: Pubkey,
}