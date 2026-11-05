export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export class KineticVolatilityEngine {
  private candles: Candle[] = [];
  private readonly maxWindow: number;
  private readonly baseTickWidth: number;

  constructor(maxWindow = 30, baseTickWidth = 120) {
    this.maxWindow = maxWindow;
    this.baseTickWidth = baseTickWidth;
  }

  public pushCandle(candle: Candle): void {
    this.candles.push(candle);
    if (this.candles.length > this.maxWindow) {
      this.candles.shift();
    }
  }

  /**
   * Garman-Klass Extreme-Value Volatility
   * sigma^2 = 0.5 * [ln(H/L)]^2 - (2*ln(2) - 1) * [ln(C/O)]^2
   */
  public computeGarmanKlass(): number {
    if (this.candles.length < 5) return 0.02; // Default baseline volatility (2%)

    let sum = 0;
    const factor = 2 * Math.log(2) - 1;

    for (const c of this.candles) {
      const hl = Math.log(c.high / Math.max(c.low, 1e-8));
      const co = Math.log(c.close / Math.max(c.open, 1e-8));
      sum += 0.5 * (hl * hl) - factor * (co * co);
    }

    const variance = sum / this.candles.length;
    return Math.sqrt(Math.max(variance, 0.00001));
  }

  /**
   * Calculates Kinetic Energy Ek = 1/2 * mass * velocity^2 + alpha * GarmanKlass
   * Mass is represented by normalized volume.
   */
  public calculateKineticEnergy(): { kineticEnergy: number; velocity: number; acceleration: number } {
    if (this.candles.length < 3) {
      return { kineticEnergy: 1000, velocity: 0, acceleration: 0 };
    }

    const n = this.candles.length;
    const cCurrent = this.candles[n - 1];
    const cPrev = this.candles[n - 2];
    const cAnte = this.candles[n - 3];

    const dt = (cCurrent.timestamp - cPrev.timestamp) / 1000 || 1;
    const vCurrent = (Math.log(cCurrent.close) - Math.log(cPrev.close)) / dt;
    const vPrev = (Math.log(cPrev.close) - Math.log(cAnte.close)) / dt;
    const acceleration = (vCurrent - vPrev) / dt;

    const mass = Math.max(cCurrent.volume / 10000, 1.0);
    const sigmaGk = this.computeGarmanKlass();

    // Kinetic Energy formula
    const kineticEnergy = 0.5 * mass * Math.pow(vCurrent * 10000, 2) + sigmaGk * 50000;

    return {
      kineticEnergy: Math.floor(kineticEnergy),
      velocity: vCurrent,
      acceleration,
    };
  }

  /**
   * Computes optimal dynamic tick width based on kinetic energy
   */
  public calculateDynamicTickBounds(currentTick: number): { tickLower: number; tickUpper: number; kineticEnergy: number } {
    const { kineticEnergy, velocity } = this.calculateKineticEnergy();

    // Scale tick band dynamically: Wider if volatility or momentum is aggressive
    let expansionMultiplier = 1.0;
    if (kineticEnergy > 50000) {
      expansionMultiplier = 2.5; // High Volatility Regime
    } else if (kineticEnergy > 20000) {
      expansionMultiplier = 1.7; // Medium Volatility
    } else {
      expansionMultiplier = 1.0; // Mean-Reversion Consolidation
    }

    const halfWidth = Math.floor((this.baseTickWidth * expansionMultiplier) / 2);
    
    // Shift the center towards velocity momentum drift
    const driftOffset = Math.floor(velocity * 500);

    const tickLower = currentTick - halfWidth + driftOffset;
    const tickUpper = currentTick + halfWidth + driftOffset;

    return {
      tickLower,
      tickUpper,
      kineticEnergy,
    };
  }
}