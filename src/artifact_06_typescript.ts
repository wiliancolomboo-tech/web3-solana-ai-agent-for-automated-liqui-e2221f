export interface PriceSample {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KineticMetrics {
  velocity: number;            // First derivative of price dp/dt
  acceleration: number;        // Second derivative of price d^2p/dt^2
  garmanKlassVol: number;      // High/Low variance estimator
  kineticEnergy: number;       // 1/2 * mass * velocity^2
  recommendedTickLower: i32;
  recommendedTickUpper: i32;
  shouldRebalance: boolean;
}

export type i32 = number;

export class KineticEngine {
  private history: PriceSample[] = [];
  private readonly maxSamples: number;
  private readonly tickSpacing: number;

  constructor(maxSamples: number = 60, tickSpacing: number = 64) {
    this.maxSamples = maxSamples;
    this.tickSpacing = tickSpacing;
  }

  public ingestPrice(sample: PriceSample): void {
    this.history.push(sample);
    if (this.history.length > this.maxSamples) {
      this.history.shift();
    }
  }

  /**
   * Calculates Garman-Klass Volatility:
   * σ_GK = sqrt( (1 / 2N) * Σ (ln(H/L))^2 - (2ln2 - 1) * Σ (ln(C/O))^2 )
   */
  public computeGarmanKlass(): number {
    const n = this.history.length;
    if (n < 5) return 0.0;

    let hlSum = 0;
    let coSum = 0;

    for (const s of this.history) {
      const hl = Math.log(s.high / Math.max(s.low, 1e-8));
      const co = Math.log(s.close / Math.max(s.open, 1e-8));
      hlSum += 0.5 * Math.pow(hl, 2);
      coSum += (2 * Math.LN2 - 1) * Math.pow(co, 2);
    }

    const variance = (hlSum - coSum) / n;
    return Math.sqrt(Math.max(variance, 0.0));
  }

  /**
   * Evaluates Kinetic Momentum (Velocity & Acceleration)
   */
  public evaluate(currentTickLower: number, currentTickUpper: number): KineticMetrics {
    const n = this.history.length;
    if (n < 5) {
      return {
        velocity: 0,
        acceleration: 0,
        garmanKlassVol: 0,
        kineticEnergy: 0,
        recommendedTickLower: currentTickLower,
        recommendedTickUpper: currentTickUpper,
        shouldRebalance: false,
      };
    }

    const latest = this.history[n - 1];
    const prev = this.history[n - 2];
    const prev2 = this.history[n - 3];

    const dt1 = Math.max((latest.timestamp - prev.timestamp) / 1000, 1);
    const dt2 = Math.max((prev.timestamp - prev2.timestamp) / 1000, 1);

    const v1 = (latest.close - prev.close) / dt1;
    const v0 = (prev.close - prev2.close) / dt2;
    const acceleration = (v1 - v0) / dt1;
    const velocity = v1;

    // Mass normalized by recent trade volume
    const mass = Math.log(Math.max(latest.volume, 1.0));
    const kineticEnergy = 0.5 * mass * Math.pow(velocity, 2);
    const gkVol = this.computeGarmanKlass();

    // Map spot price to tick
    const currentTick = this.priceToTick(latest.close);

    // Compute dynamic width based on GK-volatility and Kinetic Energy dampener
    const baseSpanTicks = Math.max(
      Math.floor((gkVol * 10000) / this.tickSpacing) * this.tickSpacing,
      this.tickSpacing * 10
    );

    // Asymmetric skew: if positive velocity, skew range forward
    const skewOffsetTicks = Math.floor((velocity / (latest.close * 0.001)) * this.tickSpacing);

    let rawLower = currentTick - baseSpanTicks + skewOffsetTicks;
    let rawUpper = currentTick + baseSpanTicks + skewOffsetTicks;

    // Snap to tick spacing
    const snappedLower = Math.floor(rawLower / this.tickSpacing) * this.tickSpacing;
    const snappedUpper = Math.ceil(rawUpper / this.tickSpacing) * this.tickSpacing;

    // Rebalance trigger: spot price breached 85% of existing bounds
    const span = currentTickUpper - currentTickLower;
    const buffer = span * 0.15;
    const isOutofBounds =
      currentTick <= currentTickLower + buffer || currentTick >= currentTickUpper - buffer;

    // Dampener check: do NOT rebalance if kinetic energy is bursting (flash crash),
    // wait for shockwave dissipation unless hard boundary breached
    const isShockwave = kineticEnergy > 500 && Math.abs(acceleration) > 2.0;
    const shouldRebalance = isOutofBounds && !isShockwave;

    return {
      velocity,
      acceleration,
      garmanKlassVol: gkVol,
      kineticEnergy,
      recommendedTickLower: snappedLower,
      recommendedTickUpper: snappedUpper,
      shouldRebalance,
    };
  }

  public priceToTick(price: number): number {
    return Math.floor(Math.log(price) / Math.log(1.0001));
  }
}