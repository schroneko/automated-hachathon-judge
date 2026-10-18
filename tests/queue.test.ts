import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRITERIA, EVENT_ID } from "../src/shared/constants";
import type { ScoringQueueMessage } from "../src/shared/types";

const scorer = vi.hoisted(() => ({ scoreSubmission: vi.fn() }));
vi.mock("../src/container/scorer", () => scorer);

import { handleApiRequest } from "../src/worker/api";
import { processScoringMessage } from "../src/worker/queue";
import worker from "../src/worker/index";

class SqliteD1 {
  readonly db = new DatabaseSync(":memory:");
  private pending: Promise<unknown> = Promise.resolve();

  constructor() {
    const migrations = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(migrations).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
      this.db.exec(readFileSync(new URL(file, migrations), "utf8"));
    }
  }

  prepare(sql: string) {
    const database = this.db;
    return {
      bind(...values: unknown[]) {
        const statement = database.prepare(sql);
        return {
          async first<T>() { return (statement.get(...values as []) ?? null) as T | null; },
          async all<T>() { return { results: statement.all(...values as []) as T[] }; },
          async run() { return { meta: { changes: Number(statement.run(...values as []).changes) } }; }
        };
      }
    };
  }

  async batch(statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>) {
    const run = this.pending.then(async () => {
      this.db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        this.db.exec("COMMIT");
        return results;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
    this.pending = run.catch(() => undefined);
    return run;
  }

  changes(): number {
    return Number((this.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
  }

  row(id: string): { status: string; attempts: number; failure_message: string | null; callback_token: string | null } {
    return this.db.prepare("SELECT * FROM devday_judge_submissions WHERE id = ?").get(id) as { status: string; attempts: number; failure_message: string | null; callback_token: string | null };
  }

  account(mode: string): { spent_micro_usd: number; reserved_micro_usd: number } {
    return this.db.prepare("SELECT * FROM devday_judge_budget_accounts WHERE mode = ?").get(mode) as { spent_micro_usd: number; reserved_micro_usd: number };
  }
}

function score() {
  return {
    summary: "summary", publicReason: "reason", repoAssessment: "scored", pinnedSha: "a".repeat(40),
    criteria: CRITERIA.map((item) => ({ key: item.key, label: item.label, score: 8, reason: "reason", evidencePaths: [] })),
    total: 32, attackScore: null
  };
}

function setup() {
  const database = new SqliteD1();
  const sent: ScoringQueueMessage[] = [];
  let sendError = false;
  const env = {
    JUDGE_DB: database,
    SCORING_QUEUE: { send: async (message: ScoringQueueMessage) => { sent.push(message); if (sendError) throw new Error("ambiguous send"); } },
    RUNNER_TOKEN: "organizer-secret",
    JUDGING_ENABLED: "true",
    SUBMISSIONS_OPEN: "true",
    OPENAI_API_KEY_20261018_HACKATHON: "scoring-secret"
  } as unknown as Env;
  async function api(path: string, method = "GET", body?: unknown, auth = false) {
    return handleApiRequest(new Request(`https://judge.example.com${path}`, {
      method,
      headers: auth ? { authorization: "Bearer organizer-secret", "content-type": "application/json" } : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env, {} as ExecutionContext);
  }
  async function create(name: string, mode: "production" | "validation" = "production", effort?: "low" | "high") {
    const response = await api("/api/submissions", "POST", { repoUrl: `https://github.com/example/${name}`, mode, ...(effort ? { effort } : {}) }, true);
    const body = await response.json() as { submission?: { id: string } };
    return { response, id: body.submission?.id ?? "" };
  }
  return { database, env, sent, api, create, setSendError: (value: boolean) => { sendError = value; } };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); scorer.scoreSubmission.mockReset(); });

describe("cloud queue runtime", () => {
  it("acknowledges a completed or skipped Queue delivery without requesting retry", async () => {
    const { database, env, sent, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    scorer.scoreSubmission.mockResolvedValue(score());
    const created = await create("ack");
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = { messages: [{ body: sent[0], ack, retry }] } as unknown as MessageBatch<ScoringQueueMessage>;
    await worker.queue(batch, env, {} as ExecutionContext);
    await worker.queue(batch, env, {} as ExecutionContext);
    expect(database.row(created.id)).toMatchObject({ status: "completed", attempts: 1 });
    expect(ack).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
    expect(scorer.scoreSubmission).toHaveBeenCalledTimes(1);
  });

  it.each([["validation", "low"], ["validation", "high"], ["production", "high"]] as const)("scores %s with %s effort, reserves and settles", async (mode, effort) => {
    const { database, env, sent, api, create } = setup();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/models");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer scoring-secret");
      return Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] });
    });
    vi.stubGlobal("fetch", fetcher);
    scorer.scoreSubmission.mockImplementation(async (_job: unknown, options: {
      effort: string; apiKey: string;
      beforeCall: (input: unknown) => Promise<string>;
      afterCall: (input: unknown) => Promise<void>;
    }) => {
      expect(options.effort).toBe(effort);
      expect(options.apiKey).toBe("scoring-secret");
      const reservationId = await options.beforeCall({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 });
      expect(database.account(mode).reserved_micro_usd).toBe(1_000_000);
      await options.afterCall({ kind: "responses", model: "gpt-6.1-sol", reservationId, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.0003 });
      expect(database.account(mode)).toMatchObject({ spent_micro_usd: 300, reserved_micro_usd: 0 });
      return score();
    });
    const created = await create(`success-${mode}`, mode, effort);
    expect(created.response.status).toBe(202);
    expect(sent).toEqual([{ eventId: EVENT_ID, submissionId: created.id, mode, attempt: 0, dispatch: 1 }]);
    await processScoringMessage(sent[0], env);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(database.row(created.id)).toMatchObject({ status: "completed", attempts: 1, effort });
    const publicResponse = await api(`/api/submissions/${created.id}`);
    const publicText = await publicResponse.text();
    expect(publicText).not.toContain("scoring-secret");
    expect(publicText).not.toContain(database.row(created.id).callback_token);
    const before = database.changes();
    await processScoringMessage(sent[0], env);
    expect(database.changes()).toBe(before);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(scorer.scoreSubmission).toHaveBeenCalledTimes(1);
  });

  it("claims one exact message under duplicate concurrency and skips invalid identities without writes", async () => {
    const { database, env, sent, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    scorer.scoreSubmission.mockResolvedValue(score());
    const first = await create("first");
    const second = await create("second");
    const original = sent[0]!;
    const before = database.changes();
    for (const message of [
      { ...original, eventId: "other" }, { ...original, submissionId: second.id, mode: "validation" },
      { ...original, attempt: 1 }, { ...original, attempt: -1 }, { ...original, submissionId: "missing" },
      { ...original, dispatch: 0 }, { ...original, dispatch: 4 }, { ...original, dispatch: 2 }
    ]) await processScoringMessage(message, env);
    expect(database.changes()).toBe(before);
    expect(scorer.scoreSubmission).not.toHaveBeenCalled();
    await Promise.all([processScoringMessage(original, env), processScoringMessage(original, env)]);
    expect(database.row(first.id)).toMatchObject({ status: "completed", attempts: 1 });
    expect(database.row(second.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(scorer.scoreSubmission).toHaveBeenCalledTimes(1);
  });

  it("marks a failed producer send and ignores an ambiguously accepted message", async () => {
    const { database, env, sent, create, setSendError } = setup();
    setSendError(true);
    const created = await create("send-failure");
    expect(created.response.status).toBe(503);
    expect(database.row(sent[0]!.submissionId)).toMatchObject({ status: "failed", attempts: 0 });
    const before = database.changes();
    await processScoringMessage(sent[0], env);
    expect(database.changes()).toBe(before);
    expect(scorer.scoreSubmission).not.toHaveBeenCalled();
  });

  it("requires manual retry and rejects an earlier attempt after requeue", async () => {
    const { database, env, sent, api, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    scorer.scoreSubmission.mockRejectedValue(new Error("secret diagnostic"));
    const created = await create("retry");
    await processScoringMessage(sent[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(database.row(created.id).failure_message).not.toContain("secret");
    const path = `/api/submissions/${created.id}/retry`;
    expect((await api(path, "POST", { confirm: true })).status).toBe(401);
    expect((await api(path, "POST", { confirm: false }, true)).status).toBe(400);
    expect((await api(path, "POST", { confirm: true }, true)).status).toBe(202);
    expect(sent[1]).toMatchObject({ submissionId: created.id, attempt: 1 });
    const before = database.changes();
    await processScoringMessage(sent[0], env);
    expect(database.changes()).toBe(before);
    await processScoringMessage(sent[1], env);
    expect(database.row(created.id).attempts).toBe(2);
    expect((await api(path, "POST", { confirm: true }, true)).status).toBe(202);
    await processScoringMessage(sent[2], env);
    expect(database.row(created.id).attempts).toBe(3);
    expect((await api(path, "POST", { confirm: true }, true)).status).toBe(409);
    expect(scorer.scoreSubmission).toHaveBeenCalledTimes(3);
  });

  it("stops new claims and reservations while paused, retaining charged usage settlement", async () => {
    const { database, env, sent, api, create } = setup();
    const created = await create("paused");
    env.JUDGING_ENABLED = "false";
    await processScoringMessage(sent[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "failed", attempts: 0 });
    expect(scorer.scoreSubmission).not.toHaveBeenCalled();
    expect((await api(`/api/submissions/${created.id}/retry`, "POST", { confirm: true }, true)).status).toBe(410);
    expect((await create("new-paused")).response.status).toBe(410);
  });

  it("fails before a paid call when the budget cap is exhausted", async () => {
    const { database, env, sent, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    database.db.prepare("UPDATE devday_judge_budget_accounts SET spent_micro_usd = limit_micro_usd WHERE mode = 'production'").run();
    scorer.scoreSubmission.mockImplementation(async (_job: unknown, options: { beforeCall: (input: unknown) => Promise<string> }) => {
      await options.beforeCall({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 });
      throw new Error("paid call reached");
    });
    const created = await create("budget");
    await processScoringMessage(sent[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "failed", failure_message: "Budget exhausted" });
    expect(database.account("production")).toMatchObject({ spent_micro_usd: 90_000_000, reserved_micro_usd: 0 });
  });

  it("retains an unresolved reservation after a scorer failure without an automatic retry", async () => {
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { database, env, sent, create } = setup();
    const modelFetch = vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] }));
    vi.stubGlobal("fetch", modelFetch);
    scorer.scoreSubmission.mockImplementation(async (_job: unknown, options: { beforeCall: (input: unknown) => Promise<string> }) => {
      await options.beforeCall({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 });
      throw new Error("sensitive provider response");
    });
    const created = await create("unresolved");
    await processScoringMessage(sent[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(database.row(created.id).failure_message).not.toContain("sensitive");
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("sensitive provider response");
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("scoring-secret");
    expect(database.account("production")).toMatchObject({ spent_micro_usd: 0, reserved_micro_usd: 1_000_000 });
    const before = database.changes();
    await processScoringMessage(sent[0], env);
    expect(database.changes()).toBe(before);
    expect(modelFetch).toHaveBeenCalledTimes(1);
    expect(scorer.scoreSubmission).toHaveBeenCalledTimes(1);
  });

  it("fails a claimed job before scoring when either required model is absent", async () => {
    const { database, env, sent, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }] })));
    const created = await create("models");
    await processScoringMessage(sent[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(scorer.scoreSubmission).not.toHaveBeenCalled();
    expect(database.account("production")).toMatchObject({ spent_micro_usd: 0, reserved_micro_usd: 0 });
  });

  it("requires explicit high validation and preserves earlier charges when upgrading a completed low run", async () => {
    const { database, env, sent, api, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    const efforts: string[] = [];
    scorer.scoreSubmission.mockImplementation(async (_job: unknown, options: {
      effort: string;
      beforeCall: (input: unknown) => Promise<string>;
      afterCall: (input: unknown) => Promise<void>;
    }) => {
      efforts.push(options.effort);
      const reservationId = await options.beforeCall({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 });
      await options.afterCall({ kind: "responses", model: "gpt-6.1-sol", reservationId, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.0003 });
      return score();
    });
    const created = await create("validation-upgrade", "validation");
    await processScoringMessage(sent[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "completed", effort: "low", attempts: 1 });
    const before = database.changes();
    expect((await create("validation-upgrade", "validation", "high")).response.status).toBe(200);
    expect(database.changes()).toBe(before);
    expect(sent).toHaveLength(1);
    const path = `/api/submissions/${created.id}/retry`;
    expect((await api(path, "POST", { confirm: true, effort: "high" })).status).toBe(401);
    expect((await api(path, "POST", { confirm: false, effort: "high" }, true)).status).toBe(400);
    expect((await api(path, "POST", { confirm: true }, true)).status).toBe(409);
    const requests = await Promise.all([
      api(path, "POST", { confirm: true, effort: "high" }, true),
      api(path, "POST", { confirm: true, effort: "high" }, true)
    ]);
    expect(requests.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(sent).toHaveLength(2);
    expect(database.account("validation")).toMatchObject({ spent_micro_usd: 300, reserved_micro_usd: 0 });
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM devday_judge_budget_reservations").get()).toMatchObject({ count: 1 });
    const requeued = database.changes();
    await processScoringMessage(sent[0], env);
    expect(database.changes()).toBe(requeued);
    await Promise.all([processScoringMessage(sent[1], env), processScoringMessage(sent[1], env)]);
    expect(efforts).toEqual(["low", "high"]);
    expect(database.row(created.id)).toMatchObject({ status: "completed", effort: "high", attempts: 2 });
    expect(database.account("validation")).toMatchObject({ spent_micro_usd: 600, reserved_micro_usd: 0 });
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM devday_judge_budget_reservations").get()).toMatchObject({ count: 2 });
    expect((await api(path, "POST", { confirm: true, effort: "high" }, true)).status).toBe(409);
    expect(scorer.scoreSubmission).toHaveBeenCalledTimes(2);
  });

  it("keeps production high and rejects unsupported efforts before any write or send", async () => {
    const { database, sent, api, create } = setup();
    const before = database.changes();
    for (const effort of ["low", "light", null, 1]) {
      expect((await api("/api/submissions", "POST", { repoUrl: "https://github.com/example/production-effort", mode: "production", effort }, true)).status).toBe(400);
    }
    expect(database.changes()).toBe(before);
    expect(sent).toHaveLength(0);
    const created = await create("production-effort");
    expect(database.row(created.id)).toMatchObject({ effort: "high" });
    expect((await api(`/api/submissions/${created.id}/retry`, "POST", { confirm: true, effort: "high" }, true)).status).toBe(400);
  });

  it("recovers a stale queued delivery once while rejecting fresh queued retries", async () => {
    const { database, env, sent, api, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    scorer.scoreSubmission.mockResolvedValue(score());
    const created = await create("queued-recovery");
    const path = `/api/submissions/${created.id}/retry`;
    expect((await api(path, "POST", { confirm: true }, true)).status).toBe(409);
    database.db.prepare("UPDATE devday_judge_submissions SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 31 * 60 * 1000).toISOString(), created.id);
    const requests = await Promise.all([api(path, "POST", { confirm: true }, true), api(path, "POST", { confirm: true }, true)]);
    expect(requests.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(sent).toHaveLength(2);
    await Promise.all([processScoringMessage(sent[0], env), processScoringMessage(sent[1], env)]);
    expect(scorer.scoreSubmission).toHaveBeenCalledTimes(1);
    expect(database.row(created.id)).toMatchObject({ status: "completed", attempts: 1 });
  });

  it("fails invalid scorer output without leaving a processing lease", async () => {
    const { database, env, sent, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    scorer.scoreSubmission.mockResolvedValue({ ...score(), total: 33 });
    const created = await create("invalid-score");
    await processScoringMessage(sent[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(database.row(created.id).failure_message).toContain("failed validation");
  });

  it("acknowledges a failed infrastructure delivery without a model call or automatic retry", async () => {
    const { database, env, sent, create } = setup();
    const created = await create("database-outage");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    env.JUDGE_DB = { prepare: () => { throw new Error("database unavailable"); } } as unknown as D1Database;
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = { messages: [{ body: sent[0], ack, retry }] } as unknown as MessageBatch<ScoringQueueMessage>;
    await expect(worker.queue(batch, env, {} as ExecutionContext)).rejects.toThrow("database unavailable");
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(scorer.scoreSubmission).not.toHaveBeenCalled();
    expect(database.row(created.id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("consumes ambiguous send failures and stops concurrent retries after three dispatches", async () => {
    const { database, env, sent, api, create, setSendError } = setup();
    setSendError(true);
    expect((await create("dispatch-failures")).response.status).toBe(503);
    const id = sent[0]!.submissionId;
    const path = `/api/submissions/${id}/retry`;
    const concurrent = await Promise.all([api(path, "POST", { confirm: true }, true), api(path, "POST", { confirm: true }, true)]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([409, 503]);
    expect((await api(path, "POST", { confirm: true }, true)).status).toBe(503);
    expect(sent.map((message) => message.dispatch)).toEqual([1, 2, 3]);
    expect(database.row(id)).toMatchObject({ status: "failed", attempts: 0, dispatch_count: 3 });
    const before = database.changes();
    for (let index = 0; index < 10; index += 1) {
      expect((await api(path, "POST", { confirm: true }, true)).status).toBe(409);
    }
    expect((await create("dispatch-failures")).response.status).toBe(200);
    for (const message of sent) await processScoringMessage(message, env);
    expect(database.changes()).toBe(before);
    expect(sent).toHaveLength(3);
    expect(scorer.scoreSubmission).not.toHaveBeenCalled();
  });

  it("rejects an earlier dispatch after a paused attempt and bounds pause recovery sends", async () => {
    const { database, env, sent, api, create } = setup();
    const created = await create("pause-dispatches");
    const path = `/api/submissions/${created.id}/retry`;
    env.JUDGING_ENABLED = "false";
    await processScoringMessage(sent[0], env);
    env.JUDGING_ENABLED = "true";
    expect((await api(path, "POST", { confirm: true }, true)).status).toBe(202);
    const before = database.changes();
    await processScoringMessage(sent[0], env);
    expect(database.changes()).toBe(before);
    expect(database.row(created.id)).toMatchObject({ status: "queued", attempts: 0, dispatch_count: 2 });
    env.JUDGING_ENABLED = "false";
    await processScoringMessage(sent[1], env);
    env.JUDGING_ENABLED = "true";
    expect((await api(path, "POST", { confirm: true }, true)).status).toBe(202);
    env.JUDGING_ENABLED = "false";
    await processScoringMessage(sent[2], env);
    env.JUDGING_ENABLED = "true";
    expect((await api(path, "POST", { confirm: true }, true)).status).toBe(409);
    expect(database.row(created.id)).toMatchObject({ status: "failed", attempts: 0, dispatch_count: 3 });
    expect(sent).toHaveLength(3);
    expect(scorer.scoreSubmission).not.toHaveBeenCalled();
  });

  it("limits all sixty submission slots to one hundred eighty sends even when every send fails", async () => {
    const { database, sent, api, create, setSendError } = setup();
    setSendError(true);
    for (const mode of ["production", "validation"] as const) {
      const limit = mode === "production" ? 40 : 20;
      for (let index = 0; index < limit; index += 1) {
        expect((await create(`all-failures-${mode}-${index}`, mode)).response.status).toBe(503);
        const id = sent.at(-1)!.submissionId;
        const path = `/api/submissions/${id}/retry`;
        expect((await api(path, "POST", { confirm: true }, true)).status).toBe(503);
        expect((await api(path, "POST", { confirm: true }, true)).status).toBe(503);
        expect((await api(path, "POST", { confirm: true }, true)).status).toBe(409);
      }
      expect((await create(`overflow-${mode}`, mode)).response.status).toBe(429);
    }
    expect(sent).toHaveLength(180);
    expect(database.db.prepare("SELECT COUNT(*) AS count, SUM(dispatch_count) AS dispatches, SUM(attempts) AS attempts FROM devday_judge_submissions").get())
      .toMatchObject({ count: 60, dispatches: 180, attempts: 0 });
    expect(scorer.scoreSubmission).not.toHaveBeenCalled();
  });
});
