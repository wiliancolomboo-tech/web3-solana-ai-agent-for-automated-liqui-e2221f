export interface CandleStick {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: number;
}

export interface KineticAnalysis {
  instantaneousVelocity: number;
  parkinsonVariance: number;
  kineticEnergyScore: number;
  recommendedHalfWidthTicks: number;
  isBreached: boolean;
}

export class KineticEngine {
  private baseTickSpacing: number;
  private minHalfWidth: number;
  private maxHalfWidth: number;

  constructor(baseTickSpacing: number = 64, minHalfWidth: number = 256, maxHalfWidth: number = 2048) {
    this.baseTickSpacing = baseTickSpacing;
    this.minHalfWidth = minHalfWidth;
    this.maxHalfWidth = maxHalfWidth;
  }

  /**
   * Calculates Parkinson extreme value volatility:
   * sigma_p^2 = (1 / (4 * ln(2))) * sum(ln(High/Low)^2) / N
   */
  public calculateParkinsonVariance(candles: CandleStick[]): number {
    if (candles.length === 0) return 0;
    const factor = 1 / (4 * Math.log(2));
    let sumSquaredRatios = 0;

    for (const c of candles) {
      if (c.low > 0 && c.high >= c.low) {
        const ratio = Math.log(c.high / c.low);
        sumSquaredRatios += ratio * ratio;
      }
    }

    return (factor * sumSquaredRatios) / candles.length;
  }

  /**
   * Instantaneous Price Velocity: v = (ln(P_t) - ln(P_{t-1})) / delta_t
   */
  public calculateInstantaneousVelocity(candles: CandleStick[]): number {
    if (candles.length < 2) return 0;
    const latest = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const deltaT = Math.max(1, (latest.timestamp - prev.timestamp) / 1000);
    return Math.abs(Math.log(latest.close / prev.close)) / deltaT;
  }

  /**
   * Evaluates Kinetic State & derives dynamic tick half-width
   */
  public evaluate(
    candles: CandleStick[],
    currentTick: number,
    lowerTick: number,
    upperTick: number
  ): KineticAnalysis {
    const parkinsonVariance = this.calculateParkinsonVariance(candles);
    const velocity = this.calculateInstantaneousVelocity(candles);

    // E_k = 0.5 * (velocity * 10000)^2 + (parkinsonVariance * 1e8)
    const kineticScore = 0.5 * Math.pow(velocity * 10000, 2) + (parkinsonVariance * 1_000_000);

    // Dynamic width expansion: scalar increases bandwidth under turbulent kinetic conditions
    const expansionScalar = Math.min(3.0, Math.max(0.8, 1.0 + Math.log10(1 + kineticScore)));
    const targetHalfWidth = Math.round((this.baseTickSpacing * 16 * expansionScalar) / this.baseTickSpacing) * this.baseTickSpacing;

    const boundedHalfWidth = Math.min(this.maxHalfWidth, Math.max(this.minHalfWidth, targetHalfWidth));
    const isBreached = currentTick <= lowerTick || currentTick >= upperTick;

    return {
      instantaneousVelocity: velocity,
      parkinsonVariance,
      kineticEnergyScore: kineticScore,
      recommendedHalfWidthTicks: boundedHalfWidth,
      isBreached,
    };
  }
}