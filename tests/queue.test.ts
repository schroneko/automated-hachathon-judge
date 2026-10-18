import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRITERIA, EVENT_ID } from "../src/shared/constants";
import { implementationEligibility, prepareFullSourceSnapshot } from "../src/shared/validation";
import type { ExplanationQueueMessage, FreezeQueueMessage, LeaseJob, PublicScoreResult, RecoveryQueueMessage, RepoEvidenceSnapshot, ScoringQueueMessage } from "../src/shared/types";
import type { ScoringOptions } from "../src/container/scorer";
import { processFreezeMessage } from "../src/worker/batches";

const scorer = vi.hoisted(() => ({ scoreSubmissionDecisions: vi.fn(), explainScoredSnapshot: vi.fn() }));
vi.mock("../src/container/scorer", () => ({
  scoreSubmissionDecisions: async (job: LeaseJob, options: ScoringOptions) => {
    const snapshot: RepoEvidenceSnapshot = { fullSource: true, repo: job.repo, pinnedSha: job.pinnedSha, defaultBranch: job.defaultBranch, summary: job.summary, assessment: "scored", files: [{ path: "README.md", size: 8, content: "evidence", truncated: false }, { path: "src/main.ts", size: 8, content: "export{}", truncated: false }] };
    let saved = false;
    let measured = false;
    const beforeSnapshot = async (value: RepoEvidenceSnapshot) => {
      if (!measured) {
        options.onSnapshotBytes?.(new TextEncoder().encode((await prepareFullSourceSnapshot(value)).serialized).byteLength);
        measured = true;
      }
      await options.beforeSnapshot?.(value);
      saved = true;
    };
    const result = await scorer.scoreSubmissionDecisions(job, { ...options, beforeSnapshot, beforeCall: async (value) => { if (!saved) await beforeSnapshot(snapshot); return options.beforeCall?.(value); } });
    const scored = result && "snapshot" in result ? result : { result, snapshot };
    if (!saved) await beforeSnapshot(scored.snapshot);
    const prepared = await prepareFullSourceSnapshot(scored.snapshot);
    return { ...scored, result: { ...scored.result, eligibility: implementationEligibility(scored.snapshot), ...(scored.result?.usage ? { usage: { ...scored.result.usage, ...prepared.metadata } } : {}) } };
  },
  explainScoredSnapshot: scorer.explainScoredSnapshot
}));
vi.mock("../src/container/github", () => ({ resolveRepoAuthority: vi.fn(async () => ({ assessment: "scored", pinnedSha: "a".repeat(40), defaultBranch: "main", summary: "snapshot" })) }));

import { callback, claimQueueMessage, claimRecoveryMessage, handleApiRequest, validRecoveryMessage } from "../src/worker/api";
import type { SubmissionRow } from "../src/worker/api";
import { processExplanationMessage, processRecoveryMessage, processScoringMessage } from "../src/worker/queue";
import { loadEvidenceSnapshot, persistEvidenceSnapshot } from "../src/worker/evidence-store";
import { persistDecisions } from "../src/worker/explanations";
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

  row(id: string): SubmissionRow {
    return this.db.prepare("SELECT * FROM devday_judge_submissions WHERE id = ?").get(id) as unknown as SubmissionRow;
  }

  account(mode: string): { spent_micro_usd: number; reserved_micro_usd: number } {
    return this.db.prepare("SELECT * FROM devday_judge_budget_accounts WHERE mode = ?").get(mode) as { spent_micro_usd: number; reserved_micro_usd: number };
  }
}

function score(): PublicScoreResult {
  return {
    summary: "summary", publicReason: "reason", repoAssessment: "scored", pinnedSha: "a".repeat(40),
    criteria: CRITERIA.map((item) => ({ key: item.key, label: item.label, score: 8, reason: "reason", evidencePaths: [] })),
    total: 32, attackScore: null,
    usage: { model: "gpt-6-luna", decisionsModel: "gpt-6-luna", effort: "medium", inputTokens: 100, outputTokens: 0, costUsd: 0.00001, decisionsScores: { technical: 8, ux: 8, impact: 8, idea: 8 }, requestIds: [] }
  };
}

function explained(fixed: PublicScoreResult): PublicScoreResult {
  return { ...fixed, summary: "理由生成済み", publicReason: "評価理由", reviewRequired: false,
    criteria: fixed.criteria.map((item) => ({ ...item, reason: "保存した根拠に基づく評価です", evidencePaths: ["README.md"] })),
    usage: { ...fixed.usage!, explanationModel: "gpt-6.1-sol" } };
}

