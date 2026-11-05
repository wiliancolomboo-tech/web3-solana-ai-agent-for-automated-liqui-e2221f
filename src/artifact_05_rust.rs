use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Kinet1cRebaL1qu1d1tyVault11111111111111111");

pub const MAXIMUM_TICK_DRIFT_PER_REBALANCE: i32 = 4000;
pub const MINIMUM_REBALANCE_COOLDOWN_SLOTS: u64 = 75; // ~30 seconds on Solana
pub const MAX_BASIS_POINTS: u16 = 10_000;

#[program]
pub mod kinetic_rebalance {
    use super::*;

    /// Initialize the enterprise kinetic rebalancing vault
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        strategy_id: u64,
        max_slippage_bps: u16,
        operator_pubkey: Pubkey,
    ) -> Result<()> {
        require!(
            max_slippage_bps <= 1_000,
            KineticError::ExcessiveSlippageTolerance
        );

        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.owner = ctx.accounts.owner.key();
        vault_state.operator = operator_pubkey;
        vault_state.token_mint_a = ctx.accounts.token_mint_a.key();
        vault_state.token_mint_b = ctx.accounts.token_mint_b.key();
        vault_state.token_vault_a = ctx.accounts.token_vault_a.key();
        vault_state.token_vault_b = ctx.accounts.token_vault_b.key();
        vault_state.strategy_id = strategy_id;
        vault_state.max_slippage_bps = max_slippage_bps;
        vault_state.last_rebalance_slot = Clock::get()?.slot;
        vault_state.current_lower_tick = 0;
        vault_state.current_upper_tick = 0;
        vault_state.total_rebalance_count = 0;
        vault_state.is_paused = false;
        vault_state.bump = ctx.bumps.vault_state;

        emit!(VaultInitializedEvent {
            strategy_id,
            owner: vault_state.owner,
            operator: operator_pubkey,
            max_slippage_bps,
        });

        Ok(())
    }

    /// Deposit funds into the kinetic vault
    pub fn deposit(
        ctx: Context<DepositTokens>,
        amount_a: u64,
        amount_b: u64,
    ) -> Result<()> {
        require!(amount_a > 0 || amount_b > 0, KineticError::ZeroDepositAmount);

        if amount_a > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_a.to_account_info(),
                        to: ctx.accounts.token_vault_a.to_account_info(),
                        authority: ctx.accounts.user_authority.to_account_info(),
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
                        to: ctx.accounts.token_vault_b.to_account_info(),
                        authority: ctx.accounts.user_authority.to_account_info(),
                    },
                ),
                amount_b,
            )?;
        }

        emit!(FundsDepositedEvent {
            owner: ctx.accounts.user_authority.key(),
            amount_a,
            amount_b,
            slot: Clock::get()?.slot,
        });

        Ok(())
    }

    /// Rebalance CLMM position according to kinetic parameters verified on-chain
    pub fn execute_rebalance(
        ctx: Context<ExecuteRebalance>,
        params: RebalanceParams,
    ) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        let current_slot = Clock::get()?.slot;

        // Security Guardrails
        require!(!vault_state.is_paused, KineticError::VaultIsPaused);
        require!(
            current_slot >= vault_state.last_rebalance_slot.saturating_add(MINIMUM_REBALANCE_COOLDOWN_SLOTS),
            KineticError::RebalanceCooldownActive
        );
        require!(
            params.new_lower_tick < params.new_upper_tick,
            KineticError::InvalidTickOrder
        );
        require!(
            params.slippage_bps <= vault_state.max_slippage_bps,
            KineticError::ExceededMaxAllowedSlippage
        );

        // Kinetic Jump Boundary Verification
        if vault_state.total_rebalance_count > 0 {
            let tick_drift_lower = (params.new_lower_tick - vault_state.current_lower_tick).abs();
            let tick_drift_upper = (params.new_upper_tick - vault_state.current_upper_tick).abs();

            require!(
                tick_drift_lower <= MAXIMUM_TICK_DRIFT_PER_REBALANCE &&
                tick_drift_upper <= MAXIMUM_TICK_DRIFT_PER_REBALANCE,
                KineticError::KineticDiscontinuityExceeded
            );
        }

        // Update State
        vault_state.current_lower_tick = params.new_lower_tick;
        vault_state.current_upper_tick = params.new_upper_tick;
        vault_state.last_rebalance_slot = current_slot;
        vault_state.total_rebalance_count = vault_state.total_rebalance_count.saturating_add(1);

        emit!(RebalanceExecutedEvent {
            strategy_id: vault_state.strategy_id,
            slot: current_slot,
            new_lower_tick: params.new_lower_tick,
            new_upper_tick: params.new_upper_tick,
            kinetic_volatility: params.observed_kinetic_volatility,
            drift_metric: params.kinetic_drift_metric,
            rebalance_index: vault_state.total_rebalance_count,
        });

        Ok(())
    }

    /// Emergency pause switch triggered by operator or owner
    pub fn set_pause_state(ctx: Context<SetEmergencyState>, paused: bool) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.is_paused = paused;

        emit!(EmergencyStateUpdatedEvent {
            is_paused: paused,
            slot: Clock::get()?.slot,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Data Structures & Parameters
// -----------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct RebalanceParams {
    pub new_lower_tick: i32,
    pub new_upper_tick: i32,
    pub slippage_bps: u16,
    pub observed_kinetic_volatility: u32, // Fixed-point micro-representation (1e6)
    pub kinetic_drift_metric: i32,        // Directional drift bias in basis points
}

#[account]
pub struct VaultState {
    pub owner: Pubkey,                 // 32
    pub operator: Pubkey,              // 32
    pub token_mint_a: Pubkey,          // 32
    pub token_mint_b: Pubkey,          // 32
    pub token_vault_a: Pubkey,         // 32
    pub token_vault_b: Pubkey,         // 32
    pub strategy_id: u64,              // 8
    pub max_slippage_bps: u16,         // 2
    pub last_rebalance_slot: u64,      // 8
    pub current_lower_tick: i32,       // 4
    pub current_upper_tick: i32,       // 4
    pub total_rebalance_count: u64,    // 8
    pub is_paused: bool,               // 1
    pub bump: u8,                      // 1
}

impl VaultState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 32 + 32 + 8 + 2 + 8 + 4 + 4 + 8 + 1 + 1 + 32;
}

