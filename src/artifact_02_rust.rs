use anchor_lang::prelude::*;
use anchor_lang::solana_program::clock::Clock;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Kinet1cRebaLancer111111111111111111111111111");

pub const MAX_ORACLE_DEVIATION_BPS: u64 = 50; // 0.50%
pub const MAX_SLIPPAGE_BPS: u64 = 100;         // 1.00%
pub const BPS_DENOMINATOR: u64 = 10_000;

#[program]
pub mod kinetic_rebalancer {
    use super::*;

    /// Initialize a non-custodial strategy vault managed by a designated keeper.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        keeper: Pubkey,
        oracle: Pubkey,
        tick_spacing: u16,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.keeper = keeper;
        vault.oracle = oracle;
        vault.pool = ctx.accounts.pool.key();
        vault.token_mint_a = ctx.accounts.token_mint_a.key();
        vault.token_mint_b = ctx.accounts.token_mint_b.key();
        vault.vault_token_a = ctx.accounts.vault_token_a.key();
        vault.vault_token_b = ctx.accounts.vault_token_b.key();
        vault.tick_spacing = tick_spacing;
        vault.vault_bump = ctx.bumps.vault;
        vault.authority_bump = ctx.bumps.vault_authority;
        vault.is_locked = false;
        vault.last_rebalance_ts = Clock::get()?.unix_timestamp;

        msg!("Vault initialized for Pool: {}", vault.pool);
        Ok(())
    }

    /// Autonomous atomic rebalance instruction executed by the AI Keeper.
    /// Checks oracle divergence, withdraws liquidity, handles inventory correction,
    /// and opens a new concentrated position within single instruction boundaries.
    pub fn rebalance_position(
        ctx: Context<RebalancePosition>,
        params: RebalanceParams,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;

        // 1. Invariant & Security Checks
        require!(!vault.is_locked, RebalanceError::VaultLocked);
        require_keys_eq!(ctx.accounts.keeper.key(), vault.keeper, RebalanceError::UnauthorizedKeeper);

        let current_ts = Clock::get()?.unix_timestamp;
        require!(
            current_ts <= params.deadline,
            RebalanceError::TransactionExpired
        );

        // 2. Oracle Cross-Check: Mitigate sandwich attacks and flash crash manipulation
        validate_oracle_price(
            &ctx.accounts.oracle_price_feed,
            params.expected_sqrt_price_x64,
        )?;

        // Lock during execution
        vault.is_locked = true;

        let vault_key = vault.key();
        let authority_seeds = &[
            b"vault_authority".as_ref(),
            vault_key.as_ref(),
            &[vault.authority_bump],
        ];
        let signer_seeds = &[&authority_seeds[..]];

        // 3. Step A: Burn active liquidity & collect accrued fees
        msg!("Executing CPI: Decreasing liquidity and collecting fees...");
        burn_current_position_cpi(
            &ctx.accounts.clmm_program,
            &ctx.accounts.clmm_pool,
            &ctx.accounts.clmm_position,
            &ctx.accounts.vault_authority,
            &ctx.accounts.vault_token_a,
            &ctx.accounts.vault_token_b,
            &ctx.accounts.token_program,
            signer_seeds,
        )?;

        // 4. Step B: Handle inventory adjustment if intermediate swapping is requested
        if params.swap_amount_in > 0 {
            msg!("Executing CPI: Inventory equilibrium swap...");
            execute_swap_cpi(
                &ctx.accounts.clmm_program,
                &ctx.accounts.clmm_pool,
                &ctx.accounts.vault_authority,
                &ctx.accounts.vault_token_a,
                &ctx.accounts.vault_token_b,
                &ctx.accounts.token_program,
                params.swap_amount_in,
                params.swap_min_out,
                params.swap_a_to_b,
                signer_seeds,
            )?;
        }

        // 5. Step C: Mint new position with dynamic kinetic boundaries
        msg!(
            "Executing CPI: Opening kinetic range [{}, {}]",
            params.new_tick_lower,
            params.new_tick_upper
        );
        mint_new_position_cpi(
            &ctx.accounts.clmm_program,
            &ctx.accounts.clmm_pool,
            &ctx.accounts.clmm_position,
            &ctx.accounts.vault_authority,
            &ctx.accounts.vault_token_a,
            &ctx.accounts.vault_token_b,
            &ctx.accounts.token_program,
            params.new_tick_lower,
            params.new_tick_upper,
            params.liquidity_amount,
            signer_seeds,
        )?;

        // 6. Update Vault State
        vault.last_rebalance_ts = current_ts;
        vault.is_locked = false;

        emit!(PositionRebalancedEvent {
            vault: vault_key,
            tick_lower: params.new_tick_lower,
            tick_upper: params.new_tick_upper,
            liquidity: params.liquidity_amount,
            timestamp: current_ts,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------------
// Helper CPI Functions
// ---------------------------------------------------------------------------------

fn validate_oracle_price(
    oracle_account: &AccountInfo,
    reported_sqrt_price_x64: u128,
) -> Result<()> {
    // Standard Pyth-like deserialization mock for verification
    let data = oracle_account.try_borrow_data()?;
    require!(data.len() >= 32, RebalanceError::InvalidOracleData);
    
    // Read 64-bit int price from Pyth account offset
    let oracle_price = i64::from_le_bytes(data[8..16].try_into().unwrap());
    require!(oracle_price > 0, RebalanceError::InvalidOraclePrice);

    // Derived spot price approximation from sqrt_price_x64: P = (sqrt_price_x64 / 2^64)^2
    let spot_scaled = ((reported_sqrt_price_x64 >> 32) * (reported_sqrt_price_x64 >> 32)) >> 32;
    let oracle_scaled = oracle_price as u128;

    let diff = if spot_scaled > oracle_scaled {
        spot_scaled - oracle_scaled
    } else {
        oracle_scaled - spot_scaled
    };

    let deviation_bps = (diff * BPS_DENOMINATOR) / oracle_scaled;
    require!(
        deviation_bps <= MAX_ORACLE_DEVIATION_BPS as u128,
        RebalanceError::ExcessiveOracleDeviation
    );

    Ok(())
}

fn burn_current_position_cpi<'info>(
    _clmm_program: &AccountInfo<'info>,
    _clmm_pool: &AccountInfo<'info>,
    _clmm_position: &AccountInfo<'info>,
    _vault_auth: &AccountInfo<'info>,
    _token_a: &Account<'info, TokenAccount>,
    _token_b: &Account<'info, TokenAccount>,
    _token_program: &Program<'info, Token>,
    _seeds: &[&[&[u8]]],
) -> Result<()> {
    // CPI call to whirlpool::decrease_liquidity and whirlpool::collect_fees
    // In production, instantiate proper whirlpool::cpi::accounts::DecreaseLiquidity
    Ok(())
}

fn execute_swap_cpi<'info>(
    _clmm_program: &AccountInfo<'info>,
    _clmm_pool: &AccountInfo<'info>,
    _vault_auth: &AccountInfo<'info>,
    _token_a: &Account<'info, TokenAccount>,
    _token_b: &Account<'info, TokenAccount>,
    _token_program: &Program<'info, Token>,
    _amount_in: u64,
    _min_out: u64,
    _a_to_b: bool,
    _seeds: &[&[&[u8]]],
) -> Result<()> {
    // CPI call to whirlpool::swap or raydium_clmm::swap
    Ok(())
}

fn mint_new_position_cpi<'info>(
    _clmm_program: &AccountInfo<'info>,
    _clmm_pool: &AccountInfo<'info>,
    _clmm_position: &AccountInfo<'info>,
    _vault_auth: &AccountInfo<'info>,
    _token_a: &Account<'info, TokenAccount>,
    _token_b: &Account<'info, TokenAccount>,
    _token_program: &Program<'info, Token>,
    _tick_lower: i32,
    _tick_upper: i32,
    _liquidity: u128,
    _seeds: &[&[&[u8]]],
) -> Result<()> {
    // CPI call to whirlpool::increase_liquidity
    Ok(())
}

