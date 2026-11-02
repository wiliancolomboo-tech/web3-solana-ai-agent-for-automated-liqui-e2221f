import Decimal from "decimal.js";
import { KineticEngine } from "../math/kinetic_engine";
import { TickMathUtils } from "../math/ticks";

describe("TickMathUtils Verification", () => {
  it("should correctly compute tick indices from price with proper decimals", () => {
    const decimalsA = 9; // SOL
    const decimalsB = 6; // USDC
    const price = new Decimal(150.0);

    const tick = TickMathUtils.priceToTickIndex(price, decimalsA, decimalsB);
    const recoveredPrice = TickMathUtils.tickIndexToPrice(tick, decimalsA, decimalsB);

    expect(recoveredPrice.minus(price).abs().toNumber()).toBeLessThan(0.05);
  });

  it("should round down ticks accurately to spacing intervals", () => {
    const tickSpacing = 64;
    expect(TickMathUtils.alignTickToSpacing(129, tickSpacing)).toBe(128);
    expect(TickMathUtils.alignTickToSpacing(63, tickSpacing)).toBe(0);
    expect(TickMathUtils.alignTickToSpacing(-10, tickSpacing)).toBe(-64);
  });
});

describe("KineticEngine Math & Signal Execution", () => {
  let engine: KineticEngine;

  beforeEach(() => {
    engine = new KineticEngine(0.5, 1.0, 64, 9, 6);
  });

  it("should compute zero velocity on static price data", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      engine.recordTick({
        timestamp: now + i * 1000,
        price: new Decimal(100),
        volume: new Decimal(10000),
        high: new Decimal(100.5),
        low: new Decimal(99.5)
      });
    }

    const metrics = engine.calculateMetrics();
    expect(metrics.velocity).toBeCloseTo(0, 5);
    expect(metrics.kineticEnergy).toBeCloseTo(0, 5);
  });

  it("should calculate positive velocity and shift range bounds upward during acceleration", () => {
    const now = Date.now();
    const prices = [100, 102, 105, 110, 118];
    for (let i = 0; i < prices.length; i++) {
      engine.recordTick({
        timestamp: now + i * 1000,
        price: new Decimal(prices[i]),
        volume: new Decimal(50000 * (i + 1)),
        high: new Decimal(prices[i] * 1.01),
        low: new Decimal(prices[i] * 0.99)
      });
    }

    const metrics = engine.calculateMetrics();
    expect(metrics.velocity).toBeGreaterThan(0);
    expect(metrics.kineticEnergy).toBeGreaterThan(0);

    const range = engine.computeOptimalRange(new Decimal(118));
    expect(range.upperPrice.toNumber()).toBeGreaterThan(118);
    expect(range.lowerPrice.toNumber()).toBeLessThan(118);
    expect(range.upperTick).toBeGreaterThan(range.lowerTick);
  });

  it("should trigger rebalance when spot crosses safety boundary", () => {
    const currentLowerTick = -1000;
    const currentUpperTick = 1000;
    const extremePrice = new Decimal(250); // Far above current range

    const needsRebalance = engine.shouldRebalance(extremePrice, currentLowerTick, currentUpperTick, 0.1);
    expect(needsRebalance).toBe(true);
  });
});