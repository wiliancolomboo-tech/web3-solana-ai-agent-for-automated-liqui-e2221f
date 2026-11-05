use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("K1nEticVaULT1111111111111111111111111111111");

#[program]
pub mod kinetic_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        max_slippage_bps: u16,
        cooldown_seconds: i64,
    ) -> Result<()> {
        require!(max_slippage_bps <= 1000, VaultError::ExcessiveSlippageSetting); // Max 10%
        require!(cooldown_seconds >= 10, VaultError::CooldownTooShort);

        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.authority = ctx.accounts.authority.key();
        vault_state.agent_executor = ctx.accounts.agent_executor.key();
        vault_state.token_a_mint = ctx.accounts.token_a_mint.key();
        vault_state.token_b_mint = ctx.accounts.token_b_mint.key();
        vault_state.token_a_vault = ctx.accounts.token_a_vault.key();
        vault_state.token_b_vault = ctx.accounts.token_b_vault.key();
        vault_state.max_slippage_bps = max_slippage_bps;
        vault_state.cooldown_seconds = cooldown_seconds;
        vault_state.last_rebalance_ts = 0;
        vault_state.active_tick_lower = 0;
        vault_state.active_tick_upper = 0;
        vault_state.rebalance_count = 0;
        vault_state.bump = ctx.bumps.vault_state;
        vault_state.vault_a_bump = ctx.bumps.token_a_vault;
        vault_state.vault_b_bump = ctx.bumps.token_b_vault;

        emit!(VaultInitializedEvent {
            authority: vault_state.authority,
            agent_executor: vault_state.agent_executor,
            token_a_mint: vault_state.token_a_mint,
            token_b_mint: vault_state.token_b_mint,
            max_slippage_bps,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    pub fn update_agent_executor(
        ctx: Context<UpdateVaultSettings>,
        new_executor: Pubkey,
    ) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.agent_executor = new_executor;
        emit!(AgentUpdatedEvent {
            new_executor,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn deposit_liquidity(
        ctx: Context<DepositLiquidity>,
        amount_a: u64,
        amount_b: u64,
    ) -> Result<()> {
        require!(amount_a > 0 || amount_b > 0, VaultError::ZeroDepositAmount);

        if amount_a > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_a.to_account_info(),
                        to: ctx.accounts.token_a_vault.to_account_info(),
                        authority: ctx.accounts.depositor.to_account_info(),
                    },
                ),
                amount_a,
            )?;
        }

        if amount_b > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_b.to_account_info(),
                        to: ctx.accounts.token_b_vault.to_account_info(),
                        authority: ctx.accounts.depositor.to_account_info(),
                    },
                ),
                amount_b,
            )?;
        }

        let user_balance = &mut ctx.accounts.user_balance;
        user_balance.owner = ctx.accounts.depositor.key();
        user_balance.vault = ctx.accounts.vault_state.key();
        user_balance.deposited_a = user_balance.deposited_a.checked_add(amount_a).ok_or(VaultError::MathOverflow)?;
        user_balance.deposited_b = user_balance.deposited_b.checked_add(amount_b).ok_or(VaultError::MathOverflow)?;

        emit!(LiquidityDepositedEvent {
            depositor: ctx.accounts.depositor.key(),
            amount_a,
            amount_b,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    pub fn rebalance_position(
        ctx: Context<RebalancePosition>,
        params: RebalanceParams,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let vault_state = &mut ctx.accounts.vault_state;

        // Security Validation
        require_keys_eq!(
            ctx.accounts.agent_executor.key(),
            vault_state.agent_executor,
            VaultError::UnauthorizedAgent
        );
        require!(
            clock.unix_timestamp >= vault_state.last_rebalance_ts.saturating_add(vault_state.cooldown_seconds),
            VaultError::CooldownActive
        );
        require!(params.tick_lower < params.tick_upper, VaultError::InvalidTickBounds);
        require!(params.kinetic_energy_score > 0, VaultError::InvalidKineticMetric);

        // Verification of Slippage bounds
        let delta_a = params.expected_amount_a;
        let delta_b = params.expected_amount_b;
        let min_a = delta_a
            .checked_mul(10000 - vault_state.max_slippage_bps as u64)
            .ok_or(VaultError::MathOverflow)?
            / 10000;
        let min_b = delta_b
            .checked_mul(10000 - vault_state.max_slippage_bps as u64)
            .ok_or(VaultError::MathOverflow)?
            / 10000;

        require!(params.actual_amount_a >= min_a, VaultError::SlippageExceededTokenA);
        require!(params.actual_amount_b >= min_b, VaultError::SlippageExceededTokenB);

        // Update state
        vault_state.active_tick_lower = params.tick_lower;
        vault_state.active_tick_upper = params.tick_upper;
        vault_state.last_rebalance_ts = clock.unix_timestamp;
        vault_state.rebalance_count = vault_state.rebalance_count.checked_add(1).ok_or(VaultError::MathOverflow)?;

        emit!(RebalanceExecutedEvent {
            executor: ctx.accounts.agent_executor.key(),
            old_tick_lower: vault_state.active_tick_lower,
            old_tick_upper: vault_state.active_tick_upper,
            new_tick_lower: params.tick_lower,
            new_tick_upper: params.tick_upper,
            kinetic_energy_score: params.kinetic_energy_score,
            amount_a_deployed: params.actual_amount_a,
            amount_b_deployed: params.actual_amount_b,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    pub fn emergency_withdraw(
        ctx: Context<EmergencyWithdraw>,
        amount_a: u64,
        amount_b: u64,
    ) -> Result<()> {
        let vault_state = &ctx.accounts.vault_state;
        let auth_key = vault_state.authority;
        let seeds = &[
            b"kinetic_vault",
            auth_key.as_ref(),
            &[vault_state.bump],
        ];
        let signer = &[&seeds[..]];

        if amount_a > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.token_a_vault.to_account_info(),
                        to: ctx.accounts.recipient_token_a.to_account_info(),
                        authority: ctx.accounts.vault_state.to_account_info(),
                    },
                    signer,
                ),
                amount_a,
            )?;
        }

        if amount_b > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.token_b_vault.to_account_info(),
                        to: ctx.accounts.recipient_token_b.to_account_info(),
                        authority: ctx.accounts.vault_state.to_account_info(),
                    },
                    signer,
                ),
                amount_b,
            )?;
        }

        emit!(EmergencyWithdrawalEvent {
            authority: ctx.accounts.authority.key(),
            amount_a,
            amount_b,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Agent authority dedicated to algorithmic calls
    pub agent_executor: AccountInfo<'info>,

    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [b"kinetic_vault", authority.key().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        init,
        payer = authority,
        seeds = [b"token_a_vault", vault_state.key().as_ref()],
        bump,
        token::mint = token_a_mint,
        token::authority = vault_state,
    )]
    pub token_a_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [b"token_b_vault", vault_state.key().as_ref()],
        bump,
        token::mint = token_b_mint,
        token::authority = vault_state,
    )]
    pub token_b_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UpdateVaultSettings<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ VaultError::UnauthorizedAdmin
    )]
    pub vault_state: Account<'info, VaultState>,
}

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"kinetic_vault", vault_state.authority.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"token_a_vault", vault_state.key().as_ref()],
        bump = vault_state.vault_a_bump
    )]
    pub token_a_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"token_b_vault", vault_state.key().as_ref()],
        bump = vault_state.vault_b_bump
    )]
    pub token_b_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_a.mint == vault_state.token_a_mint @ VaultError::InvalidMint
    )]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_b.mint == vault_state.token_b_mint @ VaultError::InvalidMint
    )]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + UserBalance::INIT_SPACE,
        seeds = [b"user_balance", vault_state.key().as_ref(), depositor.key().as_ref()],
        bump
    )]
    pub user_balance: Account<'info, UserBalance>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RebalancePosition<'info> {
    pub agent_executor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"kinetic_vault", vault_state.authority.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"token_a_vault", vault_state.key().as_ref()],
        bump = vault_state.vault_a_bump
    )]
    pub token_a_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"token_b_vault", vault_state.key().as_ref()],
        bump = vault_state.vault_b_bump
    )]
    pub token_b_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct EmergencyWithdraw<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ VaultError::UnauthorizedAdmin,
        seeds = [b"kinetic_vault", authority.key().as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"token_a_vault", vault_state.key().as_ref()],
        bump = vault_state.vault_a_bump
    )]
    pub token_a_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"token_b_vault", vault_state.key().as_ref()],
        bump = vault_state.vault_b_bump
    )]
    pub token_b_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub recipient_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub recipient_token_b: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STRUCTS & STATES