// -----------------------------------------------------------------------------
// Instruction Contexts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(strategy_id: u64)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = owner,
        space = VaultState::LEN,
        seeds = [b"kinetic_vault", owner.key().as_ref(), strategy_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,

    pub token_mint_a: Account<'info, Mint>,
    pub token_mint_b: Account<'info, Mint>,

    #[account(
        init,
        payer = owner,
        token::mint = token_mint_a,
        token::authority = vault_state,
        seeds = [b"vault_token_a", vault_state.key().as_ref()],
        bump
    )]
    pub token_vault_a: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = owner,
        token::mint = token_mint_b,
        token::authority = vault_state,
        seeds = [b"vault_token_b", vault_state.key().as_ref()],
        bump
    )]
    pub token_vault_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositTokens<'info> {
    #[account(
        mut,
        has_one = token_vault_a,
        has_one = token_vault_b
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut)]
    pub token_vault_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub token_vault_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_b: Account<'info, TokenAccount>,

    pub user_authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExecuteRebalance<'info> {
    #[account(
        mut,
        has_one = operator,
    )]
    pub vault_state: Account<'info, VaultState>,
    pub operator: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetEmergencyState<'info> {
    #[account(
        mut,
        constraint = vault_state.owner == authority.key() || vault_state.operator == authority.key() @ KineticError::Unauthorized
    )]
    pub vault_state: Account<'info, VaultState>,
    pub authority: Signer<'info>,
}

// -----------------------------------------------------------------------------
// Events & Errors
// -----------------------------------------------------------------------------

#[event]
pub struct VaultInitializedEvent {
    pub strategy_id: u64,
    pub owner: Pubkey,
    pub operator: Pubkey,
    pub max_slippage_bps: u16,
}

#[event]
pub struct FundsDepositedEvent {
    pub owner: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub slot: u64,
}

#[event]
pub struct RebalanceExecutedEvent {
    pub strategy_id: u64,
    pub slot: u64,
    pub new_lower_tick: i32,
    pub new_upper_tick: i32,
    pub kinetic_volatility: u32,
    pub drift_metric: i32,
    pub rebalance_index: u64,
}

#[event]
pub struct EmergencyStateUpdatedEvent {
    pub is_paused: bool,
    pub slot: u64,
}

#[error_code]
pub enum KineticError {
    #[msg("Requested slippage exceeds safety guardrail maximum (10%).")]
    ExcessiveSlippageTolerance,
    #[msg("Deposit amount must be strictly greater than zero.")]
    ZeroDepositAmount,
    #[msg("Rebalance cooldown active. Minimum slot interval not reached.")]
    RebalanceCooldownActive,
    #[msg("Tick ordering invalid. Lower tick must be strictly less than upper tick.")]
    InvalidTickOrder,
    #[msg("Rebalance parameters exceed maximum slippage limit.")]
    ExceededMaxAllowedSlippage,
    #[msg("Kinetic tick drift exceeds safety threshold in a single transition.")]
    KineticDiscontinuityExceeded,
    #[msg("Vault is currently paused by the emergency circuit breaker.")]
    VaultIsPaused,
    #[msg("Unauthorized signer for the requested instruction.")]
    Unauthorized,
}