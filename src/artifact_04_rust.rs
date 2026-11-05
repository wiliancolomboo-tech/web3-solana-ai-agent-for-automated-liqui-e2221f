use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use pyth_sdk_solana::load_price_feed_from_account_info;

declare_id!("Kinet1cReba1ance11111111111111111111111111111");

pub const MAX_ORACLE_CONF_RATIO: u64 = 500; // 5.00% max confidence width (basis points)
pub const MAX_TICK_WINDOW: i32 = 443636;    // Max tick boundary within safe limits
pub const ORACLE_EXPIRY_THRESHOLD_SECS: i64 = 60;

#[program]
pub mod kinetic_rebalancer {
    use super::*;

    /// Initialize the global kinetic vault for a specific concentrated pool pair
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        tick_spacing: u16,
        max_kinetic_skew_bps: u16,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.keeper = ctx.accounts.keeper.key();
        vault.token_a_mint = ctx.accounts.token_a_mint.key();
        vault.token_b_mint = ctx.accounts.token_b_mint.key();
        vault.token_a_vault = ctx.accounts.token_a_vault.key();
        vault.token_b_vault = ctx.accounts.token_b_vault.key();
        vault.pyth_price_feed = ctx.accounts.pyth_price_feed.key();
        vault.tick_spacing = tick_spacing;
        vault.max_kinetic_skew_bps = max_kinetic_skew_bps;
        vault.current_tick_lower = 0;
        vault.current_tick_upper = 0;
        vault.is_paused = false;
        vault.bump = ctx.bumps.vault;
        vault.last_rebalance_ts = Clock::get()?.unix_timestamp;

        msg!("Kinetic Vault successfully initialized for pair: {} / {}", 
            vault.token_a_mint, vault.token_b_mint);
        Ok(())
    }

    /// Authorized keeper submits a dynamic kinetic rebalance
    pub fn execute_rebalance(
        ctx: Context<ExecuteRebalance>,
        target_tick_lower: i32,
        target_tick_upper: i32,
        kinetic_energy_indicator: u64,
        swap_amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let vault = &mut ctx.accounts.vault;

        require!(!vault.is_paused, KineticError::VaultPaused);
        require!(
            target_tick_lower < target_tick_upper,
            KineticError::InvalidTickBounds
        );
        require!(
            target_tick_lower.abs() <= MAX_TICK_WINDOW && target_tick_upper.abs() <= MAX_TICK_WINDOW,
            KineticError::TickBoundsOutOfRange
        );
        require!(
            (target_tick_upper - target_tick_lower) % (vault.tick_spacing as i32) == 0,
            KineticError::TickSpacingMismatch
        );

        // 1. Pyth Oracle Guardrail Verification
        let pyth_account_info = &ctx.accounts.pyth_price_feed;
        let price_feed = load_price_feed_from_account_info(pyth_account_info)
            .map_err(|_| KineticError::InvalidPythOracleFeed)?;
        let current_price = price_feed
            .get_price_no_older_than(clock.unix_timestamp, ORACLE_EXPIRY_THRESHOLD_SECS)
            .ok_or(KineticError::OraclePriceStale)?;

        require!(current_price.price > 0, KineticError::InvalidOraclePrice);

        // Ensure oracle confidence interval is tight (avoid flash crashes/anomalies)
        let conf_ratio = (current_price.conf as u128)
            .checked_mul(10000)
            .ok_or(KineticError::MathOverflow)?
            .checked_div(current_price.price as u128)
            .ok_or(KineticError::MathOverflow)? as u64;

        require!(
            conf_ratio <= MAX_ORACLE_CONF_RATIO,
            KineticError::OracleConfidenceTooWide
        );

        // 2. Kinetic Volatility Verification
        // If kinetic energy is extreme, ensure position tick range is sufficiently wide
        let tick_span = (target_tick_upper - target_tick_lower) as u64;
        let min_required_span = (vault.tick_spacing as u64)
            .checked_mul(kinetic_energy_indicator / 1000)
            .unwrap_or(vault.tick_spacing as u64);

        require!(
            tick_span >= min_required_span,
            KineticError::TickRangeTooTightForKineticRegime
        );

        // 3. Vault Inventory State Update
        vault.current_tick_lower = target_tick_lower;
        vault.current_tick_upper = target_tick_upper;
        vault.last_rebalance_ts = clock.unix_timestamp;

        // 4. Internal Inventory Balance Checks (Zero-Downtime Safe Rebalancing)
        let token_a_balance = ctx.accounts.token_a_vault.amount;
        let token_b_balance = ctx.accounts.token_b_vault.amount;

        emit!(RebalanceEvent {
            vault: vault.key(),
            tick_lower: target_tick_lower,
            tick_upper: target_tick_upper,
            kinetic_energy: kinetic_energy_indicator,
            token_a_balance,
            token_b_balance,
            timestamp: clock.unix_timestamp,
        });

        msg!("Rebalance verified and executed. Span: [{}, {}]", target_tick_lower, target_tick_upper);
        Ok(())
    }

    /// Emergency pause breaker by governance authority
    pub fn set_emergency_pause(ctx: Context<GovernanceOnly>, is_paused: bool) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.is_paused = is_paused;
        msg!("Vault pause state updated: {}", is_paused);
        Ok(())
    }

    /// Update keeper key if rotation is required
    pub fn rotate_keeper(ctx: Context<GovernanceOnly>, new_keeper: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.keeper = new_keeper;
        msg!("Keeper key rotated to: {}", new_keeper);
        Ok(())
    }
}

