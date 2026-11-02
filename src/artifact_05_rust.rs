use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct VaultConfig {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub token_mint_a: Pubkey,
    pub token_mint_b: Pubkey,
    pub token_vault_a: Pubkey,
    pub token_vault_b: Pubkey,
    pub whirlpool: Pubkey,
    pub current_position: Pubkey,
    pub lower_tick: i32,
    pub upper_tick: i32,
    pub max_tick_shift_per_rebalance: u32,
    pub min_tick_width: u32,
    pub max_tick_width: u32,
    pub max_allowed_slippage_bps: u16,
    pub is_paused: bool,
    pub bump: u8,
    pub vault_a_bump: u8,
    pub vault_b_bump: u8,
}

impl VaultConfig {
    pub const LEN: usize = 8 + // discriminator
        32 + // admin
        32 + // keeper
        32 + // token_mint_a
        32 + // token_mint_b
        32 + // token_vault_a
        32 + // token_vault_b
        32 + // whirlpool
        32 + // current_position
        4 +  // lower_tick
        4 +  // upper_tick
        4 +  // max_tick_shift_per_rebalance
        4 +  // min_tick_width
        4 +  // max_tick_width
        2 +  // max_allowed_slippage_bps
        1 +  // is_paused
        1 +  // bump
        1 +  // vault_a_bump
        1;   // vault_b_bump
}