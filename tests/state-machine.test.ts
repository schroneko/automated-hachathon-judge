import { describe, expect, it } from "vitest";
import { buildZeroScoreResult } from "../src/shared/scoring";
import { claimJob, createInitialSnapshot, finalizeJob, getRanking, isRankingEligible, recoverProcessingJobs, submitJob } from "../src/worker/state-machine";

function now(offset = 0) {
  return new Date(Date.UTC(2026, 6, 17, 0, 0, offset)).toISOString();
}

const resolution = {
  assessment: "scored" as const,
  pinnedSha: "a".repeat(40),
  defaultBranch: "main",
  summary: "demo"
};

describe("state machine", () => {
  it("allows another submission from the same IP after one second", () => {
    const state = createInitialSnapshot();
    const first = submitJob(state, {
      repoUrl: "https://github.com/example/first",
      ipHash: "shared",
      callbackBaseUrl: "https://hackathon.nukoevi.app",
      nowIso: now(0),
      resolution
    });
    const blocked = submitJob(state, {
      repoUrl: "https://github.com/example/blocked",
      ipHash: "shared",
      callbackBaseUrl: "https://hackathon.nukoevi.app",
      nowIso: now(0),
      resolution
    });
    const allowed = submitJob(state, {
      repoUrl: "https://github.com/example/allowed",
      ipHash: "shared",
      callbackBaseUrl: "https://hackathon.nukoevi.app",
      nowIso: now(1),
      resolution
    });

    expect(first.ok).toBe(true);
    expect(blocked.ok).toBe(false);
    expect(allowed.ok).toBe(true);
  });

  it("requeues processing jobs after a runner restart", () => {
    const state = createInitialSnapshot();
    submitJob(state, {
      repoUrl: "https://github.com/example/interrupted",
      ipHash: "restart",
      callbackBaseUrl: "https://hackathon.nukoevi.app",
      nowIso: now(0),
      resolution
    });
    const interrupted = claimJob(state, "https://hackathon.nukoevi.app", now(1));

    expect(interrupted).toBeDefined();
    expect(recoverProcessingJobs(state, now(2))).toBe(1);
    expect(claimJob(state, "https://hackathon.nukoevi.app", now(3))?.submissionId).toBe(interrupted?.submissionId);
  });

  it("excludes configured owners from ranking", () => {
    expect(isRankingEligible("example/demo", ["organizer"])).toBe(true);
    expect(isRankingEligible("organizer/demo", ["organizer"])).toBe(false);
    expect(isRankingEligible("Organizer/demo", ["ORGANIZER"])).toBe(false);
  });

  it("sorts unranked repositories after ranked entries", () => {
    const state = createInitialSnapshot();
    submitJob(state, {
      repoUrl: "https://github.com/organizer/demo",
      ipHash: "owner",
      callbackBaseUrl: "https://hackathon.nukoevi.app",
      nowIso: now(0),
      resolution
    });
    submitJob(state, {
      repoUrl: "https://github.com/example/demo",
      ipHash: "participant",
      callbackBaseUrl: "https://hackathon.nukoevi.app",
      nowIso: now(0),
      resolution
    });

    for (let index = 1; index <= 2; index += 1) {
      const start = claimJob(state, "https://hackathon.nukoevi.app", now(index));
      const total = start!.repo.normalized.startsWith("organizer/") ? 10 : 1;
      const base = buildZeroScoreResult({
        summary: start!.repo.normalized,
        publicReason: "done",
        repoAssessment: "empty_repository",
        pinnedSha: "a".repeat(40)
      });
      finalizeJob(state, {
        submissionId: start!.submissionId,
        callbackToken: start!.callbackToken,
        bucket: start!.bucket,
        callbackBaseUrl: "https://hackathon.nukoevi.app",
        nowIso: now(index + 2),
        outcome: {
          kind: "completed",
          result: {
            ...base,
            criteria: base.criteria.map((item, criterionIndex) => ({
              ...item,
              score: criterionIndex === 0 ? total : 0
            })),
            total,
            repoAssessment: "scored"
          }
        }
      });
    }

    const ranking = getRanking(state, ["organizer"]);
    expect(ranking.map((item) => item.repo)).toEqual(["example/demo", "organizer/demo"]);
    expect(ranking.map((item) => item.ranked)).toEqual([true, false]);
  });

  it("uses only the latest completed result for ranking", () => {
    const state = createInitialSnapshot();
    const first = submitJob(state, {
      repoUrl: "https://github.com/example/demo",
      ipHash: "aaa",
      callbackBaseUrl: "https://hackathon.nukoevi.app",
      nowIso: now(0),
      resolution
    });
    const firstStart = claimJob(state, "https://hackathon.nukoevi.app", now(0));
    expect(first.ok).toBe(true);
    finalizeJob(state, {
      submissionId: firstStart!.submissionId,
      callbackToken: firstStart!.callbackToken,
      bucket: firstStart!.bucket,
      callbackBaseUrl: "https://hackathon.nukoevi.app",
      nowIso: now(1),
      outcome: {
        kind: "completed",
        result: {
          ...buildZeroScoreResult({
            summary: "old",
            publicReason: "old",
            repoAssessment: "empty_repository",
            pinnedSha: "a".repeat(40)
          }),
          criteria: buildZeroScoreResult({
            summary: "old",
            publicReason: "old",
            repoAssessment: "empty_repository",
            pinnedSha: "a".repeat(40)
          }).criteria.map((item, index) => ({ ...item, score: index === 0 ? 4 : 0 })),
          total: 4,
          repoAssessment: "scored"
        }
      }
    });

    const second = submitJob(state, {
      repoUrl: "https://github.com/example/demo",
      ipHash: "bbb",
      callbackBaseUrl: "https://hackathon.nukoevi.app",
      nowIso: now(62),
      resolution
    });
    const secondStart = claimJob(state, "https://hackathon.nukoevi.app", now(62));
    finalizeJob(state, {
      submissionId: secondStart!.submissionId,
      callbackToken: secondStart!.callbackToken,
      bucket: secondStart!.bucket,
      callbackBaseUrl: "https://hackathon.nukoevi.app",
      nowIso: now(63),
      outcome: {
        kind: "completed",
        result: {
          ...buildZeroScoreResult({
            summary: "new",
            publicReason: "new",
            repoAssessment: "empty_repository",
            pinnedSha: "b".repeat(40)
          }),
          criteria: buildZeroScoreResult({
            summary: "new",
            publicReason: "new",
            repoAssessment: "empty_repository",
            pinnedSha: "b".repeat(40)
          }).criteria.map((item, index) => ({ ...item, score: index === 0 ? 8 : 0 })),
          total: 8,
          repoAssessment: "scored"
        }
      }
    });

    const ranking = getRanking(state);
    expect(ranking).toHaveLength(1);
    expect(ranking[0]?.total).toBe(8);
    expect(ranking[0]?.pinnedSha).toBe("b".repeat(40));
  });

  it("marks a failed attempt terminal without rescoring", () => {
    const state = createInitialSnapshot();
    const created = submitJob(state, {
      repoUrl: "https://github.com/example/retry",
      ipHash: "ccc",
      callbackBaseUrl: "https://hackathon.nukoevi.app",
      nowIso: now(0),
      resolution
    });
    expect(created.ok).toBe(true);
    const start = claimJob(state, "https://hackathon.nukoevi.app", now(0));
    const failed = finalizeJob(state, {
      submissionId: start!.submissionId,
      callbackToken: start!.callbackToken,
      bucket: start!.bucket,
      callbackBaseUrl: "https://hackathon.nukoevi.app",
      nowIso: now(1),
      outcome: {
        kind: "retryable_failure",
        message: "GitHub 503"
      }
    });
    expect(failed.submission?.status).toBe("failed");
    expect(claimJob(state, "https://hackathon.nukoevi.app", now(2))).toBeUndefined();
  });
});
