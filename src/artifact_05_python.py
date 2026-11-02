"""
Autonomous Kinetic Volatility Agent for Solana Concentrated Liquidity Pools.
Tracks high-frequency tick states, computes kinetic energy metrics,
and issues on-chain rebalancing instructions.
"""

import asyncio
import math
import os
import time
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta
from solders.transaction import VersionedTransaction
from solders.message import MessageV0
import struct

LAMPORTS_PER_SOL = 1_000_000_000
TICK_BASE = 1.0001


@dataclass
class MarketTickSample:
    timestamp: float
    slot: int
    price: float
    volume_depth: float


class KineticVolatilityModel:
    def __init__(self, sample_window: int = 30, lambda_damping: float = 0.45):
        self.sample_window = sample_window
        self.lambda_damping = lambda_damping
        self.history: List[MarketTickSample] = []

    def ingest_sample(self, sample: MarketTickSample):
        self.history.append(sample)
        if len(self.history) > self.sample_window:
            self.history.pop(0)

    def calculate_kinetic_parameters(self) -> Tuple[float, float, float]:
        """
        Calculates:
        1. Continuous Volatility (Garman-Klass approximation over price stream)
        2. Price Velocity (v = d(ln P) / dt)
        3. Kinetic Energy (E_k = 0.5 * Depth * v^2)
        """
        if len(self.history) < 5:
            return 0.0, 0.0, 0.0

        prices = np.array([s.price for s in self.history])
        timestamps = np.array([s.timestamp for s in self.history])
        depths = np.array([s.volume_depth for s in self.history])

        log_returns = np.diff(np.log(prices))
        dt = np.diff(timestamps)
        dt[dt == 0] = 0.001  # Guard against division by zero

        # Instantaneous velocity: d(ln P) / dt
        velocities = log_returns / dt
        current_velocity = float(velocities[-1])

        # Base realized volatility
        realized_vol = float(np.std(log_returns) * np.sqrt(31536000))  # Annualized

        # Effective pool mass (normalized liquidity depth)
        mean_depth = float(np.mean(depths))
        normalized_mass = max(mean_depth / 1_000_000.0, 0.1)

        # Kinetic Energy: E_k = 1/2 * m * v^2
        kinetic_energy = 0.5 * normalized_mass * (current_velocity ** 2)

        return realized_vol, current_velocity, kinetic_energy

    def compute_dynamic_tick_bounds(
        self, current_price: float, tick_spacing: int = 64
    ) -> Tuple[int, int, bool]:
        """
        Returns (new_tick_lower, new_tick_upper, should_rebalance)
        """
        realized_vol, velocity, kinetic_energy = self.calculate_kinetic_parameters()

        current_tick = int(math.floor(math.log(current_price) / math.log(TICK_BASE)))

        # Baseline spread in basis points proportional to volatility
        base_half_spread_bps = max(15.0, min(250.0, realized_vol * 100))

        # Kinetic asymmetric skew: Skew away from velocity direction to mitigate adverse selection
        # If velocity is positive (price surging up), shift range higher and widen upper bound
        velocity_skew_factor = velocity * 10.0
        kinetic_expansion = math.sqrt(kinetic_energy) * 50.0

        spread_lower_bps = base_half_spread_bps + kinetic_expansion - velocity_skew_factor
        spread_upper_bps = base_half_spread_bps + kinetic_expansion + velocity_skew_factor

        lower_price = current_price * (1.0 - (max(spread_lower_bps, 5.0) / 10_000.0))
        upper_price = current_price * (1.0 + (max(spread_upper_bps, 5.0) / 10_000.0))

        raw_tick_lower = int(math.floor(math.log(lower_price) / math.log(TICK_BASE)))
        raw_tick_upper = int(math.ceil(math.log(upper_price) / math.log(TICK_BASE)))

        # Snap to pool tick spacing
        aligned_tick_lower = (raw_tick_lower // tick_spacing) * tick_spacing
        aligned_tick_upper = (raw_tick_upper // tick_spacing) * tick_spacing

        if aligned_tick_lower >= aligned_tick_upper:
            aligned_tick_upper = aligned_tick_lower + tick_spacing

        # Determine if kinetic energy threshold warrants execution
        should_rebalance = kinetic_energy > 0.05 or abs(velocity) > 0.02

        return aligned_tick_lower, aligned_tick_upper, should_rebalance


class SolanaKineticKeeperAgent:
    def __init__(
        self,
        rpc_url: str,
        keeper_keypair: Keypair,
        program_id: Pubkey,
        token_a_mint: Pubkey,
        token_b_mint: Pubkey,
    ):
        self.client = AsyncClient(rpc_url, commitment=Confirmed)
        self.keeper = keeper_keypair
        self.program_id = program_id
        self.token_a_mint = token_a_mint
        self.token_b_mint = token_b_mint
        self.model = KineticVolatilityModel()

    def derive_strategy_pda(self) -> Tuple[Pubkey, int]:
        return Pubkey.find_program_address(
            [b"kinetic_position", bytes(self.token_a_mint), bytes(self.token_b_mint)],
            self.program_id,
        )

    def derive_vault_pda(self, label: bytes) -> Tuple[Pubkey, int]:
        return Pubkey.find_program_address(
            [b"kinetic_vault", bytes(self.token_a_mint), bytes(self.token_b_mint), label],
            self.program_id,
        )

    async def execute_rebalance(self, tick_lower: int, tick_upper: int, kinetic_proof: int):
        strategy_pda, _ = self.derive_strategy_pda()
        vault_a, _ = self.derive_vault_pda(b"token_a")
        vault_b, _ = self.derive_vault_pda(b"token_b")

        # Layout: instruction discriminator (8 bytes) + i32 + i32 + u64 + u64 + u64
        # Discriminator for execute_kinetic_rebalance
        discriminator = bytes([142, 82, 241, 107, 219, 17, 198, 203])
        data = (
            discriminator
            + struct.pack("<iiQQQ", tick_lower, tick_upper, kinetic_proof, 0, 0)
        )

        accounts = [
            AccountMeta(pubkey=self.keeper.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(pubkey=strategy_pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=vault_a, is_signer=False, is_writable=True),
            AccountMeta(pubkey=vault_b, is_signer=False, is_writable=True),
            AccountMeta(pubkey=Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), is_signer=False, is_writable=False),
        ]

        ix = Instruction(self.program_id, data, accounts)
        latest_blockhash_resp = await self.client.get_latest_blockhash()
        recent_blockhash = latest_blockhash_resp.value.blockhash

        msg = MessageV0.try_compile(
            payer=self.keeper.pubkey(),
            instructions=[ix],
            address_lookup_table_accounts=[],
            recent_blockhash=recent_blockhash,
        )

        tx = VersionedTransaction(msg, [self.keeper])

        print(f"[EXECUTOR] Dispatching Kinetic Rebalance: [{tick_lower} <-> {tick_upper}]")
        tx_sig = await self.client.send_transaction(tx)
        print(f"[CONFIRMED] Signature: {tx_sig.value}")

    async def run_telemetry_loop(self):
        print(f"[*] Starting Kinetic Keeper Agent for Program: {self.program_id}")
        simulated_price = 150.0  # e.g., SOL/USDC

        while True:
            try:
                # In production, stream live slots via Geyser gRPC
                current_slot_resp = await self.client.get_slot()
                current_slot = current_slot_resp.value

                # Inject dynamic drift for simulation
                shock = float(np.random.normal(0, 0.35))
                simulated_price = max(1.0, simulated_price + shock)
                simulated_depth = 5_000_000.0 + np.random.uniform(-500_000, 500_000)

                sample = MarketTickSample(
                    timestamp=time.time(),
                    slot=current_slot,
                    price=simulated_price,
                    volume_depth=simulated_depth,
                )
                self.model.ingest_sample(sample)

                lower, upper, trigger = self.model.compute_dynamic_tick_bounds(simulated_price)
                _, vel, ke = self.model.calculate_kinetic_parameters()

                print(
                    f"[SLOT {current_slot}] Price: {simulated_price:.4f} | "
                    f"Velocity: {vel:+.4f} | Energy: {ke:.6f} | "
                    f"Suggested Ticks: [{lower}, {upper}] | Trigger: {trigger}"
                )

                if trigger:
                    kinetic_proof_int = int(ke * 1_000_000) + 1
                    await self.execute_rebalance(lower, upper, kinetic_proof_int)
                    # Enforce agent local cooldown window
                    await asyncio.sleep(4.0)

                await asyncio.sleep(0.4)  # ~400ms Solana slot target
            except Exception as e:
                print(f"[ERROR] Agent loop encounter: {str(e)}")
                await asyncio.sleep(1.0)


if __name__ == "__main__":
    # Keypair stub for runtime integration test
    test_keeper = Keypair()
    prog_id = Pubkey.from_string("Kinet1cReba1ance111111111111111111111111111")
    dummy_mint_a = Pubkey.from_string("So11111111111111111111111111111111111111112")
    dummy_mint_b = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")

    agent = SolanaKineticKeeperAgent(
        rpc_url="http://127.0.0.1:8899",
        keeper_keypair=test_keeper,
        program_id=prog_id,
        token_a_mint=dummy_mint_a,
        token_b_mint=dummy_mint_b,
    )
    asyncio.run(agent.run_telemetry_loop())