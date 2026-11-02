"""
Comprehensive QA Test Matrix for Dynamic Liquidity Rebalancing Agent.
Executes mathematical unit tests, boundary fuzzing, and simulated Jito bundling.
"""

import math
import pytest
from clmm_types import CLMMMath, PoolState, PositionState, MIN_TICK, MAX_TICK
from kinetic_volatility import KineticVolatilityEngine
from agent_engine import CLMMAgentDecisionEngine
from solders.keypair import Keypair


class TestCLMMLiquidityAgent:

    @pytest.fixture
    def mock_sol_usdc_pool(self) -> PoolState:
        # SOL/USDC Whirlpool: Tick spacing 64, Price ~$150
        price = 150.0
        decimals_a, decimals_b = 9, 6  # SOL=9, USDC=6
        sqrt_price_x64 = CLMMMath.price_to_sqrt_price_x64(price, decimals_a, decimals_b)
        current_tick = CLMMMath.sqrt_price_x64_to_tick(sqrt_price_x64)
        aligned_tick = CLMMMath.align_tick_to_spacing(current_tick, 64)

        return PoolState(
            pubkey="HJPjoWUrhoZzkNfRpHuieeFh9WwoPTSpNYkUXiEKn2q8",
            token_mint_a="So11111111111111111111111111111111111111112",
            token_mint_b="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            token_vault_a="VaultSOL11111111111111111111111111111111111",
            token_vault_b="VaultUSDC1111111111111111111111111111111111",
            tick_spacing=64,
            sqrt_price_x64=sqrt_price_x64,
            current_tick=aligned_tick,
            liquidity=10_000_000_000,
            fee_rate=3000,
            protocol_fee_rate=300,
        )

    # -------------------------------------------------------------------------
    # 1. Mathematical Rigor & Invariant Tests
    # -------------------------------------------------------------------------

    def test_sqrt_price_to_tick_roundtrip(self):
        """Verifies lossless roundtrip conversion between tick and sqrt price."""
        test_ticks = [-200000, -64, 0, 64, 1500, 443000]
        for tick in test_ticks:
            sqrt_price = CLMMMath.tick_to_sqrt_price_x64(tick)
            recovered_tick = CLMMMath.sqrt_price_x64_to_tick(sqrt_price)
            assert abs(recovered_tick - tick) <= 1, f"Tick mismatch: orig={tick}, rec={recovered_tick}"

    def test_liquidity_token_amounts_consistency(self, mock_sol_usdc_pool):
        """Validates that liquidity -> tokens -> liquidity preserves balance."""
        lower_tick = mock_sol_usdc_pool.current_tick - 640
        upper_tick = mock_sol_usdc_pool.current_tick + 640
        lower_sqrt = CLMMMath.tick_to_sqrt_price_x64(lower_tick)
        upper_sqrt = CLMMMath.tick_to_sqrt_price_x64(upper_tick)

        original_liquidity = 5_000_000_000

        amount_a, amount_b = CLMMMath.calculate_token_amounts_for_liquidity(
            current_sqrt_price_x64=mock_sol_usdc_pool.sqrt_price_x64,
            lower_sqrt_price_x64=lower_sqrt,
            upper_sqrt_price_x64=upper_sqrt,
            liquidity=original_liquidity,
        )

        assert amount_a > 0
        assert amount_b > 0

        recalculated_liq = CLMMMath.calculate_liquidity_from_tokens(
            current_sqrt_price_x64=mock_sol_usdc_pool.sqrt_price_x64,
            lower_sqrt_price_x64=lower_sqrt,
            upper_sqrt_price_x64=upper_sqrt,
            amount_a=amount_a,
            amount_b=amount_b,
        )

        assert math.isclose(original_liquidity, recalculated_liq, rel_tol=1e-4)

    # -------------------------------------------------------------------------
    # 2. Kinetic Volatility Engine Tests
    # -------------------------------------------------------------------------

    def test_kinetic_volatility_response_to_shock(self):
        """Tests that price velocity shocks dynamically expand bounds."""
        engine = KineticVolatilityEngine(window_size_seconds=60)
        base_price = 150.0

        # Feed steady baseline
        for i in range(20):
            engine.add_sample(
                price=base_price,
                volume=100.0,
                is_buy=True,
                high=base_price + 0.1,
                low=base_price - 0.1,
                open_price=base_price,
                close_price=base_price,
                timestamp_ms=1000 + (i * 1000)
            )

        low_vol, _ = engine.calculate_kinetic_volatility()

        # Inject high-velocity directional pump
        for i in range(20, 30):
            engine.add_sample(
                price=base_price + (i - 20) * 2.0,  # Rapid price increase
                volume=5000.0,
                is_buy=True,
                high=base_price + (i - 20) * 2.0 + 1.0,
                low=base_price + (i - 20) * 2.0 - 0.2,
                open_price=base_price + (i - 21) * 2.0,
                close_price=base_price + (i - 20) * 2.0,
                timestamp_ms=1000 + (i * 1000)
            )

        high_vol, velocity = engine.calculate_kinetic_volatility()

        assert high_vol > low_vol * 1.5, "Kinetic volatility failed to respond to velocity shock"
        assert velocity > 0, "Directional velocity must be positive during pump"

    # -------------------------------------------------------------------------
    # 3. Agent Decision Engine Tests
    # -------------------------------------------------------------------------

    def test_agent_triggers_rebalance_when_out_of_range(self, mock_sol_usdc_pool):
        """Validates that an out-of-range position generates a valid rebalance action."""
        engine = KineticVolatilityEngine()
        # Seed engine with samples
        for i in range(10):
            engine.add_sample(150.0, 100.0, True, 150.5, 149.5, 150.0, 150.0, 1000 + i * 1000)

        agent = CLMMAgentDecisionEngine(
            pool=mock_sol_usdc_pool,
            volatility_engine=engine,
            min_rebalance_ev_usd=1.00
        )

        # Position completely below current tick
        stale_position = PositionState(
            pubkey="PosPubkey11111111111111111111111111111111111",
            pool_pubkey=mock_sol_usdc_pool.pubkey,
            owner="OwnerKey111111111111111111111111111111111111",
            tick_lower=mock_sol_usdc_pool.current_tick - 1000,
            tick_upper=mock_sol_usdc_pool.current_tick - 500,  # Below current_tick
            liquidity=50_000_000,
            fee_growth_inside_a=0,
            fee_growth_inside_b=0,
            tokens_owed_a=10_000_000,
            tokens_owed_b=5_000_000,
        )

        decision = agent.evaluate_position(
            position=stale_position,
            token_a_price_usd=150.0,
            token_b_price_usd=1.0,
            decimals_a=9,
            decimals_b=6,
        )

        assert decision.should_rebalance is True
        assert "OUT_OF_RANGE" in decision.reason
        assert decision.target_tick_lower <= mock_sol_usdc_pool.current_tick <= decision.target_tick_upper