function setup() {
  const database = new SqliteD1();
  const sent: ScoringQueueMessage[] = [];
  const controls: FreezeQueueMessage[] = [];
  const explanations: ExplanationQueueMessage[] = [];
  const recoveries: RecoveryQueueMessage[] = [];
  let sendError = false;
  const env = {
    JUDGE_DB: database,
    SCORING_QUEUE: { send: async (message: ScoringQueueMessage | FreezeQueueMessage | RecoveryQueueMessage) => { if ("type" in message && message.type === "freeze_batch") { controls.push(message); return; } if ("type" in message) recoveries.push(message); else sent.push(message); if (sendError) throw new Error("ambiguous send"); } },
    EXPLANATION_QUEUE: { send: async (message: ExplanationQueueMessage) => { explanations.push(message); } },
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
  async function create(name: string, mode: "production" | "validation" = "production", effort?: "low" | "medium" | "high") {
    const response = await api("/api/submissions", "POST", { repoUrl: `https://github.com/example/${name}`, mode, submittedAt: "2026-10-18T08:15:00.000Z", ...(effort ? { effort } : {}) }, true);
    if (response.status === 202) await processFreezeMessage(controls.at(-1)!, env);
    const body = await response.json() as { submission?: { id: string } };
    return { response, id: body.submission?.id ?? "" };
  }
  return { database, env, sent, explanations, recoveries, api, create, setSendError: (value: boolean) => { sendError = value; } };
}

async function queuedRecovery(attempt = 1, mode: "production" | "validation" = "production") {
  const fixture = setup();
  const { id } = await fixture.create("recovery", mode);
  const original = (await claimQueueMessage(fixture.sent[0]!, fixture.env))!;
  fixture.database.db.prepare("UPDATE devday_judge_submissions SET attempts = ?, dispatch_count = ?, updated_at = '2026-10-18T08:55:00.000Z' WHERE id = ?").run(attempt, attempt, id);
  const response = await fixture.api(`/api/submissions/${id}/recover`, "POST", { confirm: true });
  expect(response.status).toBe(202);
  return { ...fixture, id, original, message: fixture.recoveries[0]! };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-18T09:00:00.000Z"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); scorer.scoreSubmissionDecisions.mockReset(); scorer.explainScoredSnapshot.mockReset(); });

describe("cloud queue runtime", () => {
  it("claims a recovery exactly once with the exact generation while leaving normal attempts unchanged", async () => {
    const { database, env, id, original, message } = await queuedRecovery();
    const before = database.changes();
    const invalid = [null, {}, { ...message, extra: true }, { ...message, type: "other" }, { ...message, eventId: "other" }, { ...message, mode: "validation" }, { ...message, submissionId: "missing" }, { ...message, attempt: 0 }, { ...message, attempt: 4 }, { ...message, attempt: 2 }, { ...message, dispatch: 2 }, { ...message, callbackToken: original.callbackToken }, { ...message, callbackToken: "" }, { ...message, callbackToken: 1 }];
    for (const value of invalid) await processRecoveryMessage(value, env);
    expect(database.changes()).toBe(before);
    expect(scorer.scoreSubmissionDecisions).not.toHaveBeenCalled();
    await processScoringMessage({ eventId: EVENT_ID, submissionId: id, mode: "production", attempt: 1, dispatch: 1 }, env);
    expect(database.changes()).toBe(before);
    const claims = await Promise.all([claimRecoveryMessage(message, env), claimRecoveryMessage(message, env)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ callbackToken: message.callbackToken, pinnedSha: original.pinnedSha, frozenResolution: original.frozenResolution });
    expect(database.row(id)).toMatchObject({ status: "processing", attempts: 1, dispatch_count: 1, recovery_dispatch_count: 1, started_at: new Date().toISOString() });
    const claimed = database.changes();
    await processRecoveryMessage(message, env);
    expect(database.changes()).toBe(claimed);
    expect(validRecoveryMessage(message)).toBe(true);
  });

  it.each(["reservation", "manifest", "inline", "chunk", "barrier", "scored"])("rechecks %s before recovery claim without writes", async (kind) => {
    const { database, env, id, message } = await queuedRecovery();
    if (kind === "reservation") database.db.prepare("INSERT INTO devday_judge_budget_reservations (id, submission_id, callback_token, mode, kind, model, max_input_tokens, max_output_tokens, reserved_micro_usd, actual_micro_usd, status, created_at) VALUES ('late', ?, 'old', 'production', 'decisions', 'gpt-6-luna', 1, 0, 1, 0, 'settled', 'before')").run(id);
    if (kind === "manifest") database.db.prepare("INSERT INTO devday_judge_evidence_manifests VALUES (?, ?, 1, 'old', NULL, ?, 1, 1, 0)").run(id, EVENT_ID, "0".repeat(64));
    if (kind === "chunk") {
      database.db.exec("PRAGMA foreign_keys = OFF");
      database.db.prepare("INSERT INTO devday_judge_evidence_chunks VALUES (?, ?, 1, 'old', 0, ?)").run(id, EVENT_ID, Buffer.from("x"));
      database.db.exec("PRAGMA foreign_keys = ON");
    }
    if (kind === "inline") database.db.prepare("UPDATE devday_judge_submissions SET evidence_snapshot_json = '{}' WHERE id = ?").run(id);
    if (kind === "scored") database.db.prepare("UPDATE devday_judge_submissions SET decisions_result_json = '{}' WHERE id = ?").run(id);
    if (kind === "barrier") database.db.prepare("UPDATE devday_judge_batches SET status = 'freezing' WHERE id = ?").run(database.row(id).batch_id);
    const before = database.changes();
    expect(await claimRecoveryMessage(message, env)).toBeNull();
    expect(database.changes()).toBe(before);
  });

  it("blocks recovery processing while paused and consumes ambiguous enqueue failure without replay", async () => {
    const fixture = setup();
    const { id } = await fixture.create("recovery-ambiguous");
    await claimQueueMessage(fixture.sent[0]!, fixture.env);
    fixture.database.db.prepare("UPDATE devday_judge_submissions SET updated_at = '2026-10-18T08:55:00.000Z' WHERE id = ?").run(id);
    fixture.setSendError(true);
    expect((await fixture.api(`/api/submissions/${id}/recover`, "POST", { confirm: true })).status).toBe(503);
    expect(fixture.database.row(id)).toMatchObject({ status: "failed", attempts: 1, dispatch_count: 1, recovery_dispatch_count: 1, recovery_requested_at: new Date().toISOString() });
    const before = fixture.database.changes();
    await processRecoveryMessage(fixture.recoveries[0], fixture.env);
    expect((await fixture.api(`/api/submissions/${id}/recover`, "POST", { confirm: true })).status).toBe(409);
    expect(fixture.database.changes()).toBe(before);
    expect(fixture.recoveries).toHaveLength(1);
    const paused = await queuedRecovery();
    for (const flag of ["SUBMISSIONS_OPEN", "JUDGING_ENABLED"] as const) {
      paused.env[flag] = "false";
      const unchanged = paused.database.changes();
      await processRecoveryMessage(paused.message, paused.env);
      expect(paused.database.changes()).toBe(unchanged);
      paused.env[flag] = "true";
    }
    expect(scorer.scoreSubmissionDecisions).not.toHaveBeenCalled();
  });

  it.each(["reservation", "manifest", "inline", "barrier", "token", "attempt", "status", "count"])("atomically fences a %s race at recovery claim", async (kind) => {
    const { database, env, id, message } = await queuedRecovery();
    const prepare = database.prepare.bind(database);
    let injected = false;
    let afterRace = 0;
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      const prepared = prepare(sql);
      if (!sql.startsWith("UPDATE devday_judge_submissions SET status = 'processing', started_at")) return prepared;
      return { bind(...values: unknown[]) {
        const statement = prepared.bind(...values);
        return { ...statement, async first<T>() {
          injected = true;
          if (kind === "reservation") database.db.prepare("INSERT INTO devday_judge_budget_reservations (id, submission_id, callback_token, mode, kind, model, max_input_tokens, max_output_tokens, reserved_micro_usd, actual_micro_usd, status, created_at) VALUES ('race', ?, 'old', 'production', 'decisions', 'gpt-6-luna', 1, 0, 1, 0, 'settled', 'before')").run(id);
          if (kind === "manifest") database.db.prepare("INSERT INTO devday_judge_evidence_manifests VALUES (?, ?, 1, 'old', NULL, ?, 1, 1, 0)").run(id, EVENT_ID, "0".repeat(64));
          if (kind === "inline") database.db.prepare("UPDATE devday_judge_submissions SET evidence_snapshot_json = '{}' WHERE id = ?").run(id);
          if (kind === "barrier") database.db.exec("UPDATE devday_judge_batches SET frozen_at = NULL");
          if (kind === "token") database.db.prepare("UPDATE devday_judge_submissions SET callback_token = 'other' WHERE id = ?").run(id);
          if (kind === "attempt") database.db.prepare("UPDATE devday_judge_submissions SET attempts = 2 WHERE id = ?").run(id);
          if (kind === "status") database.db.prepare("UPDATE devday_judge_submissions SET status = 'processing' WHERE id = ?").run(id);
          if (kind === "count") database.db.prepare("UPDATE devday_judge_submissions SET recovery_dispatch_count = 0 WHERE id = ?").run(id);
          afterRace = database.changes();
          return statement.first<T>();
        } };
      } };
    });
    expect(await claimRecoveryMessage(message, env)).toBeNull();
    expect(injected).toBe(true);
    expect(database.changes()).toBe(afterRace);
  });

  it.each(["production", "validation"] as const)("retains the %s budget cap during recovery", async (mode) => {
    const { database, env, id, message } = await queuedRecovery(3, mode);
    const cap = mode === "production" ? 90_000_000 : 20_000_000;
    database.db.prepare("UPDATE devday_judge_budget_accounts SET spent_micro_usd = ? WHERE mode = ?").run(cap, mode);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6-luna" }] })));
    scorer.scoreSubmissionDecisions.mockImplementation(async (_job: LeaseJob, options: ScoringOptions) => {
      await options.beforeCall!({ kind: "decisions", model: "gpt-6-luna", maxInputTokens: 100, maxOutputTokens: 0, reservedUsd: 1 });
      throw new Error("Unexpected billable call");
    });
    await processRecoveryMessage(message, env);
    expect(database.row(id)).toMatchObject({ status: "failed", failure_message: "Budget exhausted", attempts: 3, dispatch_count: 3, recovery_dispatch_count: 1 });
    expect(database.account(mode)).toMatchObject({ limit_micro_usd: cap, spent_micro_usd: cap, reserved_micro_usd: 0 });
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM devday_judge_budget_reservations WHERE submission_id = ?").get(id)).toEqual({ count: 0 });
  });

  it("runs recovery through the cloud consumer with existing evidence-before-budget flow and rejects all old saves", async () => {
    const { database, env, id, original, message, explanations } = await queuedRecovery(3);
    const snapshot: RepoEvidenceSnapshot = { fullSource: true, repo: original.repo, pinnedSha: original.pinnedSha, defaultBranch: original.defaultBranch, summary: original.summary, assessment: "scored", files: [{ path: "src/main.ts", size: 8, content: "export{}", truncated: false }] };
    const before = database.changes();
    await expect(persistEvidenceSnapshot(snapshot, { ...database.row(id), callback_token: original.callbackToken }, env)).rejects.toThrow("Stale evidence lease");
    expect(await persistDecisions(original, score(), snapshot, env)).toBeNull();
    expect(database.changes()).toBe(before);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6-luna" }] })));
    scorer.scoreSubmissionDecisions.mockImplementation(async (job: LeaseJob, options: ScoringOptions) => {
      expect(job.callbackToken).toBe(message.callbackToken);
      expect(job.pinnedSha).toBe(original.pinnedSha);
      const reservationId = await options.beforeCall!({ kind: "decisions", model: "gpt-6-luna", maxInputTokens: 100, maxOutputTokens: 0, reservedUsd: 1 });
      expect(await loadEvidenceSnapshot(database.row(id), env)).not.toBeNull();
      await options.afterCall!({ kind: "decisions", model: "gpt-6-luna", reservationId, inputTokens: 100, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.00001 });
      return score();
    });
    const ack = vi.fn();
    await worker.queue({ messages: [{ body: message, ack }] } as unknown as MessageBatch<RecoveryQueueMessage>, env, {} as ExecutionContext);
    expect(ack).toHaveBeenCalledOnce();
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledOnce();
    expect(database.row(id)).toMatchObject({ attempts: 3, dispatch_count: 3, recovery_dispatch_count: 1, callback_token: message.callbackToken, pinned_sha: original.pinnedSha, explanation_status: "pending" });
    expect(explanations).toHaveLength(1);
    expect(database.account("production")).toMatchObject({ spent_micro_usd: 10, reserved_micro_usd: 0 });
    const completed = database.changes();
    await processRecoveryMessage(message, env);
    expect(await persistDecisions(original, score(), snapshot, env)).toBeNull();
    expect(database.changes()).toBe(completed);
  });

  it("acknowledges a completed or skipped Queue delivery without requesting retry", async () => {
    const { database, env, sent, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    scorer.scoreSubmissionDecisions.mockResolvedValue(score());
    const created = await create("ack");
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = { messages: [{ body: sent[0], ack, retry }] } as unknown as MessageBatch<ScoringQueueMessage>;
    await worker.queue(batch, env, {} as ExecutionContext);
    await worker.queue(batch, env, {} as ExecutionContext);
    expect(database.row(created.id)).toMatchObject({ status: "processing", explanation_status: "pending", attempts: 1 });
    expect(ack).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledTimes(1);
  });

  it.each([["validation", "low"], ["validation", "medium"], ["validation", "high"], ["production", "medium"]] as const)("scores %s with %s effort, reserves and settles", async (mode, effort) => {
    const { database, env, sent, api, create } = setup();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/models");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer scoring-secret");
      return Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] });
    });
    vi.stubGlobal("fetch", fetcher);
    scorer.scoreSubmissionDecisions.mockImplementation(async (_job: unknown, options: {
      effort: string; apiKey: string;
      beforeCall: (input: unknown) => Promise<string>;
      afterCall: (input: unknown) => Promise<void>;
    }) => {
      expect(options.effort).toBe(effort);
      expect(options.apiKey).toBe("scoring-secret");
      const reservationId = await options.beforeCall({ kind: "decisions", model: "gpt-6-luna", maxInputTokens: 100, maxOutputTokens: 0, reservedUsd: 1 });
      expect(database.account(mode).reserved_micro_usd).toBe(1_000_000);
      await options.afterCall({ kind: "decisions", model: "gpt-6-luna", reservationId, inputTokens: 100, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.00001 });
      expect(database.account(mode)).toMatchObject({ spent_micro_usd: 10, reserved_micro_usd: 0 });
      return score();
    });
    const created = await create(`success-${mode}`, mode, effort);
    expect(created.response.status).toBe(202);
    expect(sent).toEqual([{ eventId: EVENT_ID, submissionId: created.id, mode, attempt: 0, dispatch: 1 }]);
    await processScoringMessage(sent[0], env);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(database.row(created.id)).toMatchObject({ status: "processing", explanation_status: "pending", attempts: 1, scoring_effort: effort });
    const publicResponse = await api(`/api/submissions/${created.id}`);
    const publicText = await publicResponse.text();
    expect(publicText).not.toContain("scoring-secret");
    expect(publicText).not.toContain(database.row(created.id).callback_token);
    const before = database.changes();
    await processScoringMessage(sent[0], env);
    expect(database.changes()).toBe(before);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledTimes(1);
  });

  it("claims one exact message under duplicate concurrency and skips invalid identities without writes", async () => {
    const { database, env, sent, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    scorer.scoreSubmissionDecisions.mockResolvedValue(score());
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
    expect(scorer.scoreSubmissionDecisions).not.toHaveBeenCalled();
    await Promise.all([processScoringMessage(original, env), processScoringMessage(original, env)]);
    expect(database.row(first.id)).toMatchObject({ status: "processing", explanation_status: "pending", attempts: 1 });
    expect(database.row(second.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledTimes(1);
  });

  it("marks a failed producer send and ignores an ambiguously accepted message", async () => {
    const { database, env, sent, create, setSendError } = setup();
    setSendError(true);
    const created = await create("send-failure");
    expect(created.response.status).toBe(202);
    expect(database.row(sent[0]!.submissionId)).toMatchObject({ status: "failed", attempts: 0 });
    const before = database.changes();
    await processScoringMessage(sent[0], env);
    expect(database.changes()).toBe(before);
    expect(scorer.scoreSubmissionDecisions).not.toHaveBeenCalled();
  });

  it("requires manual retry and rejects an earlier attempt after requeue", async () => {
    const { database, env, sent, api, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    scorer.scoreSubmissionDecisions.mockRejectedValue(new Error("secret diagnostic"));
    const created = await create("retry");
    await processScoringMessage(sent[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(database.row(created.id).failure_message).not.toContain("secret");
    const path = `/api/submissions/${created.id}/retry`;
    expect((await api(path, "POST", { confirm: false }, true)).status).toBe(400);
    expect((await api(path, "POST", { confirm: true })).status).toBe(202);
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
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledTimes(3);
  });

  it("stops new claims and reservations while paused, retaining charged usage settlement", async () => {
    const { database, env, sent, api, create } = setup();
    const created = await create("paused");
    env.JUDGING_ENABLED = "false";
    await processScoringMessage(sent[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "failed", attempts: 0 });
    expect(scorer.scoreSubmissionDecisions).not.toHaveBeenCalled();
    expect((await api(`/api/submissions/${created.id}/retry`, "POST", { confirm: true }, true)).status).toBe(410);
    expect((await create("new-paused")).response.status).toBe(410);
  });

  it("fails before a paid call when the budget cap is exhausted", async () => {
    const { database, env, sent, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    database.db.prepare("UPDATE devday_judge_budget_accounts SET spent_micro_usd = limit_micro_usd WHERE mode = 'production'").run();
    scorer.scoreSubmissionDecisions.mockImplementation(async (_job: unknown, options: { beforeCall: (input: unknown) => Promise<string> }) => {
      await options.beforeCall({ kind: "decisions", model: "gpt-6-luna", maxInputTokens: 100, maxOutputTokens: 0, reservedUsd: 1 });
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
    scorer.scoreSubmissionDecisions.mockImplementation(async (_job: unknown, options: { beforeCall: (input: unknown) => Promise<string> }) => {
      await options.beforeCall({ kind: "decisions", model: "gpt-6-luna", maxInputTokens: 100, maxOutputTokens: 0, reservedUsd: 1 });
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
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledTimes(1);
  });

  it("fails a claimed job before scoring when Decisions is absent", async () => {
    const { database, env, sent, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }] })));
    const created = await create("models");
    await processScoringMessage(sent[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(scorer.scoreSubmissionDecisions).not.toHaveBeenCalled();
    expect(database.account("production")).toMatchObject({ spent_micro_usd: 0, reserved_micro_usd: 0 });
  });

  it.each(["medium", "high"] as const)("requires explicit %s validation and preserves earlier charges when upgrading a completed low run", async (effort) => {
    const { database, env, sent, explanations, api, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    scorer.scoreSubmissionDecisions.mockResolvedValue(score());
    const efforts: string[] = [];
    scorer.explainScoredSnapshot.mockImplementation(async (_snapshot: unknown, fixed: PublicScoreResult, options: {
      effort: string;
      beforeCall: (input: unknown) => Promise<string>;
      afterCall: (input: unknown) => Promise<void>;
    }) => {
      efforts.push(options.effort);
      const reservationId = await options.beforeCall({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 });
      await options.afterCall({ kind: "responses", model: "gpt-6.1-sol", reservationId, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.0003 });
      return { ...fixed, usage: { ...fixed.usage, explanationModel: "gpt-6.1-sol", effort: options.effort } };
    });
    const created = await create("validation-upgrade", "validation");
    await processScoringMessage(sent[0], env);
    await processExplanationMessage(explanations[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "completed", effort: "low", attempts: 1 });
    const before = database.changes();
    expect((await create("validation-upgrade", "validation", effort)).response.status).toBe(200);
    expect(database.changes()).toBe(before);
    expect(sent).toHaveLength(1);
    const path = `/api/submissions/${created.id}/retry`;
    expect((await api(path, "POST", { confirm: false, effort }, true)).status).toBe(400);
    expect((await api(path, "POST", { confirm: true }, true)).status).toBe(409);
    const requests = await Promise.all([
      api(path, "POST", { confirm: true, effort }),
      api(path, "POST", { confirm: true, effort })
    ]);
    expect(requests.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(sent).toHaveLength(1);
    expect(explanations).toHaveLength(2);
    expect(database.account("validation")).toMatchObject({ spent_micro_usd: 300, reserved_micro_usd: 0 });
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM devday_judge_budget_reservations").get()).toMatchObject({ count: 1 });
    const requeued = database.changes();
    await processScoringMessage(sent[0], env);
    expect(database.changes()).toBe(requeued);
    await Promise.all([processExplanationMessage(explanations[1], env), processExplanationMessage(explanations[1], env)]);
    expect(efforts).toEqual(["low", effort]);
    expect(database.row(created.id)).toMatchObject({ status: "completed", scoring_effort: effort, attempts: 1, explanation_dispatches: 2 });
    expect(database.account("validation")).toMatchObject({ spent_micro_usd: 600, reserved_micro_usd: 0 });
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM devday_judge_budget_reservations").get()).toMatchObject({ count: 2 });
    expect((await api(path, "POST", { confirm: true, effort }, true)).status).toBe(409);
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledTimes(1);
    expect(scorer.explainScoredSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps production medium and rejects unsupported efforts before any write or send", async () => {
    const { database, sent, api, create } = setup();
    const before = database.changes();
    for (const effort of ["low", "high", "light", null, 1]) {
      expect((await api("/api/submissions", "POST", { repoUrl: "https://github.com/example/production-effort", mode: "production", effort }, true)).status).toBe(400);
    }
    expect(database.changes()).toBe(before);
    expect(sent).toHaveLength(0);
    const created = await create("production-effort");
    expect(database.row(created.id)).toMatchObject({ effort: "high", scoring_effort: "medium" });
    expect((await api(`/api/submissions/${created.id}/retry`, "POST", { confirm: true, effort: "high" }, true)).status).toBe(400);
  });

  it("recovers a stale queued delivery once while rejecting fresh queued retries", async () => {
    const { database, env, sent, api, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    scorer.scoreSubmissionDecisions.mockResolvedValue(score());
    const created = await create("queued-recovery");
    const path = `/api/submissions/${created.id}/retry`;
    expect((await api(path, "POST", { confirm: true }, true)).status).toBe(409);
    database.db.prepare("UPDATE devday_judge_submissions SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 31 * 60 * 1000).toISOString(), created.id);
    const requests = await Promise.all([api(path, "POST", { confirm: true }, true), api(path, "POST", { confirm: true }, true)]);
    expect(requests.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(sent).toHaveLength(2);
    await Promise.all([processScoringMessage(sent[0], env), processScoringMessage(sent[1], env)]);
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledTimes(1);
    expect(database.row(created.id)).toMatchObject({ status: "processing", explanation_status: "pending", attempts: 1 });
  });

  it("fails invalid scorer output without leaving a processing lease", async () => {
    const { database, env, sent, create } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] })));
    scorer.scoreSubmissionDecisions.mockResolvedValue({ ...score(), total: 33 });
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
    expect(scorer.scoreSubmissionDecisions).not.toHaveBeenCalled();
    expect(database.row(created.id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("consumes ambiguous send failures and stops concurrent retries after three dispatches", async () => {
    const { database, env, sent, api, create, setSendError } = setup();
    setSendError(true);
    expect((await create("dispatch-failures")).response.status).toBe(202);
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
    expect(scorer.scoreSubmissionDecisions).not.toHaveBeenCalled();
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
    expect(scorer.scoreSubmissionDecisions).not.toHaveBeenCalled();
  });

  it("limits all eighty submission slots to two hundred forty sends even when every send fails", async () => {
    const { database, sent, api, create, setSendError } = setup();
    setSendError(true);
    for (const mode of ["production", "validation"] as const) {
      const limit = 40;
      for (let index = 0; index < limit; index += 1) {
        expect((await create(`all-failures-${mode}-${index}`, mode)).response.status).toBe(202);
        const id = sent.at(-1)!.submissionId;
        const path = `/api/submissions/${id}/retry`;
        expect((await api(path, "POST", { confirm: true }, true)).status).toBe(503);
        expect((await api(path, "POST", { confirm: true }, true)).status).toBe(503);
        expect((await api(path, "POST", { confirm: true }, true)).status).toBe(409);
      }
      expect((await create(`overflow-${mode}`, mode)).response.status).toBe(429);
    }
    expect(sent).toHaveLength(240);
    expect(database.db.prepare("SELECT COUNT(*) AS count, SUM(dispatch_count) AS dispatches, SUM(attempts) AS attempts FROM devday_judge_submissions").get())
      .toMatchObject({ count: 80, dispatches: 240, attempts: 0 });
    expect(scorer.scoreSubmissionDecisions).not.toHaveBeenCalled();
  });
});

describe("two-stage judging pipeline", () => {
  beforeEach(() => {
    scorer.scoreSubmissionDecisions.mockResolvedValue(score());
    scorer.explainScoredSnapshot.mockImplementation(async (_snapshot: unknown, fixed: PublicScoreResult) => explained(fixed));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("https://api.openai.com/v1/models");
      return Response.json({ data: [{ id: "gpt-6-luna" }] });
    }));
  });

  it("keeps eight small-source model calls concurrent in both queues with memory admission enabled", async () => {
    const { env, create, sent, explanations } = setup();
    function barrier() {
      let count = 0;
      let ready!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { ready = resolve; });
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      return { started, release, get count() { return count; }, async wait() { if (++count === 8) ready(); await waiting; } };
    }
    async function allStarted(gate: ReturnType<typeof barrier>, consumers: Promise<void>[]) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([gate.started, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Eight model calls did not start concurrently")), 1500); })]);
        expect(gate.count).toBe(8);
      } finally {
        clearTimeout(timer);
        gate.release();
        await Promise.all(consumers);
      }
    }
    const scoring = barrier();
    scorer.scoreSubmissionDecisions.mockImplementation(async (_job: LeaseJob, options: ScoringOptions) => {
      await options.beforeCall!({ kind: "decisions", model: "gpt-6-luna", maxInputTokens: 100, maxOutputTokens: 0, reservedUsd: 1 });
      await scoring.wait();
      return score();
    });
    for (let index = 0; index < 8; index++) await create(`parallel-small-${index}`);
    await allStarted(scoring, sent.map((message) => processScoringMessage(message, env)));
    expect(explanations).toHaveLength(8);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }] })));
    const reasons = barrier();
    scorer.explainScoredSnapshot.mockImplementation(async (_snapshot: unknown, fixed: PublicScoreResult, options: ScoringOptions) => {
      await options.beforeCall!({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 });
      await reasons.wait();
      return explained(fixed);
    });
    await allStarted(reasons, explanations.map((message) => processExplanationMessage(message, env)));
  });

  it("publishes fixed ranking before reasons and preflights only the model for each independent queue", async () => {
    const { env, database, create, sent, explanations, api } = setup();
    const created = await create("early-ranking");
    await processScoringMessage(sent[0], env);
    expect(scorer.explainScoredSnapshot).not.toHaveBeenCalled();
    const row = database.row(created.id);
    expect(row).toMatchObject({ status: "processing", explanation_status: "pending", explanation_dispatches: 1, attempts: 1 });
    expect(explanations).toEqual([{ type: "explain_submission", eventId: EVENT_ID, submissionId: created.id, attempt: 1, dispatch: 1 }]);
    const dashboard = await (await api("/api/dashboard")).json() as { scoredCount: number; counts: unknown; ranking: unknown[]; batches: unknown[] };
    expect(dashboard).toMatchObject({ scoredCount: 1, counts: { processing: 1, completed: 0, total: 1 }, ranking: [{ total: 32 }], batches: [{ scoredCount: 1, freezeRequestedAt: expect.any(String) }] });
    const publicResult = await (await api(`/api/results/${created.id}`)).text();
    expect(JSON.parse(publicResult)).toMatchObject({ frozenAt: row.frozen_at, scoredAt: row.scored_at, explanationStatus: "pending", result: { total: 32 } });
    for (const privateValue of ["evidence_snapshot_json", "decisions_result_json", "callback_token", "scoring-secret", '"content"']) expect(publicResult).not.toContain(privateValue);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("https://api.openai.com/v1/models");
      return Response.json({ data: [{ id: "gpt-6.1-sol" }] });
    }));
    const ack = vi.fn();
    await worker.queue({ messages: [{ body: explanations[0], ack }] } as unknown as MessageBatch<ExplanationQueueMessage>, env, {} as ExecutionContext);
    expect(ack).toHaveBeenCalledOnce();
    expect(row.evidence_snapshot_json).toBeNull();
    expect(scorer.explainScoredSnapshot).toHaveBeenCalledWith(await loadEvidenceSnapshot(row, env), JSON.parse(row.decisions_result_json!), expect.objectContaining({ effort: "medium" }));
    expect(database.row(created.id)).toMatchObject({ status: "completed", explanation_status: "completed", scored_at: row.scored_at, frozen_at: row.frozen_at, callback_token: row.callback_token });
    expect((JSON.parse(database.row(created.id).result_json!) as PublicScoreResult).usage).toMatchObject({ model: "gpt-6-luna", decisionsModel: "gpt-6-luna", explanationModel: "gpt-6.1-sol" });
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledOnce();
  });

  it("does no writes, calls or sends for duplicate score or explanation deliveries and invalid explanation identities", async () => {
    const { env, database, create, sent, explanations } = setup();
    const created = await create("explanation-once");
    await processScoringMessage(sent[0], env);
    const before = database.changes();
    await processScoringMessage(sent[0], env);
    const original = explanations[0]!;
    for (const message of [{ ...original, eventId: "wrong" }, { ...original, attempt: 0 }, { ...original, attempt: 2 }, { ...original, dispatch: 0 }, { ...original, dispatch: 2 }, { ...original, dispatch: 4 }, { ...original, extra: "invalid" }, { ...original, submissionId: "missing" }]) await processExplanationMessage(message, env);
    expect(database.changes()).toBe(before);
    expect(explanations).toHaveLength(1);
    expect(scorer.explainScoredSnapshot).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }] })));
    await Promise.all([processExplanationMessage(original, env), processExplanationMessage(original, env)]);
    expect(database.row(created.id).explanation_status).toBe("completed");
    const completed = database.changes();
    await processExplanationMessage(original, env);
    expect(database.changes()).toBe(completed);
    expect(scorer.explainScoredSnapshot).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["sha", "scores", "assessment", "probability", "attack", "keys", "evidence", "model", "eligibility", "source"])("rejects explanation mutation of %s while retaining scores and rank", async (field) => {
    const { env, database, create, sent, explanations, api } = setup();
    scorer.explainScoredSnapshot.mockImplementation(async (_snapshot: unknown, fixed: PublicScoreResult) => {
      const result = explained(fixed);
      if (field === "sha") result.pinnedSha = "b".repeat(40);
      if (field === "scores") { result.criteria[0]!.score = 10; result.total += 2; }
      if (field === "assessment") result.repoAssessment = "empty_repository";
      if (field === "probability") result.attackProbability = 0.2;
      if (field === "attack") result.attackScore = 90;
      if (field === "keys") result.criteria[0]!.key = "ux";
      if (field === "evidence") result.criteria[0]!.evidencePaths = ["not-collected.ts"];
      if (field === "model") result.usage!.model = "gpt-6.1-sol";
      if (field === "eligibility") result.eligibility = "no_implementation";
      if (field === "source") result.usage!.sourceHash = "0".repeat(64);
      return result;
    });
    const created = await create(`fixed-${field}`);
    await processScoringMessage(sent[0], env);
    const original = JSON.parse(database.row(created.id).result_json!);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }] })));
    await processExplanationMessage(explanations[0], env);
    const row = database.row(created.id);
    expect(row).toMatchObject({ status: "completed", explanation_status: "failed", pinned_sha: "a".repeat(40) });
    expect(JSON.parse(row.result_json!)).toEqual({ ...original, reviewRequired: true });
    expect(row.failure_message).toContain("Scores are retained");
    expect(await (await api("/api/ranking")).json()).toMatchObject({ items: [{ total: 32, pinnedSha: "a".repeat(40) }] });
    const before = database.changes();
    const response = await callback(new Request("https://internal.invalid", { method: "POST", body: JSON.stringify({ submissionId: created.id, callbackToken: row.callback_token, outcome: { kind: "failed", message: "old scoring callback" } }) }), env);
    expect(response.status).toBe(409);
    expect(database.changes()).toBe(before);
  });

  it("retains ranking on Sol outage without invoking either scorer again", async () => {
    const { env, database, create, sent, explanations } = setup();
    const created = await create("sol-outage");
    await processScoringMessage(sent[0], env);
    await processExplanationMessage(explanations[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "completed", explanation_status: "failed" });
    expect(JSON.parse(database.row(created.id).result_json!)).toMatchObject({ total: 32, reviewRequired: true });
    expect(scorer.explainScoredSnapshot).not.toHaveBeenCalled();
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledOnce();
  });

  it("consumes ambiguous explanation sends before delivery and bounds concurrent explicit retries to three lifetime sends", async () => {
    const { env, database, create, sent, explanations, api } = setup();
    env.EXPLANATION_QUEUE.send = async (message) => { explanations.push(message); throw new Error("ambiguous acceptance"); };
    const created = await create("explanation-send-failures");
    await processScoringMessage(sent[0], env);
    const saved = database.row(created.id);
    expect(saved).toMatchObject({ status: "completed", explanation_status: "failed", explanation_dispatches: 1 });
    const path = `/api/submissions/${created.id}/retry`;
    const responses = await Promise.all([api(path, "POST", { confirm: true }), api(path, "POST", { confirm: true })]);
    expect(responses.map((response) => response.status).sort()).toEqual([409, 503]);
    expect((await api(path, "POST", { confirm: true })).status).toBe(503);
    const before = database.changes();
    expect((await api(path, "POST", { confirm: true })).status).toBe(409);
    for (const message of explanations) await processExplanationMessage(message, env);
    expect(database.changes()).toBe(before);
    expect(explanations.map((message) => message.dispatch)).toEqual([1, 2, 3]);
    expect(database.row(created.id)).toMatchObject({ attempts: 1, dispatch_count: 1, explanation_dispatches: 3, callback_token: saved.callback_token, evidence_snapshot_json: saved.evidence_snapshot_json, decisions_result_json: saved.decisions_result_json, pinned_sha: saved.pinned_sha });
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledOnce();
    expect(scorer.explainScoredSnapshot).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it.each(["pending", "processing"])("recovers stale %s reasons after 30 minutes with the same score, snapshot, attempt and token", async (status) => {
    const { env, database, create, sent, explanations, api } = setup();
    const created = await create(`stale-${status}`);
    await processScoringMessage(sent[0], env);
    if (status === "processing") database.db.prepare("UPDATE devday_judge_submissions SET explanation_status = 'processing', explanation_started_at = ? WHERE id = ?").run(new Date().toISOString(), created.id);
    const saved = database.row(created.id);
    const path = `/api/submissions/${created.id}/retry`;
    expect((await api(path, "POST", { confirm: true })).status).toBe(409);
    vi.setSystemTime("2026-10-18T09:30:00.001Z");
    const responses = await Promise.all([api(path, "POST", { confirm: true }), api(path, "POST", { confirm: true })]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    const before = database.changes();
    await processExplanationMessage(explanations[0], env);
    expect(database.changes()).toBe(before);
    expect(database.row(created.id)).toMatchObject({ result_json: saved.result_json, pinned_sha: saved.pinned_sha, callback_token: saved.callback_token, scored_at: saved.scored_at, evidence_snapshot_json: saved.evidence_snapshot_json, attempts: 1, explanation_dispatches: 2, explanation_status: "pending" });
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledOnce();
  });

  it.each(["JUDGING_ENABLED", "SUBMISSIONS_OPEN"] as const)("blocks reason work and retries with %s disabled while retaining ranking", async (flag) => {
    const { env, database, create, sent, explanations, api } = setup();
    const created = await create(`explain-paused-${flag.toLowerCase()}`);
    await processScoringMessage(sent[0], env);
    env[flag] = "false";
    const beforeFetch = vi.mocked(fetch).mock.calls.length;
    await processExplanationMessage(explanations[0], env);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(beforeFetch);
    expect(scorer.explainScoredSnapshot).not.toHaveBeenCalled();
    expect(database.row(created.id)).toMatchObject({ status: "completed", explanation_status: "failed" });
    expect((await api(`/api/submissions/${created.id}/retry`, "POST", { confirm: true })).status).toBe(410);
    expect(await (await api("/api/ranking")).json()).toMatchObject({ items: [{ total: 32 }] });
  });

  it("stops reason billing at the exact budget cap without discarding Decisions scores", async () => {
    const { env, database, create, sent, explanations } = setup();
    const created = await create("explain-budget");
    await processScoringMessage(sent[0], env);
    database.db.prepare("UPDATE devday_judge_budget_accounts SET spent_micro_usd = limit_micro_usd WHERE mode = 'production'").run();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }] })));
    let paidCalls = 0;
    scorer.explainScoredSnapshot.mockImplementation(async (_snapshot: unknown, fixed: PublicScoreResult, options: ScoringOptions) => {
      await options.beforeCall!({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 });
      paidCalls++;
      return explained(fixed);
    });
    await processExplanationMessage(explanations[0], env);
    expect(paidCalls).toBe(0);
    expect(database.row(created.id)).toMatchObject({ status: "completed", explanation_status: "failed", failure_message: "Budget exhausted" });
    expect(JSON.parse(database.row(created.id).result_json!)).toMatchObject({ total: 32, reviewRequired: true });
    expect(database.account("production")).toMatchObject({ spent_micro_usd: 90_000_000, reserved_micro_usd: 0 });
  });

  it("persists a maximum escaped snapshot internally without the callback body limit or public source leakage", async () => {
    const { env, database, create, sent, explanations, api } = setup();
    scorer.scoreSubmissionDecisions.mockImplementation(async (job: LeaseJob) => ({
      result: score(), snapshot: { fullSource: true, repo: job.repo, pinnedSha: job.pinnedSha, defaultBranch: job.defaultBranch, summary: job.summary, assessment: "scored",
        files: Array.from({ length: 10 }, (_, index) => ({ path: `source-${index}.ts`, size: 12_000, content: "\u0001".repeat(12_000), truncated: false })) }
    }));
    const created = await create("snapshot-size");
    await processScoringMessage(sent[0], env);
    const row = database.row(created.id);
    expect(row).toMatchObject({ status: "processing", explanation_status: "pending" });
    expect(row.evidence_snapshot_json).toBeNull();
    const manifest = database.db.prepare("SELECT byte_count, chunk_count, complete FROM devday_judge_evidence_manifests WHERE submission_id = ?").get(created.id);
    expect(manifest).toMatchObject({ byte_count: expect.any(Number), chunk_count: 2, complete: 1 });
    expect(Number(manifest!.byte_count)).toBeGreaterThan(700_000);
    expect(explanations).toHaveLength(1);
    const publicText = await (await api(`/api/results/${created.id}`)).text();
    expect(publicText).not.toContain("source-0.ts");
    expect(publicText.length).toBeLessThan(10_000);
    const prepare = vi.spyOn(database, "prepare");
    for (const path of ["/api/dashboard", "/api/ranking", "/api/recent", `/api/submissions/${created.id}`, `/api/batches/${row.batch_id}`]) {
      const response = await api(path);
      expect(response.status).toBe(200);
      const body = await response.text();
      for (const secret of ["source-0.ts", "evidence_snapshot_json", "callback_token", "devday_judge_evidence", String(row.callback_token)]) expect(body).not.toContain(secret);
    }
    for (const [sql] of prepare.mock.calls) {
      expect(sql).not.toContain("devday_judge_evidence");
      if (sql.includes("FROM devday_judge_submissions")) {
        expect(sql).not.toContain("SELECT *");
        expect(sql).not.toContain("callback_token");
        expect(sql).not.toContain("evidence_snapshot_json");
      }
    }
  });

  it("blocks Decisions reservation and billing when the evidence batch fails", async () => {
    const { env, database, create, sent, explanations } = setup();
    const created = await create("evidence-write-failure");
    database.db.exec("CREATE TRIGGER reject_evidence BEFORE INSERT ON devday_judge_evidence_chunks BEGIN SELECT RAISE(ABORT, 'evidence unavailable'); END");
    let paidCalls = 0;
    scorer.scoreSubmissionDecisions.mockImplementation(async (_job: LeaseJob, options: ScoringOptions) => {
      await options.beforeCall!({ kind: "decisions", model: "gpt-6-luna", maxInputTokens: 100, maxOutputTokens: 0, reservedUsd: 1 });
      paidCalls++;
      return score();
    });
    await processScoringMessage(sent[0], env);
    expect(paidCalls).toBe(0);
    expect(database.row(created.id)).toMatchObject({ status: "failed", result_json: null, evidence_snapshot_json: null, explanation_dispatches: 0 });
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM devday_judge_evidence_manifests").get()!.n).toBe(0);
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM devday_judge_evidence_chunks").get()!.n).toBe(0);
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM devday_judge_budget_reservations").get()!.n).toBe(0);
    expect(explanations).toHaveLength(0);
  });

  it.each(["GitHub evidence exceeds total byte capacity", "API request exceeds conservative input or context token bound"])("reports %s as a complete-source capacity failure without paid calls", async (failure) => {
    const { env, database, create, sent, explanations } = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    scorer.scoreSubmissionDecisions.mockRejectedValue(new Error(failure));
    const created = await create("full-source-capacity");
    await processScoringMessage(sent[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "failed", result_json: null, failure_message: "全文の容量が審査上限を超えています。要確認です。ソースは途中で切らず、採点を停止しました。" });
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM devday_judge_budget_reservations").get()!.n).toBe(0);
    expect(explanations).toHaveLength(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ diagnostic: "Full repository evidence exceeds configured source or context capacity" });
  });

  it("keeps untrusted upload-pack diagnostic details out of logs", async () => {
    const { env, create, sent } = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    scorer.scoreSubmissionDecisions.mockRejectedValue(new Error("GitHub upload-pack returned an unexpected content type PRIVATE_UPSTREAM_BODY"));
    await create("sanitized-upload-pack");
    await processScoringMessage(sent[0], env);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ diagnostic: "GitHub upload-pack validation failed" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_UPSTREAM_BODY");
  });

  it("retains Decisions points for README-only evidence while excluding it from ranking", async () => {
    const { env, database, create, sent, api } = setup();
    scorer.scoreSubmissionDecisions.mockImplementation(async (job: LeaseJob) => ({ result: score(), snapshot: {
      fullSource: true, repo: job.repo, pinnedSha: job.pinnedSha, defaultBranch: job.defaultBranch, summary: job.summary, assessment: "scored",
      files: [{ path: "README.md", size: 8, content: "evidence", truncated: false }]
    } }));
    const created = await create("readme-only");
    await processScoringMessage(sent[0], env);
    expect(JSON.parse(database.row(created.id).result_json!)).toMatchObject({ total: 32, eligibility: "no_implementation" });
    expect(await (await api("/api/ranking")).json()).toEqual({ items: [] });
  });

  it("keeps legacy inline snapshots readable but refuses explanation retries and queued model work", async () => {
    const { env, database, create, sent, explanations, api } = setup();
    const created = await create("legacy-inline-evidence");
    await processScoringMessage(sent[0], env);
    const row = database.row(created.id);
    const snapshot = await loadEvidenceSnapshot(row, env);
    database.db.exec("DELETE FROM devday_judge_evidence_chunks");
    database.db.exec("DELETE FROM devday_judge_evidence_manifests");
    database.db.prepare("UPDATE devday_judge_submissions SET evidence_snapshot_json = ? WHERE id = ?").run(JSON.stringify(snapshot), created.id);
    expect((await loadEvidenceSnapshot(database.row(created.id), env))?.fullSource).toBeUndefined();
    vi.mocked(fetch).mockClear();
    await processExplanationMessage(explanations[0], env);
    expect(fetch).not.toHaveBeenCalled();
    expect(scorer.explainScoredSnapshot).not.toHaveBeenCalled();
    const before = database.changes();
    const response = await api(`/api/submissions/${created.id}/retry`, "POST", { confirm: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "explanation_snapshot_missing" });
    expect(database.changes()).toBe(before);
    expect(JSON.parse(database.row(created.id).result_json!)).toMatchObject({ total: 32, reviewRequired: true });
  });

  it("rejects damaged stored chunks before model lookup or explanation billing and preserves fixed points", async () => {
    const { env, database, create, sent, explanations, api } = setup();
    const created = await create("damaged-evidence");
    await processScoringMessage(sent[0], env);
    database.db.exec("UPDATE devday_judge_evidence_chunks SET content = zeroblob(length(content))");
    vi.mocked(fetch).mockClear();
    await processExplanationMessage(explanations[0], env);
    expect(fetch).not.toHaveBeenCalled();
    expect(scorer.explainScoredSnapshot).not.toHaveBeenCalled();
    expect(database.row(created.id)).toMatchObject({ status: "completed", explanation_status: "failed" });
    expect(JSON.parse(database.row(created.id).result_json!)).toMatchObject({ total: 32, reviewRequired: true });
    const before = database.changes();
    const retry = await api(`/api/submissions/${created.id}/retry`, "POST", { confirm: true });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ code: "explanation_snapshot_missing" });
    expect(database.changes()).toBe(before);
  });

  it("rejects more than 3MiB UTF8 evidence bytes without persisting or enqueueing the score", async () => {
    const { env, database, create, sent, explanations } = setup();
    scorer.scoreSubmissionDecisions.mockImplementation(async (job: LeaseJob) => ({
      result: score(), snapshot: { fullSource: true, repo: job.repo, pinnedSha: job.pinnedSha, defaultBranch: job.defaultBranch, summary: job.summary, assessment: "scored",
        files: Array.from({ length: 2 }, (_, index) => ({ path: `source-${index}.ts`, size: 1_800_000, content: "あ".repeat(600_000), truncated: false })) }
    }));
    const created = await create("snapshot-overflow");
    await processScoringMessage(sent[0], env);
    expect(database.row(created.id)).toMatchObject({ status: "failed", result_json: null, evidence_snapshot_json: null, explanation_dispatches: 0 });
    expect(explanations).toHaveLength(0);
  });

  it("settles delayed explanation usage after a stale manual retry while rejecting old new reservations and result writes", async () => {
    const { env, database, create, sent, explanations, api } = setup();
    const created = await create("late-explanation-charge");
    await processScoringMessage(sent[0], env);
    const original = JSON.parse(database.row(created.id).result_json!);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }] })));
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let staleOptions!: ScoringOptions;
    scorer.explainScoredSnapshot.mockImplementation(async (_snapshot: unknown, fixed: PublicScoreResult, options: ScoringOptions) => {
      staleOptions = options;
      const reservationId = await options.beforeCall!({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 });
      started();
      await waiting;
      await options.afterCall!({ kind: "responses", model: "gpt-6.1-sol", reservationId: reservationId!, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.0003 });
      return explained(fixed);
    });
    const oldConsumer = processExplanationMessage(explanations[0], env);
    await ready;
    expect(database.account("production").reserved_micro_usd).toBe(1_000_000);
    vi.setSystemTime("2026-10-18T09:31:00.000Z");
    expect((await api(`/api/submissions/${created.id}/retry`, "POST", { confirm: true })).status).toBe(202);
    const before = database.changes();
    await expect(staleOptions.beforeCall!({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 })).rejects.toThrow("Budget reservation failed");
    expect(database.changes()).toBe(before);
    env.JUDGING_ENABLED = "false";
    env.SUBMISSIONS_OPEN = "false";
    release();
    await oldConsumer;
    expect(database.account("production")).toMatchObject({ spent_micro_usd: 300, reserved_micro_usd: 0 });
    expect(database.row(created.id)).toMatchObject({ explanation_status: "pending", explanation_dispatches: 2, completed_at: null });
    expect(JSON.parse(database.row(created.id).result_json!)).toEqual(original);
    expect(database.db.prepare("SELECT status, actual_micro_usd FROM devday_judge_budget_reservations").get()).toEqual({ status: "settled", actual_micro_usd: 300 });
  });

  it("keeps an unresolved explanation reservation and scores after generation failure and retries reasons only", async () => {
    const { env, database, create, sent, explanations, api } = setup();
    const created = await create("failed-explanation-charge");
    await processScoringMessage(sent[0], env);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }] })));
    scorer.explainScoredSnapshot.mockImplementation(async (_snapshot: unknown, _fixed: PublicScoreResult, options: ScoringOptions) => {
      await options.beforeCall!({ kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 });
      throw new Error("private provider error");
    });
    await processExplanationMessage(explanations[0], env);
    expect(database.account("production")).toMatchObject({ spent_micro_usd: 0, reserved_micro_usd: 1_000_000 });
    expect(database.row(created.id).failure_message).not.toContain("private");
    expect((await api(`/api/submissions/${created.id}/retry`, "POST", { confirm: true })).status).toBe(202);
    expect(database.account("production").reserved_micro_usd).toBe(1_000_000);
    expect(database.row(created.id)).toMatchObject({ explanation_status: "pending", explanation_dispatches: 2, attempts: 1, pinned_sha: "a".repeat(40) });
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
  });

  it("allows bounded reason retries after all three scoring attempts have been consumed", async () => {
    const { env, database, create, sent, explanations, api } = setup();
    scorer.scoreSubmissionDecisions.mockRejectedValueOnce(new Error("failure one")).mockRejectedValueOnce(new Error("failure two"));
    const created = await create("last-score-attempt");
    const path = `/api/submissions/${created.id}/retry`;
    for (let index = 0; index < 2; index++) {
      await processScoringMessage(sent[index], env);
      expect((await api(path, "POST", { confirm: true })).status).toBe(202);
    }
    await processScoringMessage(sent[2], env);
    expect(database.row(created.id)).toMatchObject({ attempts: 3, dispatch_count: 3, explanation_dispatches: 1, explanation_status: "pending" });
    for (let index = 0; index < 3; index++) {
      expect(explanations[index]).toMatchObject({ attempt: 3, dispatch: index + 1 });
      await processExplanationMessage(explanations[index], env);
      expect((await api(path, "POST", { confirm: true })).status).toBe(index < 2 ? 202 : 409);
    }
    expect(database.row(created.id)).toMatchObject({ attempts: 3, dispatch_count: 3, explanation_dispatches: 3, explanation_status: "failed" });
    expect(scorer.scoreSubmissionDecisions).toHaveBeenCalledTimes(3);
    expect(scorer.explainScoredSnapshot).not.toHaveBeenCalled();
    expect(sent).toHaveLength(3);
    expect(explanations).toHaveLength(3);
  });
});
