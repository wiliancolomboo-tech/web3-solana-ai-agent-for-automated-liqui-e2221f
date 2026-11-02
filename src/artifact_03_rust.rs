use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("KineSS1111111111111111111111111111111111111");

pub const MAX_SLIPPAGE_BPS: u16 = 300; // 3.00% max slippage
pub const MIN_COOLDOWN_SECONDS: i64 = 60; // Anti-churn throttler

#[program]
pub mod kinesis_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        max_tick_deviation: i32,
        cooldown_period: i64,
        max_slippage_bps: u16,
    ) -> Result<()> {
        require!(
            max_slippage_bps <= MAX_SLIPPAGE_BPS,
            KinesisError::ExcessiveSlippageSetting
        );
        require!(
            cooldown_period >= MIN_COOLDOWN_SECONDS,
            KinesisError::CooldownTooShort
        );

        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.agent = ctx.accounts.agent.key();
        vault.token_a_mint = ctx.accounts.token_a_mint.key();
        vault.token_b_mint = ctx.accounts.token_b_mint.key();
        vault.token_a_vault = ctx.accounts.token_a_vault.key();
        vault.token_b_vault = ctx.accounts.token_b_vault.key();
        vault.max_tick_deviation = max_tick_deviation;
        vault.cooldown_period = cooldown_period;
        vault.max_slippage_bps = max_slippage_bps;
        vault.last_rebalance_ts = 0;
        vault.bump = ctx.bumps.vault;
        vault.is_paused = false;

        emit!(VaultInitializedEvent {
            owner: vault.owner,
            agent: vault.agent,
            max_slippage_bps,
        });

        Ok(())
    }

    pub fn deposit(ctx: Context<DepositTokens>, amount_a: u64, amount_b: u64) -> Result<()> {
        require!(!ctx.accounts.vault.is_paused, KinesisError::VaultPaused);

        if amount_a > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.owner_token_a.to_account_info(),
                to: ctx.accounts.vault_token_a.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            token::transfer(CpiContext::new(cpi_program, cpi_accounts), amount_a)?;
        }

        if amount_b > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.owner_token_b.to_account_info(),
                to: ctx.accounts.vault_token_b.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            token::transfer(CpiContext::new(cpi_program, cpi_accounts), amount_b)?;
        }

        emit!(LiquidityDepositedEvent {
            vault: ctx.accounts.vault.key(),
            amount_a,
            amount_b,
        });

        Ok(())
    }

    pub fn execute_rebalance(
        ctx: Context<ExecuteRebalance>,
        new_lower_tick: i32,
        new_upper_tick: i32,
        oracle_twap_tick: i32,
        min_token_a_out: u64,
        min_token_b_out: u64,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;

        require!(!vault.is_paused, KinesisError::VaultPaused);
        require!(new_lower_tick < new_upper_tick, KinesisError::InvalidTicks);

        // Anti-churn throttler: verify cooldown
        let elapsed = clock.unix_timestamp.saturating_sub(vault.last_rebalance_ts);
        require!(elapsed >= vault.cooldown_period, KinesisError::CooldownActive);

        // Oracle Guard: Ensure the midpoint between new ticks doesn't diverge dangerously from Oracle TWAP
        let tick_midpoint = (new_lower_tick + new_upper_tick) / 2;
        let deviation = (tick_midpoint - oracle_twap_tick).abs();
        require!(
            deviation <= vault.max_tick_deviation,
            KinesisError::OracleDeviationBreached
        );

        // Update timestamps
        vault.last_rebalance_ts = clock.unix_timestamp;

        emit!(RebalanceExecutedEvent {
            vault: vault.key(),
            executor: ctx.accounts.agent.key(),
            new_lower_tick,
            new_upper_tick,
            oracle_twap_tick,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    pub fn emergency_withdraw(ctx: Context<EmergencyWithdraw>) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(
            ctx.accounts.owner.key() == vault.owner,
            KinesisError::Unauthorized
        );

        let vault_bump = vault.bump;
        let vault_key = vault.key();
        let seeds = &[
            b"kinesis_vault",
            vault.owner.as_ref(),
            vault.token_a_mint.as_ref(),
            vault.token_b_mint.as_ref(),
            &[vault_bump],
        ];
        let signer = &[&seeds[..]];

        let balance_a = ctx.accounts.vault_token_a.amount;
        if balance_a > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_token_a.to_account_info(),
                to: ctx.accounts.owner_token_a.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer,
                ),
                balance_a,
            )?;
        }

        let balance_b = ctx.accounts.vault_token_b.amount;
        if balance_b > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_token_b.to_account_info(),
                to: ctx.accounts.owner_token_b.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer,
                ),
                balance_b,
            )?;
        }

        emit!(EmergencyWithdrawEvent {
            vault: vault_key,
            amount_a_returned: balance_a,
            amount_b_returned: balance_b,
        });

        Ok(())
    }

    pub fn toggle_pause(ctx: Context<OwnerAction>, paused: bool) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.is_paused = paused;
        emit!(VaultPauseToggledEvent { vault: vault.key(), paused });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + RebalanceVault::INIT_SPACE,
        seeds = [b"kinesis_vault", owner.key().as_ref(), token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, RebalanceVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: The off-chain automated executor address
    pub agent: AccountInfo<'info>,
    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = owner,
        token::mint = token_a_mint,
        token::authority = vault,
    )]
    pub token_a_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = owner,
        token::mint = token_b_mint,
        token::authority = vault,
    )]
    pub token_b_vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositTokens<'info> {
    #[account(
        mut,
        has_one = owner,
        has_one = token_a_vault,
        has_one = token_b_vault,
    )]
    pub vault: Account<'info, RebalanceVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub owner_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner_token_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_token_b: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExecuteRebalance<'info> {
    #[account(
        mut,
        has_one = agent,
        has_one = token_a_vault,
        has_one = token_b_vault,
    )]
    pub vault: Account<'info, RebalanceVault>,
    pub agent: Signer<'info>,
    #[account(mut)]
    pub vault_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_token_b: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct EmergencyWithdraw<'info> {
    #[account(
        mut,
        has_one = owner,
        has_one = token_a_vault,
        has_one = token_b_vault,
    )]
    pub vault: Account<'info, RebalanceVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub owner_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner_token_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_token_b: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OwnerAction<'info> {
    #[account(mut, has_one = owner)]
    pub vault: Account<'info, RebalanceVault>,
    pub owner: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct RebalanceVault {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub max_tick_deviation: i32,
    pub cooldown_period: i64,
    pub last_rebalance_ts: i64,
    pub max_slippage_bps: u16,
    pub bump: u8,
    pub is_paused: bool,
}

#[event]
pub struct VaultInitializedEvent {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub max_slippage_bps: u16,
}

#[event]
pub struct LiquidityDepositedEvent {
    pub vault: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
}

#[event]
pub struct RebalanceExecutedEvent {
    pub vault: Pubkey,
    pub executor: Pubkey,
    pub new_lower_tick: i32,
    pub new_upper_tick: i32,
    pub oracle_twap_tick: i32,
    pub timestamp: i64,
}

#[event]
pub struct EmergencyWithdrawEvent {
    pub vault: Pubkey,
    pub amount_a_returned: u64,
    pub amount_b_returned: u64,
}

#[event]
pub struct VaultPauseToggledEvent {
    pub vault: Pubkey,
    pub paused: bool,
}

#[error_code]
pub enum KinesisError {
    #[msg("Vault is currently paused by owner")]
    VaultPaused,
    #[msg("Slippage setting exceeds protocol maximum")]
    ExcessiveSlippageSetting,
    #[msg("Cooldown period below minimum threshold")]
    CooldownTooShort,
    #[msg("Cooldown period active. Rebalancing too frequently")]
    CooldownActive,
    #[msg("Invalid tick bounds: lower tick must be strictly less than upper tick")]
    InvalidTicks,
    #[msg("Target tick bounds deviate excessively from Oracle TWAP")]
    OracleDeviationBreached,
    #[msg("Caller is unauthorized to perform this operation")]
    Unauthorized,
}