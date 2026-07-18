import { describe, expect, it } from "vitest";
import { normalizeGitHubRepoUrl, validatePublicScoreResult } from "../src/shared/validation";

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
  it("accepts a valid scored result", () => {
    const result = validatePublicScoreResult({
      summary: "十分に実装されている",
      publicReason: "主要機能が確認できる",
      repoAssessment: "scored",
      pinnedSha: "a".repeat(40),
      total: 24,
      criteria: [
        { key: "technical", label: "技術的な実装", score: 6, reason: "ok", evidencePaths: ["src/index.ts"] },
        { key: "ux", label: "デザインとユーザー体験", score: 5, reason: "ok", evidencePaths: ["src/app.ts"] },
        { key: "impact", label: "潜在的なインパクト", score: 7, reason: "ok", evidencePaths: ["README.md"] },
        { key: "idea", label: "アイデアの質", score: 6, reason: "ok", evidencePaths: ["README.md"] }
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
        criteria: [
          { key: "technical", label: "技術的な実装", score: 6, reason: "ok", evidencePaths: ["a"] },
          { key: "ux", label: "デザインとユーザー体験", score: 5, reason: "ok", evidencePaths: ["b"] },
          { key: "impact", label: "潜在的なインパクト", score: 7, reason: "ok", evidencePaths: ["c"] },
          { key: "idea", label: "アイデアの質", score: 6, reason: "ok", evidencePaths: ["d"] }
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
        total: 1,
        criteria: [
          { key: "technical", label: "技術的な実装", score: 1, reason: "no", evidencePaths: [] },
          { key: "ux", label: "デザインとユーザー体験", score: 0, reason: "no", evidencePaths: [] },
          { key: "impact", label: "潜在的なインパクト", score: 0, reason: "no", evidencePaths: [] },
          { key: "idea", label: "アイデアの質", score: 0, reason: "no", evidencePaths: [] }
        ]
      })
    ).toThrow(/zero scores/);
  });
});
