import { describe, expect, it } from "vitest";
import { validateAttackProbability, visibleAttackScore } from "../src/shared/attack-score";

describe("attack score visibility", () => {
  it("shows exactly 80 percent and hides 79.9 percent", () => {
    expect(visibleAttackScore(0.8)).toBe(80);
    expect(visibleAttackScore(0.799)).toBeNull();
    expect(visibleAttackScore(1)).toBe(100);
  });

  it("rejects non-finite and out-of-range probabilities", () => {
    for (const value of [NaN, Infinity, -0.01, 1.01]) {
      expect(() => validateAttackProbability(value)).toThrow();
    }
  });
});