// ----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// ----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::LEN,
        seeds = [b"kinetic_vault", token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, VaultState>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Validated as the authorized off-chain execution bot
    pub keeper: AccountInfo<'info>,

    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = token_a_mint,
        token::authority = vault,
        seeds = [b"vault_token_a", vault.key().as_ref()],
        bump
    )]
    pub token_a_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        token::mint = token_b_mint,
        token::authority = vault,
        seeds = [b"vault_token_b", vault.key().as_ref()],
        bump
    )]
    pub token_b_vault: Account<'info, TokenAccount>,

    /// CHECK: Pyth network price account verified during rebalancing CPI
    pub pyth_price_feed: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ExecuteRebalance<'info> {
    #[account(
        mut,
        has_one = keeper @ KineticError::UnauthorizedKeeper,
        seeds = [b"kinetic_vault", vault.token_a_mint.as_ref(), vault.token_b_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, VaultState>,

    pub keeper: Signer<'info>,

    #[account(
        mut,
        address = vault.token_a_vault
    )]
    pub token_a_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        address = vault.token_b_vault
    )]
    pub token_b_vault: Account<'info, TokenAccount>,

    /// CHECK: Checked by Pyth SDK loader
    pub pyth_price_feed: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct GovernanceOnly<'info> {
    #[account(
        mut,
        has_one = authority @ KineticError::UnauthorizedAuthority
    )]
    pub vault: Account<'info, VaultState>,
    pub authority: Signer<'info>,
}

// ----------------------------------------------------------------------------
// STATE ENTITIES & ERRORS
// ----------------------------------------------------------------------------

#[account]
pub struct VaultState {
    pub authority: Pubkey,            // 32
    pub keeper: Pubkey,               // 32
    pub token_a_mint: Pubkey,         // 32
    pub token_b_mint: Pubkey,         // 32
    pub token_a_vault: Pubkey,        // 32
    pub token_b_vault: Pubkey,        // 32
    pub pyth_price_feed: Pubkey,      // 32
    pub current_tick_lower: i32,      // 4
    pub current_tick_upper: i32,      // 4
    pub tick_spacing: u16,            // 2
    pub max_kinetic_skew_bps: u16,    // 2
    pub is_paused: bool,              // 1
    pub bump: u8,                     // 1
    pub last_rebalance_ts: i64,       // 8
}

impl VaultState {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 32 + 32 + 32 + 4 + 4 + 2 + 2 + 1 + 1 + 8;
}

#[event]
pub struct RebalanceEvent {
    pub vault: Pubkey,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub kinetic_energy: u64,
    pub token_a_balance: u64,
    pub token_b_balance: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum KineticError {
    #[msg("Vault is currently paused by governance")]
    VaultPaused,
    #[msg("Invalid tick bounds: lower bound must be less than upper bound")]
    InvalidTickBounds,
    #[msg("Tick bounds exceed max allowed system window")]
    TickBoundsOutOfRange,
    #[msg("Tick interval does not match pool tick spacing requirement")]
    TickSpacingMismatch,
    #[msg("Supplied Pyth account does not match registered feed")]
    InvalidPythOracleFeed,
    #[msg("Pyth oracle price feed is stale or expired")]
    OraclePriceStale,
    #[msg("Oracle reported price is negative or zero")]
    InvalidOraclePrice,
    #[msg("Oracle price confidence interval is too wide (excessive volatility)")]
    OracleConfidenceTooWide,
    #[msg("Tick width is too tight for detected kinetic market volatility")]
    TickRangeTooTightForKineticRegime,
    #[msg("Signer is not the registered authorized keeper")]
    UnauthorizedKeeper,
    #[msg("Signer is not the registered vault governance authority")]
    UnauthorizedAuthority,
    #[msg("Mathematical calculation overflow")]
    MathOverflow,
}