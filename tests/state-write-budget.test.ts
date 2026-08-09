import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStateSnapshot, SubmissionRecord } from "../src/shared/types";
import { JudgeState } from "../src/worker/judge-state";
import { createInitialSnapshot, submitJob } from "../src/worker/state-machine";
import {
  countStatePersistenceRows,
  prepareStateWriteBudget,
  resolveStateWriteBudgetConfig,
  type StateWriteBudgetConfig
} from "../src/worker/state-write-budget";

const nowIso = "2026-08-09T00:00:00.000Z";
const config: StateWriteBudgetConfig = { warningRows: 2, hardLimitRows: 5 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(nowIso));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("state write budget", () => {
  it("uses the default warning and hard limits", () => {
    expect(resolveStateWriteBudgetConfig({} as Env)).toEqual({
      warningRows: 25_000,
      hardLimitRows: 50_000
    });
  });

  it("counts no-op persistence as zero rows", () => {
    const before = createInitialSnapshot();
    const decision = prepareStateWriteBudget(before, structuredClone(before), nowIso, config);

    expect(decision.kind).toBe("noop");
    expect(decision.status.rowsWritten).toBe(0);
  });

  it("counts successful job, metadata, and delete keys", () => {
    const before = createInitialSnapshot();
    const after = structuredClone(before);
    submitJob(after, {
      repoUrl: "https://github.com/example/budget",
      ipHash: "budget",
      callbackBaseUrl: "https://hackathon.nukoevi.app",
      nowIso,
      resolution: {
        assessment: "scored",
        pinnedSha: null,
        defaultBranch: "main",
        summary: "budget"
      }
    });

    const decision = prepareStateWriteBudget(before, after, nowIso, config);

    expect(decision.kind).toBe("persist");
    if (decision.kind !== "persist") {
      return;
    }
    expect(countStatePersistenceRows(decision.plan)).toBe(2);
    expect(decision.status.rowsWritten).toBe(2);

    const deleteBefore = structuredClone(after);
    const deleteAfter = structuredClone(deleteBefore);
    const id = Object.keys(deleteAfter.jobs)[0];
    delete deleteAfter.jobs[id];
    const deleteDecision = prepareStateWriteBudget(deleteBefore, deleteAfter, nowIso, config);

    expect(deleteDecision.kind).toBe("persist");
    if (deleteDecision.kind !== "persist") {
      return;
    }
    expect(countStatePersistenceRows(deleteDecision.plan)).toBe(2);
    expect(deleteDecision.status.rowsWritten).toBe(4);
  });

  it("emits the warning once per UTC day", () => {
    const before = createInitialSnapshot();
    const after = structuredClone(before);
    after.runnerLastSeenAt = nowIso;
    after.writeBudget = {
      utcDate: "2026-08-09",
      rowsWritten: 1,
      warningEmitted: false,
      exhausted: false,
      exhaustedAt: null
    };
    before.writeBudget = structuredClone(after.writeBudget);
    before.runnerLastSeenAt = "2026-08-08T23:59:55.000Z";

    const first = prepareStateWriteBudget(before, after, nowIso, config);

    expect(first.kind).toBe("persist");
    if (first.kind !== "persist") {
      return;
    }
    expect(first.logWarning).toBe(true);
    expect(first.status.warningEmitted).toBe(true);

    const nextBefore = structuredClone(after);
    const nextAfter = structuredClone(nextBefore);
    nextAfter.runnerLastSeenAt = "2026-08-09T00:00:05.000Z";
    const second = prepareStateWriteBudget(nextBefore, nextAfter, nextAfter.runnerLastSeenAt, config);

    expect(second.kind).toBe("persist");
    if (second.kind !== "persist") {
      return;
    }
    expect(second.logWarning).toBe(false);
    expect(second.status.rowsWritten).toBe(3);
  });

  it("resets the counter on the next UTC day", () => {
    const before = createInitialSnapshot();
    before.writeBudget = {
      utcDate: "2026-08-08",
      rowsWritten: 5,
      warningEmitted: true,
      exhausted: true,
      exhaustedAt: "2026-08-08T23:59:00.000Z"
    };
    const after = structuredClone(before);
    after.runnerLastSeenAt = nowIso;

    const decision = prepareStateWriteBudget(before, after, nowIso, config);

    expect(decision.kind).toBe("persist");
    if (decision.kind !== "persist") {
      return;
    }
    expect(decision.status).toMatchObject({
      utcDate: "2026-08-09",
      rowsWritten: 1,
      warningEmitted: false,
      exhausted: false
    });
  });

  it("does not reset the counter when an older UTC date is supplied", () => {
    const before = createInitialSnapshot();
    before.writeBudget = {
      utcDate: "2026-08-09",
      rowsWritten: 3,
      warningEmitted: true,
      exhausted: false,
      exhaustedAt: null
    };
    const after = structuredClone(before);
    after.runnerLastSeenAt = "2026-08-08T23:59:59.000Z";

    const decision = prepareStateWriteBudget(
      before,
      after,
      "2026-08-08T23:59:59.000Z",
      config
    );

    expect(decision.kind).toBe("persist");
    if (decision.kind !== "persist") {
      return;
    }
    expect(decision.status).toMatchObject({
      utcDate: "2026-08-09",
      rowsWritten: 4,
      warningEmitted: true,
      exhausted: false
    });
  });

  it("writes one structured warning log per UTC day", async () => {
    const state = createInitialSnapshot();
    state.runnerLastSeenAt = "2026-08-08T23:59:55.000Z";
    state.writeBudget = {
      utcDate: "2026-08-09",
      rowsWritten: 24_999,
      warningEmitted: false,
      exhausted: false,
      exhaustedAt: null
    };
    const storage = fakeStorage(state);
    const object = new JudgeState({ storage } as any, {} as any);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const first = await object.fetch(
        new Request("https://state/heartbeat", {
          method: "POST",
          body: JSON.stringify({ nowIso })
        })
      );
      const second = await object.fetch(
        new Request("https://state/heartbeat", {
          method: "POST",
          body: JSON.stringify({ nowIso: "2026-08-09T00:00:05.000Z" })
        })
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(consoleWarn.mock.calls[0]?.[0]))).toEqual({
        event: "durable_object_write_budget_warning",
        utcDate: "2026-08-09",
        rowsWritten: 25_000,
        warningRows: 25_000,
        hardLimitRows: 50_000
      });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("writes only a metadata stop marker when a domain write would exceed the limit", async () => {
    const state = createInitialSnapshot();
    const job = makeJob("target");
    state.jobs.target = job;
    state.repoInflight[job.repo.normalized] = job.id;
    state.bucketQueues["0"] = [job.id];
    state.writeBudget = {
      utcDate: "2026-08-09",
      rowsWritten: 49_999,
      warningEmitted: true,
      exhausted: false,
      exhaustedAt: null
    };
    const storage = fakeStorage(state);
    const object = new JudgeState({ storage } as any, {} as any);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await object.fetch(
        new Request("https://state/claim", {
          method: "POST",
          body: JSON.stringify({ callbackBaseUrl: "https://example.com", nowIso })
        })
      );

      expect(response.status).toBe(507);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        code: "write_budget_exhausted",
        writeBudget: {
          rowsWritten: 50_000,
          exhausted: true,
          remainingRows: 0
        }
      });
      expect(storage.transaction).toHaveBeenCalledTimes(1);
      expect(storage.put).toHaveBeenCalledTimes(1);
      expect(storage.put.mock.calls[0]?.[0]).toBe("meta");
      expect(storage.put.mock.calls[0]?.[1]).toMatchObject({
        bucketQueues: { "0": ["target"] },
        bucketActive: { "0": false },
        writeBudget: {
          rowsWritten: 50_000,
          exhausted: true
        }
      });
      expect(storage.delete).not.toHaveBeenCalled();

      storage.transaction.mockClear();
      storage.put.mockClear();
      storage.delete.mockClear();
      const repeated = await object.fetch(
        new Request("https://state/heartbeat", {
          method: "POST",
          body: JSON.stringify({ nowIso: "2026-08-09T00:00:05.000Z" })
        })
      );

      expect(repeated.status).toBe(507);
      expect(storage.transaction).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("allows the write that reaches the exact limit and rejects the next write", async () => {
    const state = createInitialSnapshot();
    state.runnerLastSeenAt = "2026-08-08T23:59:55.000Z";
    state.writeBudget = {
      utcDate: "2026-08-09",
      rowsWritten: 49_999,
      warningEmitted: true,
      exhausted: false,
      exhaustedAt: null
    };
    const storage = fakeStorage(state);
    const object = new JudgeState({ storage } as any, {} as any);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const accepted = await object.fetch(
        new Request("https://state/heartbeat", {
          method: "POST",
          body: JSON.stringify({ nowIso })
        })
      );
      expect(accepted.status).toBe(200);
      expect(storage.put).toHaveBeenCalledTimes(1);
      expect(storage.put.mock.calls[0]?.[1]).toMatchObject({
        writeBudget: {
          rowsWritten: 50_000,
          exhausted: true
        }
      });

      storage.transaction.mockClear();
      storage.put.mockClear();
      const rejected = await object.fetch(
        new Request("https://state/heartbeat", {
          method: "POST",
          body: JSON.stringify({ nowIso: "2026-08-09T00:00:05.000Z" })
        })
      );
      expect(rejected.status).toBe(507);
      expect(storage.transaction).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not advance stored usage when the transaction fails", async () => {
    const state = createInitialSnapshot();
    state.runnerLastSeenAt = "2026-08-08T23:59:55.000Z";
    const storage = fakeStorage(state);
    storage.transaction.mockRejectedValueOnce(new Error("storage unavailable"));
    const object = new JudgeState({ storage } as any, {} as any);

    await expect(object.fetch(
      new Request("https://state/heartbeat", {
        method: "POST",
        body: JSON.stringify({ nowIso })
      })
    )).rejects.toThrow("storage unavailable");

    const status = await object.fetch(new Request("https://state/write-budget"));
    await expect(status.json()).resolves.toMatchObject({
      utcDate: "2026-08-09",
      rowsWritten: 0,
      warningEmitted: false,
      exhausted: false
    });
  });
});

function makeJob(id: string): SubmissionRecord {
  return {
    id,
    repoUrl: `https://github.com/example/${id}`,
    repo: {
      owner: "example",
      repo: id,
      normalized: `example/${id}`,
      canonicalUrl: `https://github.com/example/${id}`
    },
    bucket: 0,
    status: "queued",
    callbackToken: `token-${id}`,
    resolution: {
      assessment: "scored",
      pinnedSha: null,
      defaultBranch: "main",
      summary: id
    },
    attempts: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
    startedAt: null,
    completedAt: null,
    ipHash: `ip-${id}`,
    failureMessage: null,
    result: null
  };
}

function fakeStorage(snapshot: AppStateSnapshot) {
  const { jobs, ...initialMeta } = structuredClone(snapshot);
  let meta = initialMeta;
  const jobEntries = new Map(
    Object.entries(jobs).map(([id, job]) => [`job:${id}`, structuredClone(job)])
  );
  const put = vi.fn(async (key: string, value: unknown) => {
    if (key === "meta") {
      meta = structuredClone(value) as typeof meta;
    } else {
      jobEntries.set(key, structuredClone(value) as SubmissionRecord);
    }
  });
  const remove = vi.fn(async (key: string) => jobEntries.delete(key));
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
