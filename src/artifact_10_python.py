#!/usr/bin/env python3
"""
Kinetic Volatility Autonomous Liquidity Agent (K-ALR)
Monitors high-frequency CLMM pools, calculates kinetic volatility tensors,
and submits rebalance transactions when boundaries are breached.
"""

import asyncio
import json
import logging
import math
import os
import time
from dataclasses import dataclass
from typing import List, Tuple

import numpy as np
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta
from solders.transaction import VersionedTransaction
from solders.message import MessageV0

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("KineticAgent")

@dataclass
class Candle:
    open: float
    high: float
    low: float
    close: float
    timestamp: float

class KineticVolatilityEstimator:
    def __init__(self, alpha: float = 0.5, beta: float = 0.3, gamma: float = 0.2):
        self.alpha = alpha
        self.beta = beta
        self.gamma = gamma

    def compute_gkyz(self, candles: List[Candle]) -> float:
        """Computes Garman-Klass-Yang-Zhang Volatility estimator."""
        if len(candles) < 2:
            return 0.0
        n = len(candles)
        sum_val = 0.0
        for c in candles:
            u = math.log(c.high / c.open) if c.open > 0 else 0.0
            d = math.log(c.low / c.open) if c.open > 0 else 0.0
            c_val = math.log(c.close / c.open) if c.open > 0 else 0.0
            term = 0.511 * ((u - d) ** 2) - 0.019 * (c_val * (u + d) - 2 * u * d) - 0.383 * (c_val ** 2)
            sum_val += term
        return math.sqrt(max(0.0, sum_val / n))

    def compute_kinetic_metric(self, price_series: np.ndarray, dt: float, candles: List[Candle]) -> float:
        """
        Calculates Kinetic Volatility Metric:
        Vk = alpha * GKYZ + beta * ||velocity|| + gamma * ||acceleration||
        """
        if len(price_series) < 3:
            return 0.0

        # Log returns velocity: dp/dt
        log_prices = np.log(price_series)
        velocity = np.diff(log_prices) / dt

        # Acceleration: d^2p/dt^2
        acceleration = np.diff(velocity) / dt

        norm_v = float(np.abs(velocity[-1]))
        norm_a = float(np.abs(acceleration[-1]))
        sigma_gkyz = self.compute_gkyz(candles)

        vk = (self.alpha * sigma_gkyz) + (self.beta * norm_v) + (self.gamma * norm_a)
        return vk

