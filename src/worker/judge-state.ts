import { RUNNER_ONLINE_WINDOW_MS, SCORER_BUCKET_COUNT } from "../shared/constants";
import { jsonResponse } from "../shared/json";
import type { AppStateSnapshot, FinalizePayload, StateWriteBudgetStatus, SubmissionRecord, SubmitJobInput, WriteBudgetExceededResult } from "../shared/types";
import { DurableObject } from "cloudflare:workers";
import { applyStatePersistence, pruneExpiredCooldowns } from "./state-persistence";
import { claimJob, createInitialSnapshot, finalizeJob, getRanking, getRecentSubmissions, recoverProcessingJobs, submitJob, toPublicSubmission } from "./state-machine";
import { getStateWriteBudgetStatus, prepareStateWriteBudget, resolveStateWriteBudgetConfig, type StateWriteBudgetDecision } from "./state-write-budget";

const STORAGE_MULTI_KEY_LIMIT = 128;

export class JudgeState extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/heartbeat") {
      const body = (await request.json()) as { nowIso: string };
      const before = await this.loadMeta();
      const snapshot = structuredClone(before);
      snapshot.runnerLastSeenAt = body.nowIso;
      const budgetResponse = await this.save(before, snapshot);
      if (budgetResponse) {
        return budgetResponse;
      }
      return jsonResponse({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/write-budget") {
      const snapshot = await this.loadMeta();
      return jsonResponse(
        getStateWriteBudgetStatus(snapshot, new Date().toISOString(), resolveStateWriteBudgetConfig(this.env))
      );
    }

    if (request.method === "GET" && url.pathname === "/runner-status") {
      const snapshot = await this.loadMeta();
      const lastSeenAt = snapshot.runnerLastSeenAt;
      const online = Boolean(
        lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() <= RUNNER_ONLINE_WINDOW_MS
      );
      return jsonResponse({ online, lastSeenAt });
    }

    if (request.method === "GET" && url.pathname.startsWith("/submission/")) {
      const id = url.pathname.split("/").at(-1) ?? "";
      const submission = await this.ctx.storage.get<SubmissionRecord>(`job:${id}`);
      return submission
        ? jsonResponse(toPublicSubmission(submission))
        : jsonResponse({ error: "Not found" }, { status: 404 });
    }

    if (request.method === "GET" && url.pathname === "/recent") {
      const meta = await this.loadMeta();
      const snapshot = await this.loadJobs(meta, meta.recentIds);
      return jsonResponse({ items: getRecentSubmissions(snapshot) });
    }

    if (request.method === "GET" && url.pathname === "/ranking") {
      const meta = await this.loadMeta();
      const snapshot = await this.loadJobs(meta, Object.values(meta.repoLatestCompleted));
      return jsonResponse({ items: getRanking(snapshot, unrankedOwners(this.env)) });
    }

    if (request.method === "POST" && url.pathname === "/submit") {
      const body = (await request.json()) as SubmitJobInput;
      const before = await this.loadMeta();
      const snapshot = structuredClone(before);
      const result = submitJob(snapshot, body);
      if (result.ok) {
        pruneExpiredCooldowns(snapshot, body.nowIso);
        const budgetResponse = await this.save(before, snapshot);
        if (budgetResponse) {
          return budgetResponse;
        }
      }
      return jsonResponse(result, { status: result.ok ? 202 : 409 });
    }

    if (request.method === "POST" && url.pathname === "/finalize") {
      const body = (await request.json()) as FinalizePayload;
      const meta = await this.loadMeta();
      const before = await this.loadJobs(meta, [body.submissionId]);
      const snapshot = structuredClone(before);
      const result = finalizeJob(snapshot, body);
      if (result.ok) {
        const budgetResponse = await this.save(before, snapshot);
        if (budgetResponse) {
          return budgetResponse;
        }
      }
      return jsonResponse(result, { status: result.ok ? 200 : 409 });
    }

    if (request.method === "POST" && url.pathname === "/claim") {
      const body = (await request.json()) as { callbackBaseUrl: string; nowIso: string };
      const meta = await this.loadMeta();
      if (Object.values(meta.bucketQueues).every((queue) => queue.length === 0)) {
        return new Response(null, { status: 204 });
      }
      const before = await this.loadClaimState(meta);
      const snapshot = structuredClone(before);
      const job = claimJob(snapshot, body.callbackBaseUrl, body.nowIso);
      const budgetResponse = await this.save(before, snapshot);
      if (budgetResponse) {
        return budgetResponse;
      }
      return job ? jsonResponse({ job }) : new Response(null, { status: 204 });
    }

    if (request.method === "POST" && url.pathname === "/recover") {
      const body = (await request.json()) as { nowIso: string };
      const meta = await this.loadMeta();
      const before = await this.loadJobs(meta, Object.values(meta.repoInflight));
      const snapshot = structuredClone(before);
      const recovered = recoverProcessingJobs(snapshot, body.nowIso);
      if (recovered > 0) {
        const budgetResponse = await this.save(before, snapshot);
        if (budgetResponse) {
          return budgetResponse;
        }
      }
      return jsonResponse({ ok: true, recovered });
    }

    return jsonResponse({ error: "Not found" }, { status: 404 });
  }

  private async loadMeta(): Promise<AppStateSnapshot> {
    const meta = await this.ctx.storage.get<Omit<AppStateSnapshot, "jobs">>("meta");
    return meta
      ? {
          ...meta,
          acceptedSubmissions: Number.isSafeInteger(meta.acceptedSubmissions)
            && meta.acceptedSubmissions >= 0
            ? meta.acceptedSubmissions
            : Number.MAX_SAFE_INTEGER,
          runnerLastSeenAt: meta.runnerLastSeenAt ?? null,
          jobs: {}
        }
      : createInitialSnapshot();
  }

  private async loadJobs(snapshot: AppStateSnapshot, ids: readonly string[]): Promise<AppStateSnapshot> {
    const keys = Array.from(new Set(ids)).map((id) => `job:${id}`);
    if (keys.length === 0) {
      return snapshot;
    }
    const jobs: Record<string, SubmissionRecord> = {};
    for (let index = 0; index < keys.length; index += STORAGE_MULTI_KEY_LIMIT) {
      const storedJobs = await this.ctx.storage.get<SubmissionRecord>(
        keys.slice(index, index + STORAGE_MULTI_KEY_LIMIT)
      );
      for (const [key, value] of storedJobs) {
        jobs[key.slice(4)] = value;
      }
    }
    snapshot.jobs = jobs;
    return snapshot;
  }

  private async loadClaimState(snapshot: AppStateSnapshot): Promise<AppStateSnapshot> {
    for (let bucket = 0; bucket < SCORER_BUCKET_COUNT; bucket += 1) {
      for (const id of snapshot.bucketQueues[String(bucket)] ?? []) {
        const job = await this.ctx.storage.get<SubmissionRecord>(`job:${id}`);
        if (job) {
          snapshot.jobs[id] = job;
        }
        if (job?.status === "queued") {
          return snapshot;
        }
      }
    }
    return snapshot;
  }

  private async save(
    before: AppStateSnapshot,
    after: AppStateSnapshot
  ): Promise<Response | null> {
    const decision = prepareStateWriteBudget(
      before,
      after,
      new Date().toISOString(),
      resolveStateWriteBudgetConfig(this.env)
    );
    if (decision.kind === "noop") {
      return null;
    }
    if (decision.kind === "exceeded") {
      if (decision.markerPlan) {
        await applyStatePersistence(this.ctx.storage, decision.markerPlan);
        this.logWriteBudget(decision);
      }
      return writeBudgetExceededResponse(decision.status);
    }
    await applyStatePersistence(this.ctx.storage, decision.plan);
    this.logWriteBudget(decision);
    return null;
  }

  private logWriteBudget(decision: Exclude<StateWriteBudgetDecision, { kind: "noop" }>): void {
    if (decision.logWarning) {
      console.warn(JSON.stringify({
        event: "durable_object_write_budget_warning",
        utcDate: decision.status.utcDate,
        rowsWritten: decision.status.rowsWritten,
        warningRows: decision.status.warningRows,
        hardLimitRows: decision.status.hardLimitRows
      }));
    }
    if (decision.logHardLimit) {
      console.error(JSON.stringify({
        event: "durable_object_write_budget_exhausted",
        utcDate: decision.status.utcDate,
        rowsWritten: decision.status.rowsWritten,
        hardLimitRows: decision.status.hardLimitRows,
        exhaustedAt: decision.status.exhaustedAt
      }));
    }
  }
}

function unrankedOwners(env: Env): string[] {
  return (env.UNRANKED_OWNERS ?? "")
    .split(",")
    .map((owner) => owner.trim().toLowerCase())
    .filter(Boolean);
}

function writeBudgetExceededResponse(writeBudget: StateWriteBudgetStatus): Response {
  const result: WriteBudgetExceededResult = {
    ok: false,
    code: "write_budget_exhausted",
    message: "Durable Object write budget exhausted",
    writeBudget
  };
  return jsonResponse(result, { status: 507 });
}
