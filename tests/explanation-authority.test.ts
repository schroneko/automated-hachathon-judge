import { describe, expect, it, vi } from "vitest";
import { CRITERIA, EVENT_ID } from "../src/shared/constants";
import { CONDITION_PROBABILITY_THRESHOLD, DECISION_CONDITIONS } from "../src/shared/decision-conditions";
import type { PublicScoreResult, RepoEvidenceSnapshot } from "../src/shared/types";
import { implementationEligibility, prepareFullSourceSnapshot } from "../src/shared/validation";
import { completeExplanation } from "../src/worker/explanations";

async function fixture(historical = false) {
  const snapshot: RepoEvidenceSnapshot = {
    fullSource: true,
    repo: { owner: "example", repo: "app", normalized: "example/app", canonicalUrl: "https://github.com/example/app" },
    pinnedSha: "a".repeat(40),
    defaultBranch: "main",
    summary: "Pinned implementation",
    assessment: "scored",
    files: [
      { path: "README.md", content: "Application" },
      { path: "src/main.ts", content: "export const main = (value: string) => value.trim();" }
    ].map((file) => ({ ...file, size: new TextEncoder().encode(file.content).byteLength, truncated: false }))
  };
  const { metadata } = await prepareFullSourceSnapshot(snapshot);
  const fixed: PublicScoreResult = {
    summary: "Fixed score",
    publicReason: "Fixed evidence",
    repoAssessment: "scored",
    pinnedSha: snapshot.pinnedSha,
    eligibility: implementationEligibility(snapshot),
    criteria: CRITERIA.map(({ key, label }) => ({ key, label, score: 8, reason: "Source evidence", evidencePaths: ["src/main.ts"] })),
    total: 32,
    attackScore: null,
    attackProbability: 0.05,
    reviewRequired: false,
    usage: {
      ...metadata,
      model: "gpt-6-luna",
      decisionsModel: "gpt-6-luna",
      effort: "medium",
      inputTokens: 100,
      outputTokens: 0,
      costUsd: 0.00001,
      decisionsScores: Object.fromEntries(CRITERIA.map(({ key }) => [key, 8])),
      rubricVersion: historical ? "2026-10-18-v3" : "2026-10-18-v4",
      referenceVersion: "reference-original",
      requestIds: [],
      ...(historical ? {} : {
        conditionThreshold: CONDITION_PROBABILITY_THRESHOLD,
        decisionsConditions: Object.fromEntries(DECISION_CONDITIONS.map(({ name, level }) => [name, level <= 8])),
        decisionsConditionProbabilities: Object.fromEntries(DECISION_CONDITIONS.map(({ name, level }) => [name, level <= 8 ? 0.95 : 0.05]))
      })
    }
  };
  const row = {
    id: "submission-authority",
    callback_token: "callback-authority",
    attempts: 2,
    explanation_dispatches: 1,
    result_json: JSON.stringify(fixed),
    frozen_resolution_json: JSON.stringify({ pinnedSha: snapshot.pinnedSha, assessment: "scored" })
  } as Parameters<typeof completeExplanation>[0];
  const value: PublicScoreResult = {
    ...structuredClone(fixed),
    summary: "Explained score",
    publicReason: "Explanation from pinned evidence",
    criteria: fixed.criteria.map((item) => ({ ...item, reason: "Explained source evidence", evidencePaths: ["src/main.ts"] })),
    usage: { ...structuredClone(fixed.usage!), explanationModel: "gpt-6.1-sol" }
  };
  const run = vi.fn(async () => ({ success: true }));
  const bind = vi.fn((..._values: unknown[]) => ({ run }));
  const prepare = vi.fn((_sql: string) => ({ bind }));
  const env = { JUDGE_DB: { prepare } } as unknown as Env;
  return { snapshot, fixed, row, value, env, prepare, bind, run };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function rejectsBeforePersistence(test: Fixture, message: string) {
  await expect(completeExplanation(test.row, test.value, test.snapshot, test.env)).rejects.toThrow(message);
  expect(test.prepare).not.toHaveBeenCalled();
  expect(test.bind).not.toHaveBeenCalled();
  expect(test.run).not.toHaveBeenCalled();
}

async function persistsExplanation(test: Fixture) {
  await completeExplanation(test.row, test.value, test.snapshot, test.env);
  expect(test.prepare).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("SET result_json = ?"));
  expect(test.bind).toHaveBeenCalledExactlyOnceWith(
    expect.any(String), expect.any(String), expect.any(String), expect.any(String),
    test.row.id, EVENT_ID, test.row.callback_token, test.row.attempts, test.row.explanation_dispatches
  );
  expect(test.run).toHaveBeenCalledTimes(1);
  const values = test.bind.mock.calls[0]!;
  const persisted = JSON.parse(values[0] as string) as PublicScoreResult;
  expect(persisted).toEqual(test.value);
  expect(JSON.parse(values[3] as string)).toEqual({ kind: "completed", result: persisted });
  expect(persisted.usage).toMatchObject({
    ...test.fixed.usage,
    explanationModel: "gpt-6.1-sol"
  });
  expect(test.row.result_json).toBe(JSON.stringify(test.fixed));
  return persisted;
}