// ---------------------------------------------------------------------------------
// Account Contexts
// ---------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [b"vault", authority.key().as_ref(), pool.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, VaultState>,

    /// CHECK: Vault authority PDA that signs on behalf of token accounts and CPIs
    #[account(
        seeds = [b"vault_authority", vault.key().as_ref()],
        bump
    )]
    pub vault_authority: AccountInfo<'info>,

    pub pool: AccountInfo<'info>,
    pub token_mint_a: Account<'info, Mint>,
    pub token_mint_b: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = token_mint_a,
        token::authority = vault_authority
    )]
    pub vault_token_a: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        token::mint = token_mint_b,
        token::authority = vault_authority
    )]
    pub vault_token_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RebalancePosition<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref(), vault.pool.as_ref()],
        bump = vault.vault_bump,
        has_one = vault_token_a,
        has_one = vault_token_b,
        has_one = keeper,
    )]
    pub vault: Account<'info, VaultState>,

    /// CHECK: Vault signer PDA
    #[account(
        seeds = [b"vault_authority", vault.key().as_ref()],
        bump = vault.authority_bump
    )]
    pub vault_authority: AccountInfo<'info>,

    pub keeper: Signer<'info>,

    /// CHECK: Pyth or Switchboard price oracle account
    pub oracle_price_feed: AccountInfo<'info>,

    /// CHECK: Target CLMM program (Whirlpool / Raydium)
    pub clmm_program: AccountInfo<'info>,
    /// CHECK: Target pool account
    #[account(mut)]
    pub clmm_pool: AccountInfo<'info>,
    /// CHECK: Target CLMM position account
    #[account(mut)]
    pub clmm_position: AccountInfo<'info>,

    #[account(mut)]
    pub vault_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_token_b: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------------
// State & Structs
// ---------------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub authority: Pubkey,
    pub keeper: Pubkey,
    pub oracle: Pubkey,
    pub pool: Pubkey,
    pub token_mint_a: Pubkey,
    pub token_mint_b: Pubkey,
    pub vault_token_a: Pubkey,
    pub vault_token_b: Pubkey,
    pub tick_spacing: u16,
    pub vault_bump: u8,
    pub authority_bump: u8,
    pub is_locked: bool,
    pub last_rebalance_ts: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RebalanceParams {
    pub new_tick_lower: i32,
    pub new_tick_upper: i32,
    pub liquidity_amount: u128,
    pub expected_sqrt_price_x64: u128,
    pub swap_amount_in: u64,
    pub swap_min_out: u64,
    pub swap_a_to_b: bool,
    pub deadline: i64,
}

#[event]
pub struct PositionRebalancedEvent {
    pub vault: Pubkey,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: u128,
    pub timestamp: i64,
}

#[error_code]
pub enum RebalanceError {
    #[msg("Vault is currently reentrancy-locked.")]
    VaultLocked,
    #[msg("Caller is not the authorized autonomous keeper.")]
    UnauthorizedKeeper,
    #[msg("Transaction submitted beyond validity deadline.")]
    TransactionExpired,
    #[msg("Oracle price deviate beyond tolerance threshold.")]
    ExcessiveOracleDeviation,
    #[msg("Oracle account data is invalid.")]
    InvalidOracleData,
    #[msg("Oracle reported price is negative or zero.")]
    InvalidOraclePrice,
}