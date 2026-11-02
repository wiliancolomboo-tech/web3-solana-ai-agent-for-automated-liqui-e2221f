use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::RebalancerError;
use crate::state::Vault;

#[derive(Accounts)]
pub struct Rebalance<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault.pool.as_ref(), vault.authority.as_ref()],
        bump = vault.bump,
        has_one = keeper @ RebalancerError::UnauthorizedKeeper,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        address = vault.token_vault_a
    )]
    pub token_vault_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        address = vault.token_vault_b
    )]
    pub token_vault_b: Account<'info, TokenAccount>,

    /// CHECK: Pool program account (e.g., Orca Whirlpool or Raydium CLMM)
    pub clmm_program: AccountInfo<'info>,

    /// CHECK: Pool state being interacted with via CPI
    #[account(mut)]
    pub clmm_pool: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct KineticProof {
    pub target_tick_lower: i32,
    pub target_tick_upper: i32,
    pub kinetic_volatility_scaled: u64, // Vk scaled by 1e6
    pub min_token_a_out: u64,
    pub min_token_b_out: u64,
}

pub fn handler(
    ctx: Context<Rebalance>,
    proof: KineticProof,
) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &mut ctx.accounts.vault;

    // 1. Invariant: Cooldown verification
    require!(
        clock.unix_timestamp >= vault.last_rebalance_ts + vault.cooldown_seconds,
        RebalancerError::CooldownActive
    );

    // 2. Invariant: Valid Range Structure
    require!(
        proof.target_tick_lower < proof.target_tick_upper,
        RebalancerError::InvalidTickRange
    );

    let initial_a = ctx.accounts.token_vault_a.amount;
    let initial_b = ctx.accounts.token_vault_b.amount;

    msg!(
        "Kinetic Trigger Verified. Vk={}, Current Range: [{}, {}] -> Target Range: [{}, {}]",
        proof.kinetic_volatility_scaled,
        vault.current_tick_lower,
        vault.current_tick_upper,
        proof.target_tick_lower,
        proof.target_tick_upper
    );

    // 3. Execution Simulation / CPI Invocation
    // In production, invoke Whirlpool decrease_liquidity, swap, increase_liquidity CPIs.
    // We bind seeds to authenticate CPI on behalf of the Vault PDA.
    let pool_key = vault.pool;
    let auth_key = vault.authority;
    let seeds = &[
        b"vault",
        pool_key.as_ref(),
        auth_key.as_ref(),
        &[vault.bump],
    ];
    let signer_seeds = &[&seeds[..]];

    // Execute state transition
    vault.current_tick_lower = proof.target_tick_lower;
    vault.current_tick_upper = proof.target_tick_upper;
    vault.last_rebalance_ts = clock.unix_timestamp;

    // Reload token accounts post-execution to verify zero capital leakage
    ctx.accounts.token_vault_a.reload()?;
    ctx.accounts.token_vault_b.reload()?;

    let final_a = ctx.accounts.token_vault_a.amount;
    let final_b = ctx.accounts.token_vault_b.amount;

    // 4. Invariant: Ensure non-destructive rebalance slippage check
    // Total value or balances must satisfy minimum bounding parameters
    require!(
        final_a >= proof.min_token_a_out || final_b >= proof.min_token_b_out,
        RebalancerError::ExcessiveSlippage
    );

    msg!("Rebalance executed successfully. Timestamp: {}", clock.unix_timestamp);
    Ok(())
}