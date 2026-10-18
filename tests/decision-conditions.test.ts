import { describe, expect, it } from "vitest";
import { CONDITION_PROBABILITY_THRESHOLD, DECISION_CONDITIONS, deriveConditionScores } from "../src/shared/decision-conditions";

function conditions(value = false): Record<string, boolean> {
  return Object.fromEntries(DECISION_CONDITIONS.map(({ name }) => [name, value]));
}

function met(...names: string[]): Record<string, boolean> {
  return { ...conditions(), ...Object.fromEntries(names.map((name) => [name, true])) };
}

describe("Decisions qualification conditions", () => {
  it("defines exactly five ordered minimum gates for each independent axis", () => {
    expect(CONDITION_PROBABILITY_THRESHOLD).toBe(0.8);
    expect(DECISION_CONDITIONS.map(({ name }) => name)).toEqual(
      ["technical", "ux", "impact", "idea"].flatMap((key) => [2, 4, 6, 8, 10].map((level) => `${key}_level_${level}`))
    );
    expect(new Set(DECISION_CONDITIONS.map(({ name }) => name)).size).toBe(20);
  });

  it("awards 40 when every condition is supported and zero when none is supported", () => {
    const perfect = deriveConditionScores(conditions(true));
    expect(perfect).toEqual({ scores: { technical: 10, ux: 10, impact: 10, idea: 10 }, reviewRequired: false });
    expect(Object.values(perfect.scores).reduce((sum, score) => sum + score, 0)).toBe(40);
    expect(deriveConditionScores(conditions())).toEqual({ scores: { technical: 0, ux: 0, impact: 0, idea: 0 }, reviewRequired: false });
  });

  it("keeps each axis independent and preserves different supported levels", () => {
    const input = met(
      "technical_level_2", "technical_level_4", "technical_level_6",
      "ux_level_2", "ux_level_4", "ux_level_6", "ux_level_8", "ux_level_10",
      "impact_level_2",
      "idea_level_2", "idea_level_4", "idea_level_6", "idea_level_8"
    );
    expect(deriveConditionScores(input)).toEqual({ scores: { technical: 6, ux: 10, impact: 2, idea: 8 }, reviewRequired: false });
  });

  it("stops at the first missing prerequisite and flags later positive answers without promoting the score", () => {
    const input = met(
      "technical_level_2", "technical_level_4", "technical_level_8", "technical_level_10",
      "ux_level_10",
      "impact_level_2", "impact_level_4", "impact_level_6",
      "idea_level_2", "idea_level_4", "idea_level_6", "idea_level_8", "idea_level_10"
    );
    expect(deriveConditionScores(input)).toEqual({ scores: { technical: 4, ux: 0, impact: 6, idea: 10 }, reviewRequired: true });
  });

  it("does not require review for a supported prefix followed only by unmet conditions", () => {
    expect(deriveConditionScores(met("technical_level_2", "technical_level_4", "idea_level_2"))).toEqual({
      scores: { technical: 4, ux: 0, impact: 0, idea: 2 }, reviewRequired: false
    });
  });

  it("requires the exact known own keys and boolean values", () => {
    const missing = conditions();
    delete missing.technical_level_2;
    const substituted = { ...missing, unknown: false };
    expect(Object.keys(substituted)).toHaveLength(20);
    const inheritedOnly = Object.create(conditions(true));
    const inheritedMissing = Object.assign(Object.create({ technical_level_2: false }), missing);
    const nonEnumerableExtra = conditions();
    Object.defineProperty(nonEnumerableExtra, "unknown", { value: false });
    const invalid: unknown[] = [
      null, undefined, [], true, 20, "met", {}, missing, substituted,
      { ...conditions(), unknown: false },
      { ...conditions(), technical_level_2: "met" },
      { ...conditions(), technical_level_2: 1 },
      { ...conditions(), technical_level_2: null },
      inheritedOnly, inheritedMissing, nonEnumerableExtra,
      { ...conditions(), [Symbol("extra")]: false }
    ];
    for (const input of invalid) expect(() => deriveConditionScores(input as Record<string, boolean>)).toThrow(TypeError);
  });

  it("reads frozen input without changing its qualification evidence", () => {
    const input = Object.freeze(met("technical_level_2", "idea_level_8"));
    const before = JSON.stringify(input);
    expect(deriveConditionScores(input)).toEqual({ scores: { technical: 2, ux: 0, impact: 0, idea: 0 }, reviewRequired: true });
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(input)).toBe(true);
  });
});
