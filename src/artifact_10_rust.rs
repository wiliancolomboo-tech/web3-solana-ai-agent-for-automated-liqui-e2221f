use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::{PositionState, VaultConfig};

#[derive(Accounts)]
pub struct DepositVault<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"config", config.pool_id.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, VaultConfig>,

    #[account(
        init_if_needed,
        payer = user,
        space = PositionState::LEN,
        seeds = [b"position", config.key().as_ref()],
        bump
    )]
    pub position: Account<'info, PositionState>,

    #[account(mut, address = config.token_a_vault)]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(mut, address = config.token_b_vault)]
    pub vault_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_b: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositVault>, amount_a: u64, amount_b: u64) -> Result<()> {
    if amount_a > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_a.to_account_info(),
            to: ctx.accounts.vault_a.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount_a)?;
    }

    if amount_b > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_b.to_account_info(),
            to: ctx.accounts.vault_b.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount_b)?;
    }

    let position = &mut ctx.accounts.position;
    if position.vault == Pubkey::default() {
        position.vault = ctx.accounts.config.key();
        position.bump = ctx.bumps.position;
    }

    msg!("Deposit complete: {} Token A, {} Token B", amount_a, amount_b);
    Ok(())
}