def validate_rebalance_safety(
    pool: PoolState,
    pyth_oracle_price_usd: float,
    target_tick_lower: int,
    target_tick_upper: int,
    decimals_a: int,
    decimals_b: int,
    max_oracle_divergence_pct: float = 0.012
) -> None:
    """
    Security Gate: Asserts tick bounds and validates spot price against Pyth Oracle.
    Prevents execution during flash loan manipulation.
    """
    # 1. Invariant: Valid tick bounds
    assert MIN_TICK <= target_tick_lower < target_tick_upper <= MAX_TICK, (
        f"Invalid tick bounds: lower={target_tick_lower}, upper={target_tick_upper}"
    )

    # 2. Invariant: Proper tick spacing alignment
    assert (target_tick_lower % pool.tick_spacing == 0), "Lower tick not aligned to tick spacing"
    assert (target_tick_upper % pool.tick_spacing == 0), "Upper tick not aligned to tick spacing"

    # 3. Oracle Divergence Check
    current_pool_price = CLMMMath.sqrt_price_x64_to_price(
        pool.sqrt_price_x64, decimals_a, decimals_b
    )
    divergence = abs(current_pool_price - pyth_oracle_price_usd) / pyth_oracle_price_usd

    if divergence > max_oracle_divergence_pct:
        raise ValueError(
            f"Oracle Divergence Circuit Breaker Triggered: "
            f"Pool Price = {current_pool_price:.4f}, Oracle Price = {pyth_oracle_price_usd:.4f}, "
            f"Divergence = {divergence * 100:.2f}% (Limit: {max_oracle_divergence_pct * 100}%)"
        )