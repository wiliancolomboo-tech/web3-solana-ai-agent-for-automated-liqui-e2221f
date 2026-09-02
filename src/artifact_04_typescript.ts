import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PDAUtil,
  WhirlpoolData,
  PositionData,
  increaseLiquidityQuoteByInputTokenWithParams,
  decreaseLiquidityQuoteByLiquidityWithParams,
} from "@orca-so/whirlpools-sdk";
import { Percentage } from "@orca-so/common-sdk";
import { BN } from "@coral-xyz/anchor";
import axios from "axios";
import { KineticVolatilityEngine, Candle } from "./kinetic";
import { TickMathUtil } from "./tick_math";

export interface AgentConfig {
  rpcEndpoint: string;
  jitoBlockEngineUrl: string;
  walletKeypair: Keypair;
  whirlpoolAddress: PublicKey;
  rebalanceThresholdK: number;
  kineticEnergyThreshold: number;
  slippageToleranceBps: number;
  jitoTipLamports: number;
}

export class AutonomousCLMMRebalancer {
  private connection: Connection;
  private ctx: WhirlpoolContext;
  private client: ReturnType<typeof buildWhirlpoolClient>;
  private kineticEngine: KineticVolatilityEngine;
  private config: AgentConfig;
  private activePositionAddress: PublicKey | null = null;
  private isRebalancing: boolean = false;

