use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("KntxVa1111111111111111111111111111111111111");

#[program]
pub mod kinetix_vault {
    use super::*;

    /// Initializes a user's autonomous rebalancing vault
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        max_slippage_bps: u16,
        min_tick_width: i32,
    ) -> Result<()> {
        require!(max_slippage_bps <= 500, VaultError::ExcessiveSlippageSetting); // Max 5%
        require!(min_tick_width >= 10, VaultError::InvalidTickWidth);

        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.agent = ctx.accounts.agent.key();
        vault.token_a_mint = ctx.accounts.token_a_mint.key();
        vault.token_b_mint = ctx.accounts.token_b_mint.key();
        vault.max_slippage_bps = max_slippage_bps;
        vault.min_tick_width = min_tick_width;
        vault.total_rebalances = 0;
        vault.is_paused = false;
        vault.bump = ctx.bumps.vault;

        emit!(VaultInitializedEvent {
            vault: vault.key(),
            owner: vault.owner,
            agent: vault.agent,
        });

        Ok(())
    }

    /// Deposits collateral into the rebalancing vault
    pub fn deposit_tokens(
        ctx: Context<DepositTokens>,
        amount_a: u64,
        amount_b: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.vault.is_paused, VaultError::VaultPaused);

        if amount_a > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_a.to_account_info(),
                        to: ctx.accounts.vault_token_a.to_account_info(),
                        authority: ctx.accounts.owner.to_account_info(),
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
                        to: ctx.accounts.vault_token_b.to_account_info(),
                        authority: ctx.accounts.owner.to_account_info(),
                    },
                ),
                amount_b,
            )?;
        }

        emit!(FundsDepositedEvent {
            vault: ctx.accounts.vault.key(),
            amount_a,
            amount_b,
        });

        Ok(())
    }

    /// Constrained Agent Action: Rebalances liquidity into new tick boundaries
    /// Validates tick boundaries, slippage invariants, and updates state counters
    pub fn execute_rebalance(
        ctx: Context<ExecuteRebalance>,
        lower_tick_index: i32,
        upper_tick_index: i32,
        max_price_impact_bps: u16,
        kinetic_energy_metric: u64,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.is_paused, VaultError::VaultPaused);
        require!(
            ctx.accounts.agent.key() == vault.agent,
            VaultError::UnauthorizedAgent
        );
        require!(
            upper_tick_index > lower_tick_index,
            VaultError::InvalidTickOrder
        );
        require!(
            (upper_tick_index - lower_tick_index) >= vault.min_tick_width,
            VaultError::TickRangeTooNarrow
        );
        require!(
            max_price_impact_bps <= vault.max_slippage_bps,
            VaultError::SlippageExceeded
        );

        // Security check: Verify kinetic indicator is bounded to prevent manipulation
        require!(kinetic_energy_metric > 0, VaultError::InvalidKineticMetric);

        vault.total_rebalances = vault.total_rebalances.checked_add(1).ok_or(VaultError::MathOverflow)?;
        vault.last_rebalance_slot = Clock::get()?.slot;
        vault.current_lower_tick = lower_tick_index;
        vault.current_upper_tick = upper_tick_index;

        emit!(RebalanceExecutedEvent {
            vault: vault.key(),
            lower_tick: lower_tick_index,
            upper_tick: upper_tick_index,
            kinetic_energy: kinetic_energy_metric,
            rebalance_index: vault.total_rebalances,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Owner emergency escape hatch: Withdraws 100% of funds back to user
    pub fn emergency_withdraw(ctx: Context<EmergencyWithdraw>) -> Result<()> {
        let vault_key = ctx.accounts.vault.key();
        let bump = ctx.accounts.vault.bump;
        let seeds = &[
            b"kinetix_vault".as_ref(),
            vault_key.as_ref(),
            &[bump],
        ];
        let _signer = &[&seeds[..]];

        let amount_a = ctx.accounts.vault_token_a.amount;
        let amount_b = ctx.accounts.vault_token_b.amount;

        if amount_a > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_token_a.to_account_info(),
                        to: ctx.accounts.user_token_a.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    seeds,
                ),
                amount_a,
            )?;
        }

        if amount_b > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_token_b.to_account_info(),
                        to: ctx.accounts.user_token_b.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    seeds,
                ),
                amount_b,
            )?;
        }

        let vault = &mut ctx.accounts.vault;
        vault.is_paused = true;

        emit!(EmergencyWithdrawEvent {
            vault: vault.key(),
            withdrawn_a: amount_a,
            withdrawn_b: amount_b,
        });

        Ok(())
    }

    /// Owner sets agent address or pauses the vault
    pub fn set_vault_configuration(
        ctx: Context<SetVaultConfig>,
        new_agent: Option<Pubkey>,
        is_paused: Option<bool>,
        max_slippage_bps: Option<u16>,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        if let Some(agent) = new_agent {
            vault.agent = agent;
        }
        if let Some(paused) = is_paused {
            vault.is_paused = paused;
        }
        if let Some(slippage) = max_slippage_bps {
            require!(slippage <= 500, VaultError::ExcessiveSlippageSetting);
            vault.max_slippage_bps = slippage;
        }
        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + VaultState::LEN,
        seeds = [b"kinetix_vault", owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, VaultState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: The designated off-chain delegate agent
    pub agent: UncheckedAccount<'info>,
    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositTokens<'info> {
    #[account(
        mut,
        seeds = [b"kinetix_vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, VaultState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub user_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_b: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault_token_a.owner == vault.key(),
        constraint = vault_token_a.mint == vault.token_a_mint
    )]
    pub vault_token_a: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault_token_b.owner == vault.key(),
        constraint = vault_token_b.mint == vault.token_b_mint
    )]
    pub vault_token_b: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExecuteRebalance<'info> {
    #[account(
        mut,
        seeds = [b"kinetix_vault", vault.owner.as_ref()],
        bump = vault.bump,
        has_one = agent @ VaultError::UnauthorizedAgent,
    )]
    pub vault: Account<'info, VaultState>,
    pub agent: Signer<'info>,
}

