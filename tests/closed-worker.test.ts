import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import type { JudgeQueueMessage } from "../src/shared/types";

function closedEnv(flags: { JUDGING_ENABLED?: string; SUBMISSIONS_OPEN?: string } = { JUDGING_ENABLED: "false", SUBMISSIONS_OPEN: "false" }): Env {
  const env = { ...flags };
  for (const key of ["JUDGE_DB", "SCORING_QUEUE", "EXPLANATION_QUEUE", "OPENAI_API_KEY_20261018_HACKATHON", "ASSETS"]) {
    Object.defineProperty(env, key, { get() { throw new Error(`Closed event accessed ${key}`); } });
  }
  return env as Env;
}

const context = {} as ExecutionContext;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Closed event made an external request"); }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("closed event worker", () => {
  it.each([
    ["GET", "/api/dashboard"],
    ["GET", "/api/ranking"],
    ["GET", "/api/recent"],
    ["GET", "/api/submissions/submission-id"],
    ["GET", "/api/results/submission-id"],
    ["GET", "/api/batches/batch-id"],
    ["POST", "/api/submissions"],
    ["POST", "/api/batches"],
    ["POST", "/api/batches/batch-id/retry"],
    ["POST", "/api/submissions/submission-id/retry"],
    ["POST", "/api/submissions/submission-id/rescore"],
    ["POST", "/api/submissions/submission-id/recover"],
    ["PATCH", "/api/submissions/submission-id"],
    ["POST", "/internal/runner/claim"],
    ["POST", "/internal/scoring-callback"],
    ["POST", "/internal/budget/reserve"],
    ["POST", "/internal/budget/settle"],
    ["POST", "/api/submission-status"],
    ["POST", "/api/runner-status"]
  ])("rejects %s %s before reading bindings or making external requests", async (method, path) => {
    const request = new Request(`https://judge.example.com${path}`, {
      method,
      ...(method === "GET" ? {} : { body: "invalid-json" })
    });
    const response = await worker.fetch(request, closedEnv(), context);
    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "The event has ended. Judging is closed.", code: "event_closed" });
  });

  it.each([
    { JUDGING_ENABLED: "false", SUBMISSIONS_OPEN: "false" },
    { JUDGING_ENABLED: " FALSE ", SUBMISSIONS_OPEN: " False " },
    {}
  ])("serves closed status without reading bindings for %j", async (flags) => {
    const env = closedEnv(flags);
    const submissions = await worker.fetch(new Request("https://judge.example.com/api/submission-status"), env, context);
    const runner = await worker.fetch(new Request("https://judge.example.com/api/runner-status"), env, context);
    expect(submissions.status).toBe(200);
    expect(await submissions.json()).toEqual({ open: false, closed: true });
    expect(runner.status).toBe(200);
    expect(await runner.json()).toEqual({ online: false, lastSeenAt: null });
  });

  it("acknowledges a queued batch before inspecting messages or reading bindings", async () => {
    const ackAll = vi.fn();
    const retryAll = vi.fn();
    const batch = {
      ackAll,
      retryAll,
      get messages() { throw new Error("Closed event inspected queued work"); }
    } as unknown as MessageBatch<JudgeQueueMessage>;
    await worker.queue(batch, closedEnv(), context);
    expect(ackAll).toHaveBeenCalledExactlyOnceWith();
    expect(retryAll).not.toHaveBeenCalled();
  });
});