describe("completeExplanation persistence authority", () => {
  it("persists a valid current-v4 explanation with all fixed audit evidence", async () => {
    const test = await fixture();
    expect(test.fixed.usage!.explanationModel).toBeUndefined();
    const persisted = await persistsExplanation(test);
    expect(persisted.usage!.conditionThreshold).toBe(CONDITION_PROBABILITY_THRESHOLD);
    expect(persisted.usage!.decisionsConditions).toEqual(test.fixed.usage!.decisionsConditions);
    expect(persisted.usage!.decisionsConditionProbabilities).toEqual(test.fixed.usage!.decisionsConditionProbabilities);
    expect(Object.keys(persisted.usage!.decisionsConditions!)).toHaveLength(20);
  });

  it("rejects a changed v4 probability even when its boolean and scores stay unchanged", async () => {
    const test = await fixture();
    const name = DECISION_CONDITIONS[0].name;
    test.value.usage!.decisionsConditionProbabilities![name] = 0.85;
    expect(test.fixed.usage!.decisionsConditionProbabilities![name]).toBe(0.95);
    expect(test.value.usage!.decisionsConditions).toEqual(test.fixed.usage!.decisionsConditions);
    expect(test.value.criteria).toEqual(test.fixed.criteria.map((item) => ({ ...item, reason: "Explained source evidence" })));
    await rejectsBeforePersistence(test, "Explanation changed condition authority");
  });

  it("rejects stripping all condition audit fields while downgrading v4 to v3", async () => {
    const test = await fixture();
    delete test.value.usage!.conditionThreshold;
    delete test.value.usage!.decisionsConditions;
    delete test.value.usage!.decisionsConditionProbabilities;
    test.value.usage!.rubricVersion = "2026-10-18-v3";
    await rejectsBeforePersistence(test, "Explanation changed judging policy authority");
  });

  it("rejects a changed reference version", async () => {
    const test = await fixture();
    test.value.usage!.referenceVersion = "reference-replaced";
    await rejectsBeforePersistence(test, "Explanation changed judging policy authority");
  });

  it("rejects a tampered boolean against the unchanged probability through validation", async () => {
    const test = await fixture();
    test.value.usage!.decisionsConditions![DECISION_CONDITIONS[0].name] = false;
    expect(test.value.usage!.decisionsConditionProbabilities).toEqual(test.fixed.usage!.decisionsConditionProbabilities);
    await rejectsBeforePersistence(test, "Decisions conditions do not match recorded probabilities and threshold");
  });

  it("rejects a changed condition threshold before persistence", async () => {
    const test = await fixture();
    test.value.usage!.conditionThreshold = 0.7;
    await rejectsBeforePersistence(test, "conditionThreshold");
  });

  it("accepts reordered keys in both condition records and persists their unchanged contents", async () => {
    const test = await fixture();
    const usage = test.value.usage!;
    usage.decisionsConditions = Object.fromEntries(Object.entries(usage.decisionsConditions!).reverse());
    usage.decisionsConditionProbabilities = Object.fromEntries(Object.entries(usage.decisionsConditionProbabilities!).reverse());
    expect(Object.keys(usage.decisionsConditions)).not.toEqual(Object.keys(test.fixed.usage!.decisionsConditions!));
    expect(Object.keys(usage.decisionsConditionProbabilities)).not.toEqual(Object.keys(test.fixed.usage!.decisionsConditionProbabilities!));
    const persisted = await persistsExplanation(test);
    expect(persisted.usage!.decisionsConditions).toEqual(test.fixed.usage!.decisionsConditions);
    expect(persisted.usage!.decisionsConditionProbabilities).toEqual(test.fixed.usage!.decisionsConditionProbabilities);
    expect(persisted.usage!.conditionThreshold).toBe(test.fixed.usage!.conditionThreshold);
  });

  it("accepts historical v3 results when all three condition audit fields are absent on both sides", async () => {
    const test = await fixture(true);
    const persisted = await persistsExplanation(test);
    expect(persisted.usage!.rubricVersion).toBe("2026-10-18-v3");
    for (const key of ["conditionThreshold", "decisionsConditions", "decisionsConditionProbabilities"] as const) {
      expect(test.fixed.usage).not.toHaveProperty(key);
      expect(test.value.usage).not.toHaveProperty(key);
      expect(persisted.usage).not.toHaveProperty(key);
    }
  });
});