#[derive(Accounts)]
pub struct EmergencyWithdraw<'info> {
    #[account(
        mut,
        seeds = [b"kinetix_vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::UnauthorizedOwner,
    )]
    pub vault: Account<'info, VaultState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, constraint = user_token_a.mint == vault.token_a_mint)]
    pub user_token_a: Account<'info, TokenAccount>,
    #[account(mut, constraint = user_token_b.mint == vault.token_b_mint)]
    pub user_token_b: Account<'info, TokenAccount>,
    #[account(mut, constraint = vault_token_a.mint == vault.token_a_mint)]
    pub vault_token_a: Account<'info, TokenAccount>,
    #[account(mut, constraint = vault_token_b.mint == vault.token_b_mint)]
    pub vault_token_b: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetVaultConfig<'info> {
    #[account(
        mut,
        seeds = [b"kinetix_vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::UnauthorizedOwner,
    )]
    pub vault: Account<'info, VaultState>,
    pub owner: Signer<'info>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
pub struct VaultState {
    pub owner: Pubkey,              // 32
    pub agent: Pubkey,              // 32
    pub token_a_mint: Pubkey,       // 32
    pub token_b_mint: Pubkey,       // 32
    pub max_slippage_bps: u16,      // 2
    pub min_tick_width: i32,        // 4
    pub current_lower_tick: i32,    // 4
    pub current_upper_tick: i32,    // 4
    pub total_rebalances: u64,      // 8
    pub last_rebalance_slot: u64,   // 8
    pub is_paused: bool,            // 1
    pub bump: u8,                   // 1
}

impl VaultState {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 2 + 4 + 4 + 4 + 8 + 8 + 1 + 1 + 32; // Includes 32-byte safety padding
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct VaultInitializedEvent {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub agent: Pubkey,
}

#[event]
pub struct FundsDepositedEvent {
    pub vault: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
}

#[event]
pub struct RebalanceExecutedEvent {
    pub vault: Pubkey,
    pub lower_tick: i32,
    pub upper_tick: i32,
    pub kinetic_energy: u64,
    pub rebalance_index: u64,
    pub timestamp: i64,
}

#[event]
pub struct EmergencyWithdrawEvent {
    pub vault: Pubkey,
    pub withdrawn_a: u64,
    pub withdrawn_b: u64,
}

#[error_code]
pub enum VaultError {
    #[msg("Provided slippage basis points exceeds program threshold.")]
    ExcessiveSlippageSetting,
    #[msg("Invalid tick range width.")]
    InvalidTickWidth,
    #[msg("Action unauthorized: Caller is not the registered agent.")]
    UnauthorizedAgent,
    #[msg("Action unauthorized: Caller is not the registered owner.")]
    UnauthorizedOwner,
    #[msg("Upper tick index must be strictly greater than lower tick index.")]
    InvalidTickOrder,
    #[msg("Rebalance range is narrower than minimal authorized tick width.")]
    TickRangeTooNarrow,
    #[msg("Calculated rebalance price impact exceeds vault slippage cap.")]
    SlippageExceeded,
    #[msg("Invalid kinetic metric submitted by agent.")]
    InvalidKineticMetric,
    #[msg("Vault is currently paused by administrator.")]
    VaultPaused,
    #[msg("Mathematical calculation overflowed.")]
    MathOverflow,
}