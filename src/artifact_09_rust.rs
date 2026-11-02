use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Kinet1cReba1ance111111111111111111111111111");

#[program]
pub mod kinetic_rebalancer {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        cooldown_seconds: i64,
        max_slippage_bps: u16,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, cooldown_seconds, max_slippage_bps)
    }

    pub fn rebalance(
        ctx: Context<Rebalance>,
        proof: KineticProof,
    ) -> Result<()> {
        instructions::rebalance::handler(ctx, proof)
    }
}