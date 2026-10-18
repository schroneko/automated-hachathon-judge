import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CRITERIA } from "../src/shared/constants";
import { callback, claimQueueMessage, handleApiRequest, reserve, settle } from "../src/worker/api";
import { EVENT_ID } from "../src/shared/constants";

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
          async first<T>() {
            return (statement.get(...values as []) ?? null) as T | null;
          },
          async all<T>() {
            return { results: statement.all(...values as []) as T[] };
          },
          async run() {
            const result = statement.run(...values as []);
            return { meta: { changes: Number(result.changes) } };
          }
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

  account(mode: string): { spent_micro_usd: number; reserved_micro_usd: number } {
    return this.db.prepare("SELECT * FROM devday_judge_budget_accounts WHERE mode = ?").get(mode) as { spent_micro_usd: number; reserved_micro_usd: number };
  }
}

function setup() {
  const database = new SqliteD1();
  const sent: unknown[] = [];
  const env = {
    JUDGE_DB: database,
    SCORING_QUEUE: { send: async (message: unknown) => { sent.push(message); } },
    RUNNER_TOKEN: "runner-secret",
    JUDGING_ENABLED: "true",
    SUBMISSIONS_OPEN: "true",
    OPENAI_API_KEY_20261018_HACKATHON: "test-key"
  } as unknown as Env;
  async function call(path: string, method = "GET", body?: unknown, authorized = false) {
    const request = new Request(`https://judge.example.com${path}`, {
      method,
      headers: authorized ? { authorization: "Bearer runner-secret", "content-type": "application/json" } : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
    });
    if (path === "/internal/runner/claim") {
      const mode = (body as { mode?: "production" | "validation" } | undefined)?.mode ?? "production";
      const row = database.db.prepare("SELECT id, attempts, dispatch_count FROM devday_judge_submissions WHERE event_id = ? AND mode = ? AND status = 'queued' ORDER BY created_at, id LIMIT 1").get(EVENT_ID, mode) as { id: string; attempts: number; dispatch_count: number } | undefined;
      if (!row) return new Response(null, { status: 204 });
      const job = await claimQueueMessage({ eventId: EVENT_ID, submissionId: row.id, mode, attempt: row.attempts, dispatch: row.dispatch_count }, env);
      return job ? Response.json({ job }) : new Response(null, { status: 204 });
    }
    if (path === "/internal/scoring-callback") return callback(request, env);
    if (path === "/internal/budget/reserve") return reserve(request, env);
    if (path === "/internal/budget/settle") return settle(request, env);
    return handleApiRequest(request, env, {} as ExecutionContext);
  }
  return { database, env, call, sent };
}

async function submit(call: ReturnType<typeof setup>["call"], name: string, mode = "production") {
  return call("/api/submissions", "POST", { repoUrl: `https://github.com/Example/${name}`, teamName: name, mode }, true);
}

async function claim(call: ReturnType<typeof setup>["call"], mode = "production") {
  const response = await call("/internal/runner/claim", "POST", { mode }, true);
  return response.status === 204 ? null : (await response.json() as { job: { submissionId: string; callbackToken: string; mode: string; pinnedSha: null } }).job;
}

function score(total: number) {
  const scores = total === 10 ? [4, 2, 2, 2] : total === 20 ? [6, 6, 4, 4] : [total / 4, total / 4, total / 4, total / 4];
  return {
    summary: "summary",
    publicReason: "reason",
    repoAssessment: "scored",
    pinnedSha: "a".repeat(40),
    criteria: CRITERIA.map((item, index) => ({ key: item.key, label: item.label, score: scores[index], reason: "reason", evidencePaths: [] })),
    total,
    attackScore: null
  };
}

