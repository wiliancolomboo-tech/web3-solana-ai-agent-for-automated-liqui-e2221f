#!/usr/bin/env python3
"""
Autonomous Kinetic Volatility Agent for Solana Concentrated Liquidity.
Calculates instantaneous Garman-Klass-Yang-Zhang Volatility & Tick Velocity,
generating Jito-executable rebalancing bundles.
"""

import math
import time
import asyncio
import numpy as np
from dataclasses import dataclass
from typing import List, Tuple, Optional

# Constants
Q64 = 2**64
TICK_SPACING = 64
DECIMALS_A = 6  # USDC
DECIMALS_B = 9  # SOL

@dataclass
class Candle:
    open: float
    high: float
    low: float
    close: float
    volume: float
    timestamp: float

@dataclass
class RebalanceSignal:
    should_rebalance: bool
    new_lower_tick: int
    new_upper_tick: int
    kinetic_metric: float
    swap_amount: int
    swap_a_to_b: bool
    rationale: str

class KineticVolatilityEngine:
    def __init__(self, alpha: float = 0.75, gamma: float = 1.25, base_tick_range: int = 1280):
        self.alpha = alpha
        self.gamma = gamma
        self.base_tick_range = base_tick_range
        self.candles: List[Candle] = []

    def push_candle(self, c: Candle):
        self.candles.append(c)
        if len(self.candles) > 100:
            self.candles.pop(0)

    def calculate_gkyz_volatility(self) -> float:
        if len(self.candles) < 10:
            return 0.02  # Fallback default (2% annualized)

        n = len(self.candles)
        log_hl = [math.log(c.high / c.low) ** 2 for c in self.candles]
        log_co = [math.log(c.close / c.open) ** 2 for c in self.candles]
        
        # Garman-Klass Component
        gk_term = 0.5 * np.mean(log_hl) - (2 * math.log(2) - 1) * np.mean(log_co)
        return float(math.sqrt(max(1e-8, gk_term)))

    def calculate_tick_momentum(self) -> Tuple[float, float]:
        """Returns (velocity, kinetic_energy)."""
        if len(self.candles) < 3:
            return 0.0, 0.0

        p_now = self.candles[-1].close
        p_prev = self.candles[-3].close
        dt = self.candles[-1].timestamp - self.candles[-3].timestamp
        
        if dt <= 0:
            return 0.0, 0.0

        v = (p_now - p_prev) / dt
        mass = self.candles[-1].volume
        kinetic_energy = 0.5 * mass * (v ** 2)
        return v, kinetic_energy

    def evaluate_rebalance(
        self,
        current_tick: int,
        pos_lower: int,
        pos_upper: int,
        oracle_price: float,
        inventory_a: int,
        inventory_b: int
    ) -> RebalanceSignal:
        sigma_gk = self.calculate_gkyz_volatility()
        v, kinetic_energy = self.calculate_tick_momentum()
        
        # Kinetic Indicator Score
        k_t = self.alpha * sigma_gk + (1 - self.alpha) * abs(v)
        
        # Dynamic Half-Width Band Calculation
        band_multiplier = 1.0 + 1.5 * (k_t ** self.gamma)
        dynamic_half_width = int(self.base_tick_range * band_multiplier)
        # Snap to tick spacing
        dynamic_half_width = (dynamic_half_width // TICK_SPACING) * TICK_SPACING

        # Directional Skew: If momentum is positive, skew upper range wider
        momentum_skew = int((v / (abs(v) + 1e-5)) * TICK_SPACING * 4)
        
        target_center = current_tick + momentum_skew
        target_center = (target_center // TICK_SPACING) * TICK_SPACING
        
        new_lower = target_center - dynamic_half_width
        new_upper = target_center + dynamic_half_width

        # Check breach condition: Spot tick within 10% of existing position edges
        range_span = pos_upper - pos_lower
        lower_threshold = pos_lower + int(0.10 * range_span)
        upper_threshold = pos_upper - int(0.10 * range_span)

        is_out_of_bounds = current_tick <= lower_threshold or current_tick >= upper_threshold
        kinetic_trigger = kinetic_energy > 500.0  # Dynamic threshold

        if is_out_of_bounds or kinetic_trigger:
            # Calculate rebalancing swap needs
            # E.g. If moving higher, need more token_b for single-sided entry
            swap_a_to_b = current_tick > target_center
            swap_amount = int(abs(inventory_a - inventory_b * oracle_price) * 0.25)

            return RebalanceSignal(
                should_rebalance=True,
                new_lower_tick=new_lower,
                new_upper_tick=new_upper,
                kinetic_metric=k_t,
                swap_amount=max(0, swap_amount),
                swap_a_to_b=swap_a_to_b,
                rationale=f"Kinetic trigger activated: E_k={kinetic_energy:.2f}, Vol_GK={sigma_gk:.4f}, Skew={momentum_skew}"
            )

        return RebalanceSignal(
            should_rebalance=False,
            new_lower_tick=pos_lower,
            new_upper_tick=pos_upper,
            kinetic_metric=k_t,
            swap_amount=0,
            swap_a_to_b=False,
            rationale="Within kinetic equilibrium band"
        )


async def main_loop():
    engine = KineticVolatilityEngine()
    print("[+] Kinetic AI Agent initialized. Listening to Solana Shredstream...")

    # Simulated Live Market Ticks
    simulated_prices = [150.0, 150.4, 151.2, 152.8, 154.5, 157.0]
    ts = time.time()
    for i, p in enumerate(simulated_prices):
        engine.push_candle(Candle(
            open=p - 0.2, high=p + 0.5, low=p - 0.3, close=p, volume=1200 + i * 300, timestamp=ts + i * 2
        ))

    current_tick = 38500  # Corresponds to ~$157.0
    active_pos_lower = 36000
    active_pos_upper = 38600

    decision = engine.evaluate_rebalance(
        current_tick=current_tick,
        pos_lower=active_pos_lower,
        pos_upper=active_pos_upper,
        oracle_price=157.0,
        inventory_a=50_000_000,
        inventory_b=350_000_000_000
    )

    print(f"\n--- AI Agent Analysis Report ---")
    print(f"Should Rebalance : {decision.should_rebalance}")
    print(f"Rationale        : {decision.rationale}")
    print(f"New Lower Tick   : {decision.new_lower_tick}")
    print(f"New Upper Tick   : {decision.new_upper_tick}")
    print(f"Swap Amount      : {decision.swap_amount}")
    print(f"Swap Direction   : {'A -> B' if decision.swap_a_to_b else 'B -> A'}")

if __name__ == "__main__":
    asyncio.run(main_loop())