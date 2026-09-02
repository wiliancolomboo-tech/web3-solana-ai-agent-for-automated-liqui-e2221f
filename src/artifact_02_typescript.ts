import { Decimal } from "decimal.js";

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  liquidity: number;
  timestamp: number;
}

export interface KineticMetrics {
  velocity: number;
  acceleration: number;
  garmanKlassVol: number;
  kineticEnergy: number;
  asymmetricFactor: number;
  recommendedLowerTick: number;
  recommendedUpperTick: number;
}

export class KineticVolatilityEngine {
  private candles: Candle[] = [];
  private readonly maxWindowSize: number;
  private readonly TICK_BASE = 1.0001;

  constructor(maxWindowSize: number = 60) {
    this.maxWindowSize = maxWindowSize;
  }

  public ingestCandle(candle: Candle): void {
    this.candles.push(candle);
    if (this.candles.length > this.maxWindowSize) {
      this.candles.shift();
    }
  }

  /**
   * Calculates Garman-Klass Volatility across the cached candle window.
   */
  public calculateGarmanKlass(): number {
    const n = this.candles.length;
    if (n < 2) return 0.005; // Fallback 0.5% base volatility

    let sum = 0;
    for (let i = 0; i < n; i++) {
      const c = this.candles[i];
      const logHL = Math.log(c.high / c.low);
      const logCO = Math.log(c.close / c.open);
      const term1 = 0.5 * Math.pow(logHL, 2);
      const term2 = (2 * Math.LN2 - 1) * Math.pow(logCO, 2);
      sum += (term1 - term2);
    }

    const variance = sum / n;
    return Math.sqrt(Math.max(variance, 1e-8));
  }

  /**
   * Computes price velocity (v) and acceleration (a).
   */
  public calculateKinematics(): { velocity: number; acceleration: number } {
    const n = this.candles.length;
    if (n < 3) return { velocity: 0, acceleration: 0 };

    const cCurrent = this.candles[n - 1];
    const cPrev = this.candles[n - 2];
    const cPrev2 = this.candles[n - 3];

    const dt1 = (cCurrent.timestamp - cPrev.timestamp) / 1000 || 1;
    const dt2 = (cPrev.timestamp - cPrev2.timestamp) / 1000 || 1;

    const vCurrent = (Math.log(cCurrent.close) - Math.log(cPrev.close)) / dt1;
    const vPrev = (Math.log(cPrev.close) - Math.log(cPrev2.close)) / dt2;

    const acceleration = (vCurrent - vPrev) / dt1;

    return { velocity: vCurrent, acceleration };
  }

  /**
   * Evaluates Kinetic State and derives optimal tick bounds.
   */
  public evaluateState(
    currentPrice: number,
    tickSpacing: number,
    kFactor: number = 2.0,
    timeHorizonSec: number = 3600
  ): KineticMetrics {
    const sigmaGk = this.calculateGarmanKlass();
    const { velocity, acceleration } = this.calculateKinematics();

    // Baseline liquidity mass approximation
    const n = this.candles.length;
    const avgLiquidity = n > 0 
      ? this.candles.reduce((acc, c) => acc + c.liquidity, 0) / n 
      : 1;
    const currentLiquidity = n > 0 ? this.candles[n - 1].liquidity : 1;
    const mass = avgLiquidity > 0 ? currentLiquidity / avgLiquidity : 1.0;

    // Kinetic Energy E_k = 0.5 * m * v^2 + lambda * |a|
    const lambda = 0.1;
    const kineticEnergy = 0.5 * mass * Math.pow(velocity * 1000, 2) + lambda * Math.abs(acceleration * 1000);

    // Asymmetric offset calculation based on drift velocity
    const volScaled = sigmaGk * Math.sqrt(timeHorizonSec / 60);
    const driftDrift = velocity * timeHorizonSec;

    const lowerOffset = Math.max(0.002, (kFactor * volScaled) * (1 + Math.max(0, -driftDrift)));
    const upperOffset = Math.max(0.002, (kFactor * volScaled) * (1 + Math.max(0, driftDrift)));

    const targetPriceLower = currentPrice * Math.exp(-lowerOffset);
    const targetPriceUpper = currentPrice * Math.exp(upperOffset);

    const rawLowerTick = Math.log(targetPriceLower) / Math.log(this.TICK_BASE);
    const rawUpperTick = Math.log(targetPriceUpper) / Math.log(this.TICK_BASE);

    // Snap to tick spacing
    const lowerTick = Math.floor(rawLowerTick / tickSpacing) * tickSpacing;
    const upperTick = Math.ceil(rawUpperTick / tickSpacing) * tickSpacing;

    return {
      velocity,
      acceleration,
      garmanKlassVol: sigmaGk,
      kineticEnergy,
      asymmetricFactor: upperOffset / lowerOffset,
      recommendedLowerTick: lowerTick,
      recommendedUpperTick: upperTick,
    };
  }
}