describe("D1 runtime API", () => {
  it("preserves existing rows and counts pre-migration claims as one attempt", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(new URL("../migrations/0001_runtime.sql", import.meta.url), "utf8"));
      const insert = database.prepare("INSERT INTO devday_judge_submissions (id, event_id, repo_url, repo_normalized, repo_owner, repo_name, team_name, mode, status, created_at, updated_at) VALUES (?, 'devday-20261018', ?, ?, 'example', ?, ?, 'production', ?, '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z')");
      for (const status of ["queued", "processing", "failed", "completed"]) insert.run(status, `https://github.com/example/${status}`, `example/${status}`, status, status, status);
      database.exec("UPDATE devday_judge_budget_accounts SET reserved_micro_usd = 1234 WHERE mode = 'production'");
      database.exec(readFileSync(new URL("../migrations/0002_attempts.sql", import.meta.url), "utf8"));
      expect(database.prepare("SELECT status, attempts FROM devday_judge_submissions ORDER BY status").all()).toEqual([
        { status: "completed", attempts: 1 },
        { status: "failed", attempts: 1 },
        { status: "processing", attempts: 1 },
        { status: "queued", attempts: 0 }
      ]);
      expect(database.prepare("SELECT reserved_micro_usd FROM devday_judge_budget_accounts WHERE mode = 'production'").get()).toEqual({ reserved_micro_usd: 1234 });
    } finally {
      database.close();
    }
  });

  it("authenticates submissions, keeps duplicate rows unchanged, and stops new work while paused", async () => {
    const { call, database, env, sent } = setup();
    expect((await call("/api/submissions", "POST", { repoUrl: "https://github.com/a/b", mode: "production" })).status).toBe(401);
    const first = await submit(call, "demo");
    expect(first.status).toBe(202);
    expect(sent).toHaveLength(1);
    const item = (await first.json() as { submission: { id: string; repo: { normalized: string }; result: null; attempts: number } }).submission;
    expect(item.repo.normalized).toBe("example/demo");
    expect(item.result).toBeNull();
    expect(item.attempts).toBe(0);
    const before = database.changes();
    const second = await submit(call, "demo");
    expect(second.status).toBe(200);
    expect((await second.json() as { submission: { id: string } }).submission.id).toBe(item.id);
    expect(database.changes()).toBe(before);
    expect(sent).toHaveLength(1);
    env.JUDGING_ENABLED = "false";
    expect((await submit(call, "demo")).status).toBe(200);
    expect((await submit(call, "paused-new")).status).toBe(410);
    expect(database.changes()).toBe(before);
    env.SUBMISSIONS_OPEN = "false";
    expect((await submit(call, "demo")).status).toBe(200);
    expect((await submit(call, "new")).status).toBe(403);
    expect(database.changes()).toBe(before);
  });

  it("enforces separate production and validation submission caps", async () => {
    const { call } = setup();
    for (let index = 0; index < 40; index += 1) {
      expect((await submit(call, `production-${index}`)).status).toBe(202);
    }
    expect((await submit(call, "overflow")).status).toBe(429);
    for (let index = 0; index < 20; index += 1) {
      expect((await submit(call, `validation-${index}`, "validation")).status).toBe(202);
    }
    expect((await submit(call, "validation-overflow", "validation")).status).toBe(429);
    expect((await submit(call, "production-0")).status).toBe(200);
  });

  it("does not write for public reads or an empty claim", async () => {
    const { call, database, env } = setup();
    const before = database.changes();
    const dashboard = await call("/api/dashboard");
    expect(dashboard.status).toBe(200);
    expect((await dashboard.json() as { budget: { limitUsd: number }; runner: { online: boolean } }).budget.limitUsd).toBe(90);
    expect((await call("/internal/runner/claim", "POST", {}, true)).status).toBe(204);
    await call("/api/ranking");
    await call("/api/recent");
    expect((await handleApiRequest(new Request("https://judge.example.com/internal/runner/claim"), env, {} as ExecutionContext)).status).toBe(404);
    expect(database.changes()).toBe(before);
  });

  it("claims once with a private lease and rejects stale or altered callbacks", async () => {
    const { call, database } = setup();
    await submit(call, "one");
    const job = await claim(call);
    expect(job?.pinnedSha).toBeNull();
    expect(await claim(call)).toBeNull();
    const publicItem = await call(`/api/submissions/${job!.submissionId}`);
    const publicBody = await publicItem.json() as { attempts: number };
    expect(publicBody.attempts).toBe(1);
    expect(JSON.stringify(publicBody)).not.toContain(job!.callbackToken);
    const payload = { submissionId: job!.submissionId, callbackToken: job!.callbackToken, outcome: { kind: "completed", result: score(20) } };
    expect((await call("/internal/scoring-callback", "POST", { ...payload, callbackToken: "wrong" }, true)).status).toBe(403);
    const first = await call("/internal/scoring-callback", "POST", payload, true);
    expect(first.status).toBe(200);
    const before = database.changes();
    expect((await call("/internal/scoring-callback", "POST", payload, true)).status).toBe(200);
    expect(database.changes()).toBe(before);
    expect((await call("/internal/scoring-callback", "POST", { ...payload, outcome: { kind: "failed", message: "changed" } }, true)).status).toBe(409);
  });

  it("requires organizer authentication and explicit confirmation for manual retry", async () => {
    const { call, database } = setup();
    const created = await submit(call, "retry-auth");
    const id = (await created.json() as { submission: { id: string } }).submission.id;
    const path = `/api/submissions/${id}/retry`;
    const before = database.changes();
    expect((await call(path, "POST", { confirm: true })).status).toBe(401);
    for (const body of [{}, { confirm: false }, { confirm: true, extra: true }, null]) {
      expect((await call(path, "POST", body, true)).status).toBe(400);
    }
    expect((await call("/api/submissions/missing/retry", "POST", { confirm: true }, true)).status).toBe(404);
    const queued = await call(path, "POST", { confirm: true }, true);
    expect(queued.status).toBe(409);
    expect((await queued.json() as { code: string }).code).toBe("retry_unavailable");
    expect(database.changes()).toBe(before);
    const job = await claim(call);
    const claimed = database.changes();
    const fresh = await call(path, "POST", { confirm: true }, true);
    expect(fresh.status).toBe(409);
    expect((await fresh.json() as { code: string }).code).toBe("retry_unavailable");
    expect(database.changes()).toBe(claimed);
    expect((await call(`/api/submissions/${job!.submissionId}`)).status).toBe(200);
  });

  it("requeues a stale lease without changing its existing budget reservation", async () => {
    const { call, database } = setup();
    const created = await submit(call, "stale-retry");
    const original = (await created.json() as { submission: { id: string; repoUrl: string; teamName: string; createdAt: string } }).submission;
    const firstJob = await claim(call);
    const reservation = {
      submissionId: original.id,
      callbackToken: firstJob!.callbackToken,
      reservationId: "stale-reservation",
      reservation: { kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 }
    };
    expect((await call("/internal/budget/reserve", "POST", reservation, true)).status).toBe(201);
    database.db.prepare("UPDATE devday_judge_submissions SET started_at = ? WHERE id = ?").run(new Date(Date.now() - 31 * 60 * 1000).toISOString(), original.id);
    const budgetBefore = database.account("production");
    const retried = await call(`/api/submissions/${original.id}/retry`, "POST", { confirm: true }, true);
    expect(retried.status).toBe(202);
    const submission = (await retried.json() as { submission: { status: string; attempts: number; startedAt: string | null; completedAt: string | null; failureMessage: string | null; result: null; repoUrl: string; teamName: string; createdAt: string } }).submission;
    expect(submission).toMatchObject({ status: "queued", attempts: 1, startedAt: null, completedAt: null, failureMessage: null, result: null });
    expect(submission.repoUrl).toBe(original.repoUrl);
    expect(submission.teamName).toBe(original.teamName);
    expect(submission.createdAt).toBe(original.createdAt);
    expect(database.account("production")).toEqual(budgetBefore);
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM devday_judge_budget_reservations WHERE submission_id = ?").get(original.id)).toMatchObject({ count: 1 });
    expect(database.db.prepare("SELECT callback_token, started_at, completed_at, pinned_sha, failure_message, result_json, outcome_json FROM devday_judge_submissions WHERE id = ?").get(original.id)).toMatchObject({ callback_token: null, started_at: null, completed_at: null, pinned_sha: null, failure_message: null, result_json: null, outcome_json: null });
    const staleCallback = { submissionId: original.id, callbackToken: firstJob!.callbackToken, outcome: { kind: "failed", message: "late" } };
    expect((await call("/internal/scoring-callback", "POST", staleCallback, true)).status).toBe(403);
    const secondJob = await claim(call);
    expect(secondJob?.submissionId).toBe(original.id);
    expect(secondJob?.callbackToken).not.toBe(firstJob?.callbackToken);
    const publicItem = await call(`/api/submissions/${original.id}`);
    expect((await publicItem.json() as { attempts: number }).attempts).toBe(2);
    expect(database.account("production")).toEqual(budgetBefore);
    expect((await call("/internal/budget/reserve", "POST", { ...reservation, callbackToken: secondJob!.callbackToken, reservationId: "new-reservation" }, true)).status).toBe(201);
    expect(database.account("production").reserved_micro_usd).toBe(2_000_000);
  });

  it("allows failed submissions while intake is closed and stops after three claims", async () => {
    const { call, env, database } = setup();
    const created = await submit(call, "failed-retry");
    const id = (await created.json() as { submission: { id: string } }).submission.id;
    env.SUBMISSIONS_OPEN = "false";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job = await claim(call);
      expect(job?.submissionId).toBe(id);
      expect((await call("/internal/scoring-callback", "POST", { submissionId: id, callbackToken: job!.callbackToken, outcome: { kind: "failed", message: "failed" } }, true)).status).toBe(200);
      const response = await call(`/api/submissions/${id}/retry`, "POST", { confirm: true }, true);
      expect(response.status).toBe(attempt < 3 ? 202 : 409);
      if (attempt < 3) {
        expect((await response.json() as { submission: { status: string; attempts: number } }).submission).toMatchObject({ status: "queued", attempts: attempt });
      } else {
        expect((await response.json() as { code: string }).code).toBe("retry_limit");
      }
    }
    expect(await claim(call)).toBeNull();
    expect((await call(`/api/submissions/${id}`)).status).toBe(200);
    expect(database.db.prepare("SELECT attempts, status FROM devday_judge_submissions WHERE id = ?").get(id)).toMatchObject({ attempts: 3, status: "failed" });
    database.db.prepare("UPDATE devday_judge_submissions SET status = 'queued' WHERE id = ?").run(id);
    expect(await claim(call)).toBeNull();
    const completed = await submit(call, "closed-new");
    expect(completed.status).toBe(403);
  });

  it("never retries a completed submission", async () => {
    const { call, database } = setup();
    await submit(call, "complete-retry");
    const job = await claim(call);
    expect((await call("/internal/scoring-callback", "POST", { submissionId: job!.submissionId, callbackToken: job!.callbackToken, outcome: { kind: "completed", result: score(20) } }, true)).status).toBe(200);
    const before = database.changes();
    const response = await call(`/api/submissions/${job!.submissionId}/retry`, "POST", { confirm: true }, true);
    expect(response.status).toBe(409);
    expect((await response.json() as { code: string }).code).toBe("retry_unavailable");
    expect(database.changes()).toBe(before);
  });

  it("lets only one of two concurrent manual retries update the row", async () => {
    const { call, database } = setup();
    await submit(call, "retry-race");
    const job = await claim(call);
    expect((await call("/internal/scoring-callback", "POST", { submissionId: job!.submissionId, callbackToken: job!.callbackToken, outcome: { kind: "failed", message: "failed" } }, true)).status).toBe(200);
    const before = database.changes();
    const budgetBefore = database.account("production");
    const path = `/api/submissions/${job!.submissionId}/retry`;
    const responses = await Promise.all([call(path, "POST", { confirm: true }, true), call(path, "POST", { confirm: true }, true)]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(database.changes() - before).toBe(1);
    expect(database.account("production")).toEqual(budgetBefore);
    expect(database.db.prepare("SELECT status, attempts FROM devday_judge_submissions WHERE id = ?").get(job!.submissionId)).toMatchObject({ status: "queued", attempts: 1 });
  });

  it("isolates validation mode and never ranks it", async () => {
    const { call, database } = setup();
    await submit(call, "same", "production");
    await submit(call, "same", "validation");
    const validation = await claim(call, "validation");
    expect(validation?.mode).toBe("validation");
    const reservation = {
      submissionId: validation!.submissionId,
      callbackToken: validation!.callbackToken,
      reservationId: "validation-reservation",
      reservation: { kind: "decisions", model: "gpt-6-luna", maxInputTokens: 100, maxOutputTokens: 0, reservedUsd: 1 },
      mode: "production"
    };
    expect((await call("/internal/budget/reserve", "POST", reservation, true)).status).toBe(201);
    expect(database.account("production").reserved_micro_usd).toBe(0);
    expect(database.account("validation").reserved_micro_usd).toBe(1_000_000);
    expect((await call("/internal/scoring-callback", "POST", { submissionId: validation!.submissionId, callbackToken: validation!.callbackToken, outcome: { kind: "completed", result: score(40) } }, true)).status).toBe(200);
    const dashboard = await call("/api/dashboard");
    const body = await dashboard.json() as { counts: { total: number }; items: unknown[]; ranking: unknown[] };
    expect(body.counts.total).toBe(1);
    expect(body.items).toHaveLength(2);
    expect(body.ranking).toHaveLength(0);
  });

  it("reserves and settles exact microUSD amounts without duplicate writes", async () => {
    const { call, database } = setup();
    await submit(call, "budget");
    const job = await claim(call);
    const reservation = { kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 1000, maxOutputTokens: 100, reservedUsd: 1.25 };
    const request = { submissionId: job!.submissionId, callbackToken: job!.callbackToken, reservationId: "reserve-1", reservation };
    expect((await call("/internal/budget/reserve", "POST", request, true)).status).toBe(201);
    expect(database.account("production").reserved_micro_usd).toBe(1_250_000);
    const before = database.changes();
    expect((await call("/internal/budget/reserve", "POST", request, true)).status).toBe(200);
    expect(database.changes()).toBe(before);
    expect((await call("/internal/budget/reserve", "POST", { ...request, reservation: { ...reservation, reservedUsd: 2 } }, true)).status).toBe(409);
    const usage = { kind: "responses", model: "gpt-6.1-sol", reservationId: "reserve-1", inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.75 };
    const settlement = { submissionId: job!.submissionId, callbackToken: job!.callbackToken, reservationId: "reserve-1", usage };
    expect((await call("/internal/budget/settle", "POST", settlement, true)).status).toBe(200);
    expect(database.account("production")).toMatchObject({ reserved_micro_usd: 0, spent_micro_usd: 750_000 });
    const settled = database.changes();
    expect((await call("/internal/budget/settle", "POST", settlement, true)).status).toBe(200);
    expect(database.changes()).toBe(settled);
    expect((await call("/internal/budget/settle", "POST", { ...settlement, usage: { ...usage, costUsd: 0.5 } }, true)).status).toBe(409);
    expect((await call("/internal/budget/settle", "POST", { ...settlement, usage: { ...usage, cachedInputTokens: 101 } }, true)).status).toBe(400);
  });

  it("rejects nonfinite usage and bounds concurrent reservations by the account", async () => {
    const { call, database } = setup();
    await submit(call, "race");
    const job = await claim(call);
    const request = (reservationId: string, reservedUsd = 60) => ({
      submissionId: job!.submissionId,
      callbackToken: job!.callbackToken,
      reservationId,
      reservation: { kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 1, maxOutputTokens: 1, reservedUsd }
    });
    const responses = await Promise.all(["a", "b"].map((id) => call("/internal/budget/reserve", "POST", request(id), true)));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 402]);
    expect(database.account("production").reserved_micro_usd).toBe(60_000_000);
    const bad = `{"submissionId":"${job!.submissionId}","callbackToken":"${job!.callbackToken}","reservationId":"a","usage":{"kind":"responses","model":"gpt-6.1-sol","inputTokens":1,"outputTokens":1,"cachedInputTokens":0,"costUsd":1e999}}`;
    expect((await call("/internal/budget/settle", "POST", bad, true)).status).toBe(400);
    const duplicate = await Promise.all([
      call("/internal/budget/reserve", "POST", request("same-id", 20), true),
      call("/internal/budget/reserve", "POST", request("same-id", 20), true)
    ]);
    expect(duplicate.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(database.account("production").reserved_micro_usd).toBe(80_000_000);
  });

  it("keeps every submission tied at the tenth-place cutoff", async () => {
    const { call } = setup();
    for (let index = 0; index < 11; index += 1) {
      await submit(call, `team-${index}`);
      const job = await claim(call);
      const result = score(index < 9 ? 20 : 10);
      expect((await call("/internal/scoring-callback", "POST", { submissionId: job!.submissionId, callbackToken: job!.callbackToken, outcome: { kind: "completed", result } }, true)).status).toBe(200);
    }
    const dashboard = await call("/api/dashboard");
    const body = await dashboard.json() as { ranking: Array<{ rank: number; finalist: boolean; tiedAtCutoff: boolean }>; cutoff: { score: number; tied: boolean; tiedCount: number } };
    expect(body.ranking).toHaveLength(11);
    expect(body.ranking.filter((item) => item.finalist)).toHaveLength(11);
    expect(body.ranking.slice(-2).map((item) => item.rank)).toEqual([10, 10]);
    expect(body.ranking.slice(-2).every((item) => item.tiedAtCutoff)).toBe(true);
    expect(body.cutoff).toEqual({ score: 10, tied: true, tiedCount: 2 });
  });

  it("accepts concurrent identical callbacks and settlements exactly once", async () => {
    const { call, database } = setup();
    await submit(call, "concurrent");
    const job = await claim(call);
    const ownership = { submissionId: job!.submissionId, callbackToken: job!.callbackToken };
    const reservation = { ...ownership, reservationId: "concurrent-reservation", reservation: { kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 } };
    expect((await call("/internal/budget/reserve", "POST", reservation, true)).status).toBe(201);
    const settlement = { ...ownership, reservationId: "concurrent-reservation", usage: { kind: "responses", model: "gpt-6.1-sol", inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.0003 } };
    const responses = await Promise.all([call("/internal/budget/settle", "POST", settlement, true), call("/internal/budget/settle", "POST", settlement, true)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(database.account("production")).toMatchObject({ spent_micro_usd: 300, reserved_micro_usd: 0 });
    const payload = { ...ownership, outcome: { kind: "completed", result: score(20) } };
    const before = database.changes();
    const callbacks = await Promise.all([call("/internal/scoring-callback", "POST", payload, true), call("/internal/scoring-callback", "POST", payload, true)]);
    expect(callbacks.map((response) => response.status)).toEqual([200, 200]);
    expect(database.changes() - before).toBe(1);
  });

  it("validates token ceilings, model prices, and cache write costs", async () => {
    const { call, database } = setup();
    await submit(call, "pricing");
    const job = await claim(call);
    const ownership = { submissionId: job!.submissionId, callbackToken: job!.callbackToken, reservationId: "pricing-reservation" };
    const reservation = { kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 1000, maxOutputTokens: 100, reservedUsd: 1 };
    expect((await call("/internal/budget/reserve", "POST", { ...ownership, reservation: { ...reservation, model: "gpt-6-astra" } }, true)).status).toBe(400);
    expect((await call("/internal/budget/reserve", "POST", { ...ownership, reservation: { ...reservation, reservedUsd: 0.000001 } }, true)).status).toBe(400);
    expect((await call("/internal/budget/reserve", "POST", { ...ownership, reservation }, true)).status).toBe(201);
    const usage = { kind: "responses", model: "gpt-6.1-sol", inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, cacheWriteInputTokens: 30, costUsd: 0.000277, requestId: null };
    const before = database.changes();
    expect((await call("/internal/budget/settle", "POST", { ...ownership, usage: { ...usage, costUsd: 0.000001 } }, true)).status).toBe(409);
    expect((await call("/internal/budget/settle", "POST", { ...ownership, usage: { ...usage, inputTokens: 1001 } }, true)).status).toBe(409);
    expect((await call("/internal/budget/settle", "POST", { ...ownership, usage: { ...usage, outputTokens: 101 } }, true)).status).toBe(409);
    expect((await call("/internal/budget/settle", "POST", { ...ownership, usage: { ...usage, cachedInputTokens: 80 } }, true)).status).toBe(400);
    expect(database.changes()).toBe(before);
    expect((await call("/internal/budget/settle", "POST", { ...ownership, usage }, true)).status).toBe(200);
    expect(database.account("production")).toMatchObject({ spent_micro_usd: 277, reserved_micro_usd: 0 });
  });

  it("blocks new billable reservations when the runner is disabled and still accepts charged usage", async () => {
    const { call, env, database } = setup();
    await submit(call, "stop");
    const job = await claim(call);
    const ownership = { submissionId: job!.submissionId, callbackToken: job!.callbackToken, reservationId: "before-stop" };
    const reservation = { kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 };
    expect((await call("/internal/budget/reserve", "POST", { ...ownership, reservation }, true)).status).toBe(201);
    env.JUDGING_ENABLED = "false";
    const before = database.changes();
    expect((await call("/internal/budget/reserve", "POST", { ...ownership, reservationId: "after-stop", reservation }, true)).status).toBe(410);
    expect(database.changes()).toBe(before);
    const usage = { kind: "responses", model: "gpt-6.1-sol", inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.0003 };
    expect((await call("/internal/budget/settle", "POST", { ...ownership, usage }, true)).status).toBe(200);
    expect(database.account("production")).toMatchObject({ spent_micro_usd: 300, reserved_micro_usd: 0 });
  });
});
