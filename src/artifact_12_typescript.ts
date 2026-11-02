import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { KineticVolatilityEngine, TickObservation } from './kinetic_engine';

export class AutonomousRebalancerDaemon {
  private engine: KineticVolatilityEngine;
  private connection: Connection;
  private program: Program;
  private poolPubkey: PublicKey;
  private configPda: PublicKey;
  private positionPda: PublicKey;
  private isProcessing: boolean = false;

  constructor(
    connection: Connection,
    program: Program,
    poolPubkey: PublicKey,
    configPda: PublicKey,
    positionPda: PublicKey
  ) {
    this.engine = new KineticVolatilityEngine();
    this.connection = connection;
    this.program = program;
    this.poolPubkey = poolPubkey;
    this.configPda = configPda;
    this.positionPda = positionPda;
  }

  public async onPriceTick(tick: number, price: number, liquidity: number) {
    const obs: TickObservation = {
      slot: await this.connection.getSlot(),
      timestamp: Date.now() / 1000,
      price,
      tick,
      liquidityDepth: liquidity,
    };

    this.engine.pushObservation(obs);
    await this.evaluateAndExecute();
  }

  private async evaluateAndExecute(): Promise<void> {
    if (this.isProcessing) return;

    const kinetic = this.engine.evaluateKineticState();
    if (!kinetic) return;

    console.log(`[Kinetic Monitor] Regime: ${kinetic.regime} | Ek: ${kinetic.kineticEnergy} | v: ${kinetic.velocity.toFixed(3)} | a: ${kinetic.acceleration.toFixed(3)}`);

    // Regime safety: Suppress execution during high-energy chaotic bursts to prevent slippage/toxic flow
    if (kinetic.regime === 'CHAOTIC') {
      console.warn('[Guard Triggered] High kinetic energy detected! Skipping rebalance to avoid toxic flow.');
      return;
    }

    try {
      this.isProcessing = true;
      const positionAccount: any = await this.program.account.positionState.fetch(this.positionPda);
      const now = Math.floor(Date.now() / 1000);
      const cooldown = 30; // 30-second cooldown

      if (now - positionAccount.lastRebalanceTimestamp.toNumber() < cooldown) {
        return;
      }

      // Check if current position ticks match optimal range
      if (
        positionAccount.tickLowerIndex === kinetic.recommendedLowerTick &&
        positionAccount.tickUpperIndex === kinetic.recommendedUpperTick
      ) {
        return;
      }

      console.log(`[Rebalance Target] Relocating to: [${kinetic.recommendedLowerTick}, ${kinetic.recommendedUpperTick}]`);

      const tx = await this.program.methods
        .rebalancePosition(
          kinetic.recommendedLowerTick,
          kinetic.recommendedUpperTick,
          new anchor.BN(kinetic.kineticEnergy)
        )
        .accounts({
          keeper: this.program.provider.publicKey,
          config: this.configPda,
          position: this.positionPda,
          pythPriceFeed: (await this.program.account.vaultConfig.fetch(this.configPda)).pythPriceFeed,
        })
        .rpc();

      console.log(`[Rebalance Confirmed] Transaction Signature: ${tx}`);
    } catch (err) {
      console.error('[Execution Error]', err);
    } finally {
      this.isProcessing = false;
    }
  }
}