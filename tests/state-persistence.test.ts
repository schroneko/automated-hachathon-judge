import { describe, expect, it, vi } from "vitest";
import { buildZeroScoreResult } from "../src/shared/scoring";
import type { AppStateSnapshot, SubmissionRecord, SubmissionStatus } from "../src/shared/types";
import { JudgeState } from "../src/worker/judge-state";
import { createInitialSnapshot } from "../src/worker/state-machine";
import { planStatePersistence, pruneExpiredCooldowns } from "../src/worker/state-persistence";

const nowIso = "2026-08-09T00:00:00.000Z";

describe("state persistence", () => {
  it("does not plan writes for equivalent snapshots", () => {
    const state = createInitialSnapshot();
    const plan = planStatePersistence(state, structuredClone(state));

    expect(plan.meta).toBeUndefined();
    expect(plan.jobsToPut).toEqual({});
    expect(plan.jobIdsToDelete).toEqual([]);
  });

  it("plans only metadata for a heartbeat", () => {
    const before = stateWithHistory(200);
    const after = structuredClone(before);
    after.runnerLastSeenAt = nowIso;
    const plan = planStatePersistence(before, after);

    expect(plan.meta?.runnerLastSeenAt).toBe(nowIso);
    expect(plan.jobsToPut).toEqual({});
    expect(plan.jobIdsToDelete).toEqual([]);
  });

  it.each([0, 50, 200])(
    "keeps a one-job update constant with %i historical jobs",
    (historySize) => {
      const before = stateWithHistory(historySize);
      before.jobs.target = makeJob("target", "queued");
      const after = structuredClone(before);
      after.jobs.target.status = "processing";
      after.jobs.target.updatedAt = nowIso;
      const plan = planStatePersistence(before, after);

      expect(Object.keys(plan.jobsToPut)).toEqual(["target"]);
      expect(plan.meta).toBeUndefined();
      expect(plan.jobIdsToDelete).toEqual([]);
    }
  );

  it("plans deletion only for removed jobs", () => {
    const before = createInitialSnapshot();
    before.jobs.removed = makeJob("removed", "failed");
    const after = structuredClone(before);
    delete after.jobs.removed;
    const plan = planStatePersistence(before, after);

    expect(plan.jobsToPut).toEqual({});
    expect(plan.meta).toBeUndefined();
    expect(plan.jobIdsToDelete).toEqual(["removed"]);
  });

  it("keeps a dropped recent job when another state index still references it", () => {
    const before = createInitialSnapshot();
    before.recentIds = ["active", "older"];
    before.repoInflight["example/active"] = "active";
    const after = structuredClone(before);
    after.recentIds = ["older"];

    const plan = planStatePersistence(before, after);

    expect(plan.jobIdsToDelete).toEqual([]);
  });

  it("does not infer job deletion from index changes", () => {
    const before = createInitialSnapshot();
    for (let index = 0; index < 25; index += 1) {
      before.recentIds.push(`old-${index}`);
    }
    const after = structuredClone(before);
    after.recentIds = [];

    const plan = planStatePersistence(before, after);

    expect(plan.jobIdsToDelete).toEqual([]);
  });

  it("prunes expired cooldown metadata without touching jobs", () => {
    const state = stateWithHistory(50);
    state.ipCooldowns.expired = "2026-08-08T00:00:00.000Z";
    state.ipCooldowns.future = "2026-08-10T00:00:00.000Z";
    state.ipCooldowns.invalid = "invalid";

    pruneExpiredCooldowns(state, nowIso);

    expect(state.ipCooldowns).toEqual({ future: "2026-08-10T00:00:00.000Z" });
    expect(Object.keys(state.jobs)).toHaveLength(50);
  });

  it("performs no storage mutation for empty claim and rejected finalize", async () => {
    const storage = fakeStorage(createInitialSnapshot());
    const object = new JudgeState({ storage } as any, {} as any);

    const claim = await object.fetch(
      new Request("https://state/claim", {
        method: "POST",
        body: JSON.stringify({ callbackBaseUrl: "https://example.com", nowIso })
      })
    );
    const finalize = await object.fetch(
      new Request("https://state/finalize", {
        method: "POST",
        body: JSON.stringify({
          submissionId: "missing",
          callbackToken: "invalid",
          bucket: 0,
          callbackBaseUrl: "https://example.com",
          nowIso,
          outcome: { kind: "failed", message: "failed" }
        })
      })
    );

    expect(claim.status).toBe(204);
    expect(finalize.status).toBe(409);
    expect(storage.list).not.toHaveBeenCalled();
    expect(storage.transaction).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("writes only metadata for a heartbeat with historical jobs", async () => {
    const storage = fakeStorage(stateWithHistory(200));
    const object = new JudgeState({ storage } as any, {} as any);

    const response = await object.fetch(
      new Request("https://state/heartbeat", {
        method: "POST",
        body: JSON.stringify({ nowIso })
      })
    );

    expect(response.status).toBe(200);
    expect(storage.list).not.toHaveBeenCalled();
    expect(storage.transaction).toHaveBeenCalledTimes(1);
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(storage.put.mock.calls[0]?.[0]).toBe("meta");
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("writes only the claimed job and metadata with historical jobs", async () => {
    const state = stateWithHistory(200);
    state.jobs.target = makeJob("target", "queued");
    state.repoInflight["example/target"] = "target";
    state.bucketQueues["0"] = ["target"];
    const storage = fakeStorage(state);
    const object = new JudgeState({ storage } as any, {} as any);

    const response = await object.fetch(
      new Request("https://state/claim", {
        method: "POST",
        body: JSON.stringify({ callbackBaseUrl: "https://example.com", nowIso })
      })
    );

    expect(response.status).toBe(200);
    expect(storage.list).not.toHaveBeenCalled();
    expect(storage.transaction).toHaveBeenCalledTimes(1);
    expect(storage.put).toHaveBeenCalledTimes(2);
    expect(storage.put.mock.calls.map((call) => call[0])).toEqual(["job:target", "meta"]);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("reads an individual submission without listing historical jobs", async () => {
    const state = stateWithHistory(200);
    state.jobs.target = makeJob("target", "completed");
    const storage = fakeStorage(state);
    const object = new JudgeState({ storage } as any, {} as any);

    const response = await object.fetch(new Request("https://state/submission/target"));

    expect(response.status).toBe(200);
    expect(storage.get).toHaveBeenCalledWith("job:target");
    expect(storage.list).not.toHaveBeenCalled();
  });

  it.each([129, 500])("chunks %i ranking jobs into supported multi-key reads", async (historySize) => {
    const storage = fakeStorage(stateWithHistory(historySize));
    const object = new JudgeState({ storage } as any, {} as any);

    const response = await object.fetch(new Request("https://state/ranking"));
    const batches = storage.get.mock.calls
      .map((call) => call[0])
      .filter((key): key is string[] => Array.isArray(key));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ repo: "example/history-0" })])
    });
    expect(batches).toHaveLength(Math.ceil(historySize / 128));
    expect(batches.flat()).toHaveLength(historySize);
    expect(batches.every((batch) => batch.length <= 128)).toBe(true);
    expect(storage.list).not.toHaveBeenCalled();
  });

  it("treats legacy metadata without an accepted count as submission-limit reached", async () => {
    const state = createInitialSnapshot();
    delete (state as Partial<AppStateSnapshot>).acceptedSubmissions;
    const storage = fakeStorage(state);
    const object = new JudgeState({ storage } as any, {} as any);

    const response = await object.fetch(
      new Request("https://state/submit", {
        method: "POST",
        body: JSON.stringify({
          repoUrl: "https://github.com/example/legacy",
          ipHash: "legacy",
          callbackBaseUrl: "https://example.com",
          nowIso,
          maxAcceptedSubmissions: 1_000,
          resolution: {
            assessment: "scored",
            pinnedSha: null,
            defaultBranch: "main",
            summary: "legacy"
          }
        })
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "submission_limit"
    });
    expect(storage.transaction).not.toHaveBeenCalled();
  });

  it("keeps a failed finalized job that has fallen out of recent results", async () => {
    const state = createInitialSnapshot();
    state.jobs.target = makeJob("target", "processing");
    state.repoInflight["example/target"] = "target";
    const storage = fakeStorage(state);
    const object = new JudgeState({ storage } as any, {} as any);

    const response = await object.fetch(
      new Request("https://state/finalize", {
        method: "POST",
        body: JSON.stringify({
          submissionId: "target",
          callbackToken: "token-target",
          bucket: 0,
          callbackBaseUrl: "https://example.com",
          nowIso,
          outcome: { kind: "failed", message: "failed" }
        })
      })
    );

    expect(response.status).toBe(200);
    expect(storage.put.mock.calls.map((call) => call[0])).toEqual(["job:target", "meta"]);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

function stateWithHistory(size: number): AppStateSnapshot {
  const state = createInitialSnapshot();
  for (let index = 0; index < size; index += 1) {
    const id = `history-${index}`;
    const job = makeJob(id, "completed");
    state.jobs[id] = job;
    state.repoLatestCompleted[job.repo.normalized] = id;
  }
  return state;
}

function makeJob(id: string, status: SubmissionStatus): SubmissionRecord {
  const normalized = `example/${id.toLowerCase()}`;
  return {
    id,
    repoUrl: `https://github.com/${normalized}`,
    repo: {
      owner: "example",
      repo: id,
      normalized,
      canonicalUrl: `https://github.com/${normalized}`
    },
    bucket: 0,
    status,
    callbackToken: `token-${id}`,
    resolution: {
      assessment: "scored",
      pinnedSha: "a".repeat(40),
      defaultBranch: "main",
      summary: id
    },
    attempts: status === "queued" ? 0 : 1,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-08-08T00:00:00.000Z",
    completedAt: status === "completed" || status === "failed" ? "2026-08-08T00:01:00.000Z" : null,
    ipHash: `ip-${id}`,
    failureMessage: status === "failed" ? "failed" : null,
    result: status === "completed"
      ? buildZeroScoreResult({
          summary: id,
          publicReason: "done",
          repoAssessment: "empty_repository",
          pinnedSha: "a".repeat(40)
        })
      : null
  };
}

function fakeStorage(snapshot: AppStateSnapshot) {
  const { jobs, ...meta } = structuredClone(snapshot);
  const jobEntries = new Map(
    Object.entries(jobs).map(([id, job]) => [`job:${id}`, structuredClone(job)])
  );
  const put = vi.fn(async () => undefined);
  const remove = vi.fn(async () => true);
  return {
    get: vi.fn(async (key: string | string[]) => {
      if (Array.isArray(key)) {
        return new Map(key.flatMap((item) => {
          const value = jobEntries.get(item);
          return value ? [[item, structuredClone(value)] as const] : [];
        }));
      }
      if (key === "meta") {
        return structuredClone(meta);
      }
      const value = jobEntries.get(key);
      return value ? structuredClone(value) : undefined;
    }),
    list: vi.fn(async () => new Map(jobEntries)),
    put,
    delete: remove,
    transaction: vi.fn(async (closure: (transaction: unknown) => Promise<unknown>) =>
      closure({ put, delete: remove })
    )
  };
}
