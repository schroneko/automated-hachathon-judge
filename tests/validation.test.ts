import { describe, expect, it } from "vitest";
import { explanationModelResultSchema, explanationOutputSchema, normalizeGitHubRepoUrl, parseScoringCallbackBody, validatePublicScoreResult } from "../src/shared/validation";
import { SCORE_LEVELS } from "../src/shared/rubric";

describe("normalizeGitHubRepoUrl", () => {
  it("normalizes a standard GitHub repository URL", () => {
    expect(normalizeGitHubRepoUrl("https://github.com/OpenAI/Codex").normalized).toBe("openai/codex");
  });

  it("rejects non-repository GitHub URLs", () => {
    expect(() => normalizeGitHubRepoUrl("https://github.com/openai/codex/issues")).toThrow();
  });

  it("rejects non-https URLs", () => {
    expect(() => normalizeGitHubRepoUrl("http://github.com/openai/codex")).toThrow();
  });
});

describe("validatePublicScoreResult", () => {
  const valid = () => ({
    summary: "確認済み",
    publicReason: "根拠があります",
    repoAssessment: "scored",
    pinnedSha: "a".repeat(40),
    criteria: [
      { key: "technical", label: "新機能の活用", score: 6, reason: "確認", evidencePaths: ["src/main.ts"] },
      { key: "ux", label: "使いやすさ", score: 6, reason: "確認", evidencePaths: ["src/main.ts"] },
      { key: "impact", label: "有用性", score: 6, reason: "確認", evidencePaths: ["src/main.ts"] },
      { key: "idea", label: "独創性", score: 6, reason: "確認", evidencePaths: ["src/main.ts"] }
    ],
    total: 24,
    attackScore: null as number | null
  });

  it("enforces attack visibility from the optional probability", () => {
    expect(validatePublicScoreResult({ ...valid(), attackProbability: 0.799 }).attackScore).toBeNull();
    expect(() => validatePublicScoreResult({ ...valid(), attackProbability: 0.799, attackScore: 80 })).toThrow(/Attack score/);
    expect(validatePublicScoreResult({ ...valid(), attackProbability: 0.8, attackScore: 80 }).attackScore).toBe(80);
  });

  it("accepts only the six final score levels and keeps Decisions scores fractional", () => {
    for (const score of SCORE_LEVELS) {
      const result = valid();
      result.criteria[0].score = score;
      result.total = score + 18;
      expect(validatePublicScoreResult(result).criteria[0]?.score).toBe(score);
    }
    for (const score of [1, 3, 5, 7, 9]) {
      const result = valid();
      result.criteria[0].score = score;
      result.total = score + 18;
      expect(() => validatePublicScoreResult(result)).toThrow();
    }
    expect(explanationOutputSchema.properties.criteria.items.properties.score.enum).toEqual(SCORE_LEVELS);
    const result = valid();
    const usage = {
      model: "test-model", effort: "high", decisionsModel: "test-decisions-model",
      inputTokens: 1, outputTokens: 1, costUsd: 0,
      decisionsScores: { technical: 5.5, ux: 7.25, impact: 1.5, idea: 9.9 }, requestIds: []
    };
    expect(validatePublicScoreResult({ ...result, usage }).usage?.decisionsScores.technical).toBe(5.5);
  });

  it("requires a review flag in explanation output while preserving historical stored results", () => {
    const { attackScore, ...model } = valid();
    expect(attackScore).toBeNull();
    expect(validatePublicScoreResult(valid()).reviewRequired).toBeUndefined();
    expect(() => explanationModelResultSchema.parse(model)).toThrow();
    expect(explanationOutputSchema.required).toContain("reviewRequired");
    expect(explanationModelResultSchema.parse({ ...model, reviewRequired: true }).reviewRequired).toBe(true);
    for (const field of ["attackScore", "attackProbability", "usage"]) {
      expect(() => explanationModelResultSchema.parse({ ...model, reviewRequired: false, [field]: 0 })).toThrow();
    }
  });

  it("roundtrips staged explanation metadata through completed callbacks", () => {
    const result = { ...valid(), reviewRequired: true, usage: {
      model: "gpt-6-luna", effort: "medium", decisionsModel: "gpt-6-luna", explanationModel: "gpt-6.1-sol",
      inputTokens: 300, outputTokens: 50, costUsd: 0.000872,
      decisionsScores: { technical: 6, ux: 6, impact: 6, idea: 6 }, requestIds: ["decision-id", "explanation-id"]
    } };
    const parsed = parseScoringCallbackBody(JSON.stringify({ submissionId: "s", callbackToken: "t", outcome: { kind: "completed", result } }));
    expect(parsed.outcome).toEqual({ kind: "completed", result });
    expect(() => validatePublicScoreResult({ ...result, reviewRequired: "true" })).toThrow();
    expect(() => validatePublicScoreResult({ ...result, usage: { ...result.usage, explanationModel: "" } })).toThrow();
    expect(() => validatePublicScoreResult({ ...result, usage: { ...result.usage, requestIds: ["1", "2", "3"] } })).toThrow();
  });

  it("rejects malformed optional usage metadata in callbacks", () => {
    const result = { ...valid(), usage: {
      model: "gpt-6.1-sol", effort: "high", decisionsModel: "gpt-6-luna",
      inputTokens: 100, outputTokens: 20, costUsd: Number.POSITIVE_INFINITY,
      decisionsScores: { technical: 6, ux: 6, impact: 6, idea: 6 }, requestIds: []
    } };
    expect(() => parseScoringCallbackBody(JSON.stringify({ submissionId: "s", callbackToken: "t", outcome: { kind: "completed", result } }))).toThrow();
    expect(() => validatePublicScoreResult({ ...valid(), usage: { ...result.usage, costUsd: 0.1, decisionsScores: { technical: 6 } } })).toThrow(/Decisions scores/);
  });

  it("accepts a valid scored result", () => {
    const result = validatePublicScoreResult({
      summary: "十分に実装されている",
      publicReason: "主要機能が確認できる",
      repoAssessment: "scored",
      pinnedSha: "a".repeat(40),
      total: 24,
      attackScore: null,
      criteria: [
        { key: "technical", label: "新機能の活用", score: 6, reason: "ok", evidencePaths: ["src/index.ts"] },
        { key: "ux", label: "使いやすさ", score: 4, reason: "ok", evidencePaths: ["src/app.ts"] },
        { key: "impact", label: "有用性", score: 8, reason: "ok", evidencePaths: ["README.md"] },
        { key: "idea", label: "独創性", score: 6, reason: "ok", evidencePaths: ["README.md"] }
      ]
    });
    expect(result.total).toBe(24);
  });

  it("rejects a mismatched total", () => {
    expect(() =>
      validatePublicScoreResult({
        summary: "bad",
        publicReason: "bad",
        repoAssessment: "scored",
        pinnedSha: "a".repeat(40),
        total: 20,
        attackScore: null,
        criteria: [
          { key: "technical", label: "新機能の活用", score: 6, reason: "ok", evidencePaths: ["a"] },
          { key: "ux", label: "使いやすさ", score: 4, reason: "ok", evidencePaths: ["b"] },
          { key: "impact", label: "有用性", score: 8, reason: "ok", evidencePaths: ["c"] },
          { key: "idea", label: "独創性", score: 6, reason: "ok", evidencePaths: ["d"] }
        ]
      })
    ).toThrow(/Total score/);
  });

  it("rejects non-zero scores for missing repositories", () => {
    expect(() =>
      validatePublicScoreResult({
        summary: "missing",
        publicReason: "missing",
        repoAssessment: "missing_or_private",
        pinnedSha: null,
        total: 2,
        attackScore: null,
        criteria: [
          { key: "technical", label: "新機能の活用", score: 2, reason: "no", evidencePaths: [] },
          { key: "ux", label: "使いやすさ", score: 0, reason: "no", evidencePaths: [] },
          { key: "impact", label: "有用性", score: 0, reason: "no", evidencePaths: [] },
          { key: "idea", label: "独創性", score: 0, reason: "no", evidencePaths: [] }
        ]
      })
    ).toThrow(/zero scores/);
  });
});

