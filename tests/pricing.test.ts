import { describe, expect, it } from "vitest";
import { calculateUsageCost, quoteReservation } from "../src/shared/pricing";
import type { BudgetUsage } from "../src/shared/types";

function usage(overrides: Partial<BudgetUsage> = {}) {
  return { kind: "responses" as const, model: "gpt-6.1-sol", inputTokens: 1000, outputTokens: 50, cachedInputTokens: 200, cacheWriteInputTokens: 100, ...overrides };
}

describe("shared pricing", () => {
  it("prices separate uncached, cached, write, and output categories exactly", () => {
    expect(calculateUsageCost(usage())).toBe(0.00217);
    expect(calculateUsageCost(usage({ inputTokens: 1000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 1000 }))).toBe(0.0025);
    expect(calculateUsageCost(usage({ inputTokens: 1000, outputTokens: 0, cachedInputTokens: 1000, cacheWriteInputTokens: 0 }))).toBe(0.0001);
    expect(calculateUsageCost(usage({ inputTokens: 0, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0 }))).toBe(0.00001);
    expect(calculateUsageCost(usage({ inputTokens: 1, outputTokens: 0, cachedInputTokens: 1, cacheWriteInputTokens: 0 }))).toBe(0.000001);
  });

  it("uses the strict long-input boundary for actual usage and reservation bounds", () => {
    for (const [tokens, cost, reserved] of [[272000, 0.544, 0.68], [272001, 1.088004, 1.360005]] as const) {
      expect(calculateUsageCost(usage({ inputTokens: tokens, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 }))).toBe(cost);
      expect(quoteReservation({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: tokens, maxOutputTokens: 0 })).toBe(reserved);
    }
    expect(calculateUsageCost(usage({ inputTokens: 272001, outputTokens: 100, cachedInputTokens: 1000, cacheWriteInputTokens: 1000 }))).toBe(1.086704);
    expect(quoteReservation({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 272001, maxOutputTokens: 100 })).toBe(1.361505);
  });

  it("charges Decisions for all input including cache reads without a rebate", () => {
    for (const [tokens, cost] of [[272000, 0.0272], [272001, 0.054401], [922000, 0.1844]] as const) {
      expect(calculateUsageCost(usage({ kind: "decisions", model: "gpt-6-luna", inputTokens: tokens, outputTokens: 0, cachedInputTokens: tokens, cacheWriteInputTokens: 0 }))).toBe(cost);
      expect(quoteReservation({ kind: "decisions", model: "gpt-6-luna", maxInputTokens: tokens, maxOutputTokens: 0 })).toBe(cost);
    }
  });

  it("allows the inclusive 922000 input and 1050000 context limits", () => {
    expect(quoteReservation({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 922000, maxOutputTokens: 128000 })).toBe(6.53);
    expect(calculateUsageCost(usage({ inputTokens: 922000, outputTokens: 128000, cachedInputTokens: 0, cacheWriteInputTokens: 0 }))).toBe(5.608);
    expect(quoteReservation({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 1000, maxOutputTokens: 0 })).toBe(0.0025);
    expect(calculateUsageCost(usage({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 }))).toBe(0);
  });

  it.each([
    { model: "other" }, { kind: "decisions", model: "gpt-6.1-sol" }, { model: "gpt-6-luna" },
    { inputTokens: -1 }, { inputTokens: 1.5 }, { inputTokens: NaN }, { inputTokens: Infinity },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1 }, { inputTokens: 922001 }, { outputTokens: 128001 },
    { cachedInputTokens: -1 }, { cachedInputTokens: 0.5 }, { cachedInputTokens: Infinity },
    { cacheWriteInputTokens: -1 }, { cacheWriteInputTokens: 1.5 }, { cachedInputTokens: 1001 },
    { cachedInputTokens: 800, cacheWriteInputTokens: 201 },
    { kind: "decisions", model: "gpt-6-luna", outputTokens: 1, cacheWriteInputTokens: 0 },
    { kind: "decisions", model: "gpt-6-luna", outputTokens: 0, cacheWriteInputTokens: 1 }
  ] satisfies Partial<BudgetUsage>[])("rejects malformed usage %j", (overrides) => {
    expect(() => calculateUsageCost(usage(overrides))).toThrow();
  });

  it.each([-1, 0.5, NaN, Infinity, 922001, Number.MAX_SAFE_INTEGER + 1])("rejects malformed reservation input %s", (maxInputTokens) => {
    expect(() => quoteReservation({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens, maxOutputTokens: 0 })).toThrow();
  });

  it("never lets valid actual usage cost exceed its conservative reservation", () => {
    for (const actual of [1, 251000, 272000, 272001, 870293]) {
      const bound = Number((BigInt(actual) * 105n + 99n) / 100n + 8192n);
      const reserve = quoteReservation({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: bound, maxOutputTokens: 8192 });
      for (const cachedInputTokens of [0, Math.floor(actual / 2), actual]) {
        const cost = calculateUsageCost(usage({ inputTokens: actual, cachedInputTokens, cacheWriteInputTokens: actual - cachedInputTokens, outputTokens: 8192 }));
        expect(cost).toBeLessThanOrEqual(reserve);
      }
    }
  });
});