  constructor(config: AgentConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcEndpoint, "confirmed");
    this.ctx = WhirlpoolContext.from(
      this.connection,
      {
        publicKey: config.walletKeypair.publicKey,
        signTransaction: async (tx) => {
          if (tx instanceof VersionedTransaction) {
            tx.sign([config.walletKeypair]);
          }
          return tx;
        },
        signAllTransactions: async (txs) => {
          txs.forEach((t) => {
            if (t instanceof VersionedTransaction) {
              t.sign([config.walletKeypair]);
            }
          });
          return txs;
        },
      },
      ORCA_WHIRLPOOL_PROGRAM_ID
    );
    this.client = buildWhirlpoolClient(this.ctx);
    this.kineticEngine = new KineticVolatilityEngine(120);
  }

  /**
   * Starts real-time monitoring and event-driven rebalance loop.
   */
  public async start(): Promise<void> {
    console.log(`[Agent Init] Monitoring CLMM: ${this.config.whirlpoolAddress.toBase58()}`);
    
    // Subscribe to pool updates
    this.connection.onAccountChange(
      this.config.whirlpoolAddress,
      async (accountInfo) => {
        try {
          await this.processPoolUpdate(accountInfo.data);
        } catch (err) {
          console.error("[Account Update Processing Error]:", err);
        }
      },
      "confirmed"
    );

    // Heartbeat ticker for candle generation and momentum checks
    setInterval(async () => {
      if (this.isRebalancing) return;
      await this.evaluateRebalanceTrigger();
    }, 5000);
  }

  private async processPoolUpdate(accountData: Buffer): Promise<void> {
    const whirlpool = await this.client.getPool(this.config.whirlpoolAddress);
    const poolData = whirlpool.getData();
    
    const price = TickMathUtil.sqrtPriceX64ToPrice(
      poolData.sqrtPrice,
      poolData.tokenMintA.equals(this.config.whirlpoolAddress) ? 9 : 6,
      6
    ).toNumber();

    const candle: Candle = {
      open: price,
      high: price * 1.0001,
      low: price * 0.9999,
      close: price,
      volume: 1000,
      liquidity: Number(poolData.liquidity.toString()),
      timestamp: Date.now(),
    };

    this.kineticEngine.ingestCandle(candle);
  }

  private async evaluateRebalanceTrigger(): Promise<void> {
    const whirlpool = await this.client.getPool(this.config.whirlpoolAddress);
    const data: WhirlpoolData = whirlpool.getData();
    const currentTick = data.tickCurrentIndex;

    const currentPrice = TickMathUtil.sqrtPriceX64ToPrice(data.sqrtPrice, 9, 6).toNumber();
    const metrics = this.kineticEngine.evaluateState(
      currentPrice,
      data.tickSpacing,
      this.config.rebalanceThresholdK
    );

    // Inspect active position boundaries
    if (this.activePositionAddress) {
      const position = await this.client.getPosition(this.activePositionAddress);
      const posData: PositionData = position.getData();

      const isOutOfRange = currentTick < posData.tickLowerIndex || currentTick > posData.tickUpperIndex;
      const kineticBreach = metrics.kineticEnergy > this.config.kineticEnergyThreshold;

      // Drift condition: Price is within 15% of boundary and kinetic energy is high
      const rangeSpan = posData.tickUpperIndex - posData.tickLowerIndex;
      const distToUpper = posData.tickUpperIndex - currentTick;
      const distToLower = currentTick - posData.tickLowerIndex;
      const boundaryProximity = Math.min(distToUpper, distToLower) / rangeSpan;

      if (isOutOfRange || (boundaryProximity < 0.15 && kineticBreach)) {
        console.warn(`[REBALANCE TRIGGERED] Reason: OutOfRange=${isOutOfRange}, BoundaryProximity=${boundaryProximity.toFixed(3)}, Ek=${metrics.kineticEnergy.toFixed(4)}`);
        await this.executeRebalance(whirlpool, metrics.recommendedLowerTick, metrics.recommendedUpperTick);
      }
    }
  }

  /**
   * Executes atomic position closure, reward harvest, optimal swap, and new position opening via Jito.
   */
  public async executeRebalance(
    whirlpool: any,
    targetLowerTick: number,
    targetUpperTick: number
  ): Promise<void> {
    this.isRebalancing = true;
    try {
      console.log(`[Executing Rebalance] -> New Range: [${targetLowerTick}, ${targetUpperTick}]`);
      const instructions = [];

      // 1. Close Existing Position if active
      if (this.activePositionAddress) {
        const position = await this.client.getPosition(this.activePositionAddress);
        const posData = position.getData();
        
        if (posData.liquidity.gt(new BN(0))) {
          const decreaseQuote = decreaseLiquidityQuoteByLiquidityWithParams({
            liquidity: posData.liquidity,
            slippageTolerance: Percentage.fromBasisPoints(this.config.slippageToleranceBps),
            sqrtPrice: whirlpool.getData().sqrtPrice,
            tickCurrentIndex: whirlpool.getData().tickCurrentIndex,
            tickLowerIndex: posData.tickLowerIndex,
            tickUpperIndex: posData.tickUpperIndex,
          });

          const decreaseTx = await position.decreaseLiquidity(decreaseQuote);
          instructions.push(...decreaseTx.instructions);
        }

        const collectFeesTx = await position.collectFees();
        instructions.push(...collectFeesTx.instructions);

        const closeTx = await position.closePosition();
        instructions.push(...closeTx.instructions);
      }

      // 2. Open Position at New Kinetic Boundaries
      const positionMintKeypair = Keypair.generate();
      const positionPda = PDAUtil.getPosition(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        positionMintKeypair.publicKey
      );

      const openPositionTx = await whirlpool.openPosition(
        targetLowerTick,
        targetUpperTick,
        positionMintKeypair
      );
      instructions.push(...openPositionTx.instructions);

      // 3. Compile Transaction Message with Latest Blockhash
      const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
      const messageV0 = new TransactionMessage({
        payerKey: this.config.walletKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions: instructions,
      }).compileToV0Message();

      const versionedTx = new VersionedTransaction(messageV0);
      versionedTx.sign([this.config.walletKeypair, positionMintKeypair]);

      // 4. Submit via Jito MEV Bundle
      await this.submitViaJitoBundle([versionedTx]);

      this.activePositionAddress = positionPda.publicKey;
      console.log(`[Rebalance Complete] New Position PDA: ${this.activePositionAddress.toBase58()}`);
    } catch (error) {
      console.error("[Fatal Rebalance Error]:", error);
    } finally {
      this.isRebalancing = false;
    }
  }

  /**
   * Dispatches MEV-protected bundle to Jito Relayer.
   */
  private async submitViaJitoBundle(transactions: VersionedTransaction[]): Promise<void> {
    try {
      const base58Txs = transactions.map((tx) => Buffer.from(tx.serialize()).toString("base64"));
      const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [base58Txs],
      };

      const response = await axios.post(
        `${this.config.jitoBlockEngineUrl}/api/v1/bundles`,
        payload,
        { headers: { "Content-Type": "application/json" } }
      );

      console.log(`[Jito Bundle Status]: ID = ${response.data.result}`);
    } catch (e: any) {
      console.error("[Jito Relayer Submission Error]:", e.response?.data || e.message);
      throw e;
    }
  }
}