describe("parseScoringCallbackBody", () => {
  it("applies semantic score validation to completed callbacks", () => {
    expect(() => parseScoringCallbackBody(JSON.stringify({
      submissionId: "submission-id",
      callbackToken: "callback-token",
      outcome: {
        kind: "completed",
        result: {
          summary: "bad",
          publicReason: "bad",
          repoAssessment: "scored",
          pinnedSha: "a".repeat(40),
          total: 1,
          attackScore: null,
          criteria: [
            { key: "technical", label: "新機能の活用", score: 0, reason: "no", evidencePaths: [] },
            { key: "ux", label: "使いやすさ", score: 0, reason: "no", evidencePaths: [] },
            { key: "impact", label: "有用性", score: 0, reason: "no", evidencePaths: [] },
            { key: "idea", label: "独創性", score: 0, reason: "no", evidencePaths: [] }
          ]
        }
      }
    }))).toThrow(/Total score/);
  });

  it("accepts the maximum configured evidence path payload", () => {
    const evidencePaths = Array.from({ length: 24 }, (_, index) =>
      `${String(index).padStart(2, "0")}-${"あ".repeat(297)}`
    );
    const body = JSON.stringify({
      submissionId: "submission-id",
      callbackToken: "callback-token",
      outcome: {
        kind: "completed",
        result: {
          summary: "empty",
          publicReason: "empty",
          repoAssessment: "empty_repository",
          pinnedSha: null,
          total: 0,
          attackScore: null,
          criteria: [
            { key: "technical", label: "新機能の活用", score: 0, reason: "no", evidencePaths },
            { key: "ux", label: "使いやすさ", score: 0, reason: "no", evidencePaths },
            { key: "impact", label: "有用性", score: 0, reason: "no", evidencePaths },
            { key: "idea", label: "独創性", score: 0, reason: "no", evidencePaths }
          ]
        }
      }
    });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(65_536);

    const parsed = parseScoringCallbackBody(body);

    expect(parsed.outcome.kind).toBe("completed");
  });
});
