import { describe, expect, it } from "vitest";
import { explanationModelResultSchema, explanationOutputSchema, implementationEligibility, normalizeGitHubRepoUrl, parseScoringCallbackBody, prepareFullSourceSnapshot, validatePublicScoreResult } from "../src/shared/validation";
import { MAX_EVIDENCE_FILES, MAX_EVIDENCE_FILE_BYTES, MAX_EVIDENCE_TOTAL_BYTES, MAX_SNAPSHOT_SERIALIZED_BYTES } from "../src/shared/constants";
import type { RepoEvidenceSnapshot } from "../src/shared/types";
import { createHash } from "node:crypto";
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

  it("accepts a deep source path within the snapshot path capacity", () => {
    const path = `${"nested/".repeat(80)}main.ts`;
    const result = valid();
    result.criteria[0].evidencePaths = [path];
    expect(validatePublicScoreResult(result, new Set([path, "src/main.ts"])).criteria[0]?.evidencePaths).toEqual([path]);
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
    for (const field of ["attackScore", "attackProbability", "usage", "eligibility"]) {
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

  it("keeps historical rows readable and requires any new full-source metadata as one complete group", () => {
    const usage = {
      model: "gpt-6-luna", effort: "medium", decisionsModel: "gpt-6-luna", inputTokens: 100, outputTokens: 0, costUsd: 0.00001,
      decisionsScores: { technical: 6, ux: 6, impact: 6, idea: 6 }, requestIds: ["paid-id"]
    };
    expect(validatePublicScoreResult({ ...valid(), usage }).usage?.sourceHash).toBeUndefined();
    const metadata = { fullSource: true, sourceFiles: 1, sourceBytes: 0, sourceHash: "a".repeat(64) };
    expect(validatePublicScoreResult({ ...valid(), eligibility: "eligible", usage: { ...usage, ...metadata } })).toMatchObject({ eligibility: "eligible", usage: metadata });
    for (const field of Object.keys(metadata)) {
      expect(() => validatePublicScoreResult({ ...valid(), usage: { ...usage, ...metadata, [field]: undefined } })).toThrow();
    }
    for (const malformed of [{ fullSource: false }, { sourceFiles: -1 }, { sourceBytes: MAX_EVIDENCE_TOTAL_BYTES + 1 }, { sourceHash: "invalid" }]) {
      expect(() => validatePublicScoreResult({ ...valid(), usage: { ...usage, ...metadata, ...malformed } })).toThrow();
    }
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

function sourceFile(path: string, content = "") {
  return { path, content, size: new TextEncoder().encode(content).length, truncated: false };
}

function fullSnapshot(files = [sourceFile("src/main.ts", "export const main = 1;")]): RepoEvidenceSnapshot {
  return {
    repo: normalizeGitHubRepoUrl("https://github.com/demo/project"),
    assessment: "scored", pinnedSha: "a".repeat(40), defaultBranch: "main", summary: "source",
    files, fullSource: true
  };
}

describe("prepareFullSourceSnapshot", () => {
  it("canonicalizes only whitelisted fields and hashes the entire stable serialization", async () => {
    const source = fullSnapshot([sourceFile("z.unknown", "あ\n\"tail\""), sourceFile("a.txt")]);
    const prepared = await prepareFullSourceSnapshot(source);
    const reordered = { fullSource: true as const, files: [...source.files].reverse(), summary: source.summary,
      pinnedSha: source.pinnedSha, defaultBranch: source.defaultBranch, assessment: source.assessment,
      repo: { canonicalUrl: source.repo.canonicalUrl, normalized: source.repo.normalized, repo: source.repo.repo, owner: source.repo.owner, ignored: "untrusted" },
      ignored: "untrusted" };
    expect(await prepareFullSourceSnapshot(reordered)).toEqual(prepared);
    expect(JSON.parse(prepared.serialized)).toEqual({ ...source, files: [...source.files].reverse() });
    expect(prepared.metadata).toEqual({ fullSource: true, sourceFiles: 2, sourceBytes: 10, sourceHash: createHash("sha256").update(prepared.serialized).digest("hex") });
    for (const variant of [
      { ...source, summary: "different" }, { ...source, pinnedSha: "b".repeat(40) },
      { ...source, files: [sourceFile("z.unknown", "あ\n\"TAIL\""), sourceFile("a.txt")] }
    ]) expect((await prepareFullSourceSnapshot(variant)).metadata.sourceHash).not.toBe(prepared.metadata.sourceHash);
    expect(source.files[0]?.path).toBe("z.unknown");
  });

  it("includes empty UTF-8 files and accepts inclusive file and byte capacities", async () => {
    const files = Array.from({ length: MAX_EVIDENCE_FILES }, (_, index) => sourceFile(`${index}.txt`));
    expect((await prepareFullSourceSnapshot(fullSnapshot(files))).metadata).toMatchObject({ sourceFiles: 2000, sourceBytes: 0 });
    const content = "a".repeat(MAX_EVIDENCE_FILE_BYTES);
    expect((await prepareFullSourceSnapshot(fullSnapshot([sourceFile("large.ts", content)]))).metadata.sourceBytes).toBe(MAX_EVIDENCE_TOTAL_BYTES);
    await expect(prepareFullSourceSnapshot(fullSnapshot([]))).rejects.toThrow(/at least one source file/);
  });

  it("normalizes a zero assessment without the full-source marker", async () => {
    const source = { ...fullSnapshot([]), assessment: "missing_or_private" as const, pinnedSha: null, defaultBranch: null };
    delete source.fullSource;
    const prepared = await prepareFullSourceSnapshot(source);
    expect(JSON.parse(prepared.serialized).fullSource).toBe(true);
    expect(prepared.metadata).toMatchObject({ fullSource: true, sourceFiles: 0, sourceBytes: 0 });
  });

  it.each(["/absolute.ts", "../escape.ts", "src/../escape.ts", "./main.ts", "a//b.ts", "C:\\main.ts", "a\\b.ts", "a\0b.ts", "a\nb.ts", "a\u202eb.ts", "a/", "a./b.ts", "con.ts"])("rejects unsafe path %j", async (path) => {
    await expect(prepareFullSourceSnapshot(fullSnapshot([sourceFile(path, "x")]))).rejects.toThrow(/path/);
  });

  it("rejects partial, malformed, duplicate, and noncanonical snapshots", async () => {
    const source = fullSnapshot();
    for (const invalid of [
      { ...source, fullSource: undefined },
      { ...source, files: [{ ...source.files[0]!, truncated: true }] },
      { ...source, files: [{ ...source.files[0]!, size: -1 }] },
      { ...source, files: [sourceFile("main.ts", "\ud800")] },
      { ...source, files: [sourceFile("main.ts", "a\0b")] },
      { ...source, files: [sourceFile("same.ts"), sourceFile("same.ts")] },
      { ...source, repo: { ...source.repo, canonicalUrl: "https://evil.test/demo/project" } },
      { ...source, repo: { ...source.repo, normalized: "other/repo" } },
      { ...source, pinnedSha: "main" }, { ...source, defaultBranch: "" },
      { ...source, assessment: "empty_repository" },
      { ...source, files: Array.from({ length: MAX_EVIDENCE_FILES + 1 }, (_, index) => sourceFile(`${index}.txt`)) },
      { ...source, files: [sourceFile("large.ts", "a".repeat(MAX_EVIDENCE_FILE_BYTES + 1))] },
      { ...source, files: [sourceFile("large.ts", "a".repeat(MAX_EVIDENCE_FILE_BYTES)), sourceFile("other.ts", "a")] }
    ]) await expect(prepareFullSourceSnapshot(invalid as RepoEvidenceSnapshot)).rejects.toThrow();
  });

  it("enforces the 4MiB serialized bound after JSON escaping", async () => {
    const source = fullSnapshot([sourceFile("escape.ts", "\n".repeat(MAX_SNAPSHOT_SERIALIZED_BYTES / 2))]);
    expect(source.files[0]!.size).toBeLessThan(MAX_EVIDENCE_TOTAL_BYTES);
    await expect(prepareFullSourceSnapshot(source)).rejects.toThrow(/serialized/);
  });
});

describe("implementationEligibility", () => {
  it.each([
    ["README.md", "```ts\nexport const app = 1\n```", "no_implementation"],
    ["README.ts", "export const app = 1", "no_implementation"],
    ["docs/demo.ts", "export const app = 1", "no_implementation"],
    ["config/main.py", "print(1)", "no_implementation"],
    ["settings/main.py", "print(1)", "no_implementation"],
    ["vite.config.ts", "export default {}", "no_implementation"],
    [".eslintrc.js", "module.exports = {}", "no_implementation"],
    [".storybook/main.ts", "export default {}", "no_implementation"],
    ["build.gradle.kts", "plugins {}", "no_implementation"],
    ["package.json", "{}", "no_implementation"],
    ["notes.txt", "print(1)", "no_implementation"],
    ["main.ts", "  \n", "no_implementation"],
    ["main.ts", "export const app = 1", "eligible"],
    ["index.html", "<main>Hello</main>", "eligible"],
    ["style.css", "body { color: red; }", "eligible"],
    ["tests/main.test.ts", "test('works', () => expect(1).toBe(1))", "eligible"],
    ["examples/main.py", "print(1)", "eligible"],
    ["bin/run", "#!/usr/bin/env bash\necho yes", "eligible"],
    ["bin/run", "#!/usr/bin/env bash\n# instructions", "no_implementation"],
    ["notebook.ipynb", JSON.stringify({ cells: [{ cell_type: "code", source: ["print(1)\n"] }] }), "eligible"],
    ["notebook.ipynb", JSON.stringify({ cells: [{ cell_type: "code", source: "print(1)" }] }), "eligible"],
    ["notebook.ipynb", JSON.stringify({ cells: [{ cell_type: "markdown", source: ["print(1)"] }] }), "no_implementation"],
    ["notebook.ipynb", JSON.stringify({ cells: [{ cell_type: "code", source: [" \n"] }] }), "no_implementation"],
    ["notebook.ipynb", "not JSON", "no_implementation"]
  ])("classifies %s without imposing semantic score rules", (path, content, eligibility) => {
    expect(implementationEligibility(fullSnapshot([sourceFile(path, content)]))).toBe(eligibility);
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
