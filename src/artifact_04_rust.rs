use anchor_lang::prelude::*;

#[error_code]
pub enum KineticVaultError {
    #[msg("Unauthorized keeper execution attempt.")]
    UnauthorizedKeeper,
    #[msg("Vault is currently paused by governance circuit breaker.")]
    VaultPaused,
    #[msg("Proposed tick spread is too narrow, violating safety margin.")]
    TickSpreadTooNarrow,
    #[msg("Proposed tick spread exceeds maximum permitted bandwidth.")]
    TickSpreadTooWide,
    #[msg("Slippage limit violated during dynamic tick re-centering.")]
    ExcessiveSlippage,
    #[msg("Price velocity exceeds circuit-breaker kinetic limits.")]
    KineticShockTriggered,
    #[msg("Invalid token mint supplied.")]
    InvalidTokenMint,
    #[msg("Math calculation overflow or underflow.")]
    MathOverflow,
}