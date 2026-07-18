import { describe, expect, it } from "vitest";
import { zeroResultForAssessment } from "../src/container/github";

describe("zeroResultForAssessment", () => {
  it("scores empty repositories at zero across all criteria", () => {
    const result = zeroResultForAssessment({
      repo: {
        owner: "demo",
        repo: "empty",
        normalized: "demo/empty",
        canonicalUrl: "https://github.com/demo/empty"
      },
      pinnedSha: null,
      defaultBranch: null,
      summary: "空のリポジトリです。",
      assessment: "empty_repository",
      files: []
    });
    expect(result.total).toBe(0);
    expect(result.criteria.every((item) => item.score === 0)).toBe(true);
  });

  it("scores missing or private repositories at zero across all criteria", () => {
    const result = zeroResultForAssessment({
      repo: {
        owner: "demo",
        repo: "private",
        normalized: "demo/private",
        canonicalUrl: "https://github.com/demo/private"
      },
      pinnedSha: null,
      defaultBranch: null,
      summary: "見つからない",
      assessment: "missing_or_private",
      files: []
    });
    expect(result.total).toBe(0);
    expect(result.repoAssessment).toBe("missing_or_private");
  });
});