class KineticRebalanceAgent:
    def __init__(
        self,
        rpc_url: str,
        program_id_str: str,
        vault_pubkey_str: str,
        keeper_keypair: Keypair,
    ):
        self.rpc_client = AsyncClient(rpc_url)
        self.program_id = Pubkey.from_string(program_id_str)
        self.vault_pubkey = Pubkey.from_string(vault_pubkey_str)
        self.keeper = keeper_keypair
        self.estimator = KineticVolatilityEstimator()
        self.price_history: List[float] = []
        self.candles: List[Candle] = []
        self.last_candle_time = time.time()
        self.current_candle = None
        self.vk_rebalance_threshold = 0.045  # 4.5% kinetic drift trigger

    def update_price(self, price: float):
        now = time.time()
        self.price_history.append(price)
        if len(self.price_history) > 300:
            self.price_history.pop(0)

        # 5-second candle aggregation
        if self.current_candle is None or (now - self.last_candle_time) >= 5.0:
            if self.current_candle:
                self.candles.append(self.current_candle)
                if len(self.candles) > 60:
                    self.candles.pop(0)
            self.current_candle = Candle(open=price, high=price, low=price, close=price, timestamp=now)
            self.last_candle_time = now
        else:
            self.current_candle.high = max(self.current_candle.high, price)
            self.current_candle.low = min(self.current_candle.low, price)
            self.current_candle.close = price

    def price_to_tick(self, price: float, tick_spacing: int = 64) -> int:
        # Orca / Raydium: price = 1.0001^tick
        tick = int(math.floor(math.log(price) / math.log(1.0001)))
        return tick - (tick % tick_spacing)

    def calculate_optimal_ticks(self, current_price: float, vk: float) -> Tuple[int, int]:
        """
        Dynamically adjusts tick range width proportionally to kinetic volatility.
        Tight ranges during low kinetic drag, expanded ranges during high acceleration.
        """
        base_width_bps = 200 # 2% base half-width
        dynamic_expansion = vk * 10000 # convert to bps
        total_half_width_bps = base_width_bps + (dynamic_expansion * 1.5)

        lower_price = current_price * (1.0 - (total_half_width_bps / 10000.0))
        upper_price = current_price * (1.0 + (total_half_width_bps / 10000.0))

        tick_lower = self.price_to_tick(lower_price)
        tick_upper = self.price_to_tick(upper_price)
        return tick_lower, tick_upper

    async def execute_rebalance(self, tick_lower: int, tick_upper: int, vk: float):
        logger.info(f"Triggering on-chain rebalance: lower={tick_lower}, upper={tick_upper}, Vk={vk:.6f}")

        # Instruction Discriminator for "rebalance" (sha256("global:rebalance")[:8])
        discriminator = bytes([0x9d, 0x8a, 0x54, 0x22, 0x11, 0xfe, 0x33, 0xaa]) # Illustrative 8-byte Anchor hash

        # Pack KineticProof: [i32 lower, i32 upper, u64 vk_scaled, u64 min_a, u64 min_b]
        vk_scaled = int(vk * 1_000_000)
        data = (
            discriminator +
            tick_lower.to_bytes(4, byteorder="little", signed=True) +
            tick_upper.to_bytes(4, byteorder="little", signed=True) +
            vk_scaled.to_bytes(8, byteorder="little", signed=False) +
            int(0).to_bytes(8, byteorder="little") + # min token a
            int(0).to_bytes(8, byteorder="little")   # min token b
        )

        accounts = [
            AccountMeta(pubkey=self.keeper.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(pubkey=self.vault_pubkey, is_signer=False, is_writable=True),
            # Token vaults and CLMM targets added here...
        ]

        ix = Instruction(
            program_id=self.program_id,
            accounts=accounts,
            data=data,
        )

        recent_blockhash = (await self.rpc_client.get_latest_blockhash()).value.blockhash
        msg = MessageV0.try_compile(
            payer=self.keeper.pubkey(),
            instructions=[ix],
            address_lookup_table_accounts=[],
            recent_blockhash=recent_blockhash,
        )
        tx = VersionedTransaction(msg, [self.keeper])
        
        try:
            sig = await self.rpc_client.send_transaction(tx)
            logger.info(f"Rebalance TX successfully dispatched: {sig.value}")
        except Exception as e:
            logger.error(f"Failed to submit rebalance TX: {str(e)}")

    async def run(self):
        logger.info("Kinetic Agent initialized. Listening for micro-ticks...")
        while True:
            # Synthetic streaming harness for testnet demonstration
            synthetic_price = 150.0 + (np.sin(time.time() / 10) * 2.0) + (np.random.normal(0, 0.3))
            self.update_price(synthetic_price)

            if len(self.price_history) >= 10:
                vk = self.estimator.compute_kinetic_metric(
                    np.array(self.price_history),
                    dt=1.0,
                    candles=self.candles
                )
                logger.debug(f"Current Price: {synthetic_price:.4f} | Kinetic Volatility: {vk:.6f}")

                if vk > self.vk_rebalance_threshold:
                    t_lower, t_upper = self.calculate_optimal_ticks(synthetic_price, vk)
                    await self.execute_rebalance(t_lower, t_upper, vk)
                    await asyncio.sleep(30) # Enforce local cooldown loop

            await asyncio.sleep(1.0)

if __name__ == "__main__":
    dummy_keypair = Keypair()
    agent = KineticRebalanceAgent(
        rpc_url="http://127.0.0.1:8899",
        program_id_str="Kinet1cReba1ance111111111111111111111111111",
        vault_pubkey_str="11111111111111111111111111111111",
        keeper_keypair=dummy_keypair,
    )
    asyncio.run(agent.run())