// -----------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct RebalanceParams {
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub kinetic_energy_score: u64,
    pub expected_amount_a: u64,
    pub expected_amount_b: u64,
    pub actual_amount_a: u64,
    pub actual_amount_b: u64,
}

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub authority: Pubkey,
    pub agent_executor: Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub last_rebalance_ts: i64,
    pub cooldown_seconds: i64,
    pub active_tick_lower: i32,
    pub active_tick_upper: i32,
    pub rebalance_count: u64,
    pub max_slippage_bps: u16,
    pub bump: u8,
    pub vault_a_bump: u8,
    pub vault_b_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserBalance {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub deposited_a: u64,
    pub deposited_b: u64,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct VaultInitializedEvent {
    pub authority: Pubkey,
    pub agent_executor: Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub max_slippage_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct LiquidityDepositedEvent {
    pub depositor: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub timestamp: i64,
}

#[event]
pub struct RebalanceExecutedEvent {
    pub executor: Pubkey,
    pub old_tick_lower: i32,
    pub old_tick_upper: i32,
    pub new_tick_lower: i32,
    pub new_tick_upper: i32,
    pub kinetic_energy_score: u64,
    pub amount_a_deployed: u64,
    pub amount_b_deployed: u64,
    pub timestamp: i64,
}

#[event]
pub struct AgentUpdatedEvent {
    pub new_executor: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct EmergencyWithdrawalEvent {
    pub authority: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum VaultError {
    #[msg("Admin authorization failed")]
    UnauthorizedAdmin,
    #[msg("Agent signer does not match vault executor")]
    UnauthorizedAgent,
    #[msg("Rebalance requested before cooldown expiry")]
    CooldownActive,
    #[msg("Tick bounds invalid: tick_lower must be strictly less than tick_upper")]
    InvalidTickBounds,
    #[msg("Kinetic energy score must be non-zero")]
    InvalidKineticMetric,
    #[msg("Slippage limit exceeded on Token A")]
    SlippageExceededTokenA,
    #[msg("Slippage limit exceeded on Token B")]
    SlippageExceededTokenB,
    #[msg("Calculated integer math overflow")]
    MathOverflow,
    #[msg("Token mint provided does not match configured vault token mint")]
    InvalidMint,
    #[msg("Deposit amount must be strictly positive for at least one token")]
    ZeroDepositAmount,
    #[msg("Max slippage basis points must be <= 1000 (10%)")]
    ExcessiveSlippageSetting,
    #[msg("Cooldown must be at least 10 seconds")]
    CooldownTooShort,
}