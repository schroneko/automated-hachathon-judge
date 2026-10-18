import { resolveRepoAuthority } from "../container/github";
import { BATCH_BODY_LIMIT_BYTES, BATCH_ITEM_LIMIT, EVENT_ID, JUDGING_START_ISO, PRODUCTION_SUBMISSION_LIMIT, SUBMISSION_DEADLINE_ISO, VALIDATION_SUBMISSION_LIMIT } from "../shared/constants";
import { jsonResponse } from "../shared/json";
import { normalizeGitHubRepoUrl } from "../shared/validation";
import type { BatchStatus, FreezeQueueMessage, NormalizedRepo, PublicBatchRecord, PublicSubmissionRecord, RepoResolution, SubmissionMode } from "../shared/types";
import { judgingEnabled, PUBLIC_SUBMISSION_COLUMNS, readJson, toPublic, workEnabled, type PublicSubmissionRow, type SubmissionRow } from "./api";
import { normalizeDemoUrl, SUBMISSION_METADATA_BODY_LIMIT_BYTES } from "./submission-metadata";

interface BatchRow {
  id: string;
  event_id: string;
  mode: SubmissionMode;
  effort: "low" | "medium" | "high";
  request_json: string;
  status: BatchStatus;
  created_at: string;
  started_at: string | null;
  frozen_at: string | null;
  completed_at: string | null;
  failure_message: string | null;
  freeze_dispatches: number;
  freeze_dispatched_at: string | null;
}

interface BatchInput {
  id: string;
  mode: SubmissionMode;
  effort: "low" | "medium" | "high";
  items: Array<{ teamName: string; repo: NormalizedRepo; submittedAt: string | null; demoUrl?: string }>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid submittedAt ISO timestamp");
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day || Number(value.slice(11, 13)) > 23) throw new Error("Invalid submittedAt date");
  return new Date(value).toISOString();
}

function parseInput(value: unknown): BatchInput {
  if (!object(value) || Object.keys(value).some((key) => !["id", "mode", "effort", "items"].includes(key))) throw new Error("Invalid batch body");
  if (typeof value.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)) throw new Error("Invalid batch UUID");
  if (value.mode !== "production" && value.mode !== "validation") throw new Error("Invalid batch mode");
  const effort = value.effort === undefined ? value.mode === "production" ? "medium" : "low" : value.effort;
  if (effort !== "low" && effort !== "medium" && effort !== "high") throw new Error("Invalid scoring effort");
  if (value.mode === "production" && effort !== "medium") throw new Error("Production judging requires medium effort");
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > BATCH_ITEM_LIMIT) throw new Error("Batch requires 1 to 30 items");
  const seen = new Set<string>();
  const items = value.items.map((item: unknown) => {
    if (!object(item) || Object.keys(item).some((key) => !["teamName", "repoUrl", "submittedAt", "demoUrl"].includes(key)) || typeof item.teamName !== "string" || !item.teamName.trim() || item.teamName.trim().length > 100 || typeof item.repoUrl !== "string" || item.repoUrl.length > 512) throw new Error("Invalid batch item");
    if (!/^https:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/i.test(item.repoUrl.trim())) throw new Error("Invalid GitHub repository URL");
    const normalized = normalizeGitHubRepoUrl(item.repoUrl);
    const repo = { ...normalized, owner: normalized.owner.toLowerCase(), repo: normalized.repo.toLowerCase(), canonicalUrl: `https://github.com/${normalized.normalized}` };
    if (seen.has(repo.normalized)) throw new Error("Duplicate repository in batch");
    seen.add(repo.normalized);
    const submittedAt = item.submittedAt === undefined ? null : timestamp(item.submittedAt);
    if (value.mode === "production" && (!submittedAt || submittedAt > SUBMISSION_DEADLINE_ISO)) throw new Error("Production submittedAt must be at or before the submission deadline");
    const demoUrl = item.demoUrl === undefined ? null : normalizeDemoUrl(item.demoUrl);
    return { teamName: item.teamName.trim(), repo, submittedAt, ...(demoUrl ? { demoUrl } : {}) };
  }).sort((a, b) => a.repo.normalized.localeCompare(b.repo.normalized));
  return { id: value.id.toLowerCase(), mode: value.mode, effort, items };
}

export async function createBatch(request: Request, env: Env, single = false): Promise<Response> {
  let input: BatchInput;
  try {
    let value = await readJson(request, single ? SUBMISSION_METADATA_BODY_LIMIT_BYTES : BATCH_BODY_LIMIT_BYTES);
    if (single) {
      if (!object(value) || Object.keys(value).some((key) => !["repoUrl", "teamName", "mode", "effort", "submittedAt", "demoUrl"].includes(key))) throw new Error("Invalid submission body");
      value = { id: crypto.randomUUID(), mode: value.mode, effort: value.effort, items: [{ repoUrl: value.repoUrl, teamName: value.teamName ?? (typeof value.repoUrl === "string" ? normalizeGitHubRepoUrl(value.repoUrl).normalized : ""), ...(value.submittedAt === undefined ? {} : { submittedAt: value.submittedAt }), ...(value.demoUrl === undefined ? {} : { demoUrl: value.demoUrl }) }] };
    }
    input = parseInput(value);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Invalid batch body" }, { status: error instanceof Error && error.message === "Request body too large" ? 413 : 400 });
  }
  const canonical = JSON.stringify({ mode: input.mode, effort: input.effort, items: input.items });
  const replay = async (): Promise<Response | null> => {
    const existing = await getBatchRow(input.id, env);
    if (!existing) return null;
    return existing.request_json === canonical ? batchResponse(existing, env, single) : jsonResponse({ error: "Batch content conflict", code: "batch_conflict" }, { status: 409 });
  };
  const repeated = await replay();
  if (repeated) return repeated;
  if (single) {
    const existing = await env.JUDGE_DB.prepare(`SELECT ${PUBLIC_SUBMISSION_COLUMNS} FROM devday_judge_submissions WHERE event_id = ? AND repo_normalized = ? AND mode = ?`).bind(EVENT_ID, input.items[0]!.repo.normalized, input.mode).first<PublicSubmissionRow>();
    if (existing) return jsonResponse({ submission: toPublic(existing) });
  }
  if (env.SUBMISSIONS_OPEN?.trim().toLowerCase() !== "true") return jsonResponse({ error: "Submissions are closed" }, { status: 403 });
  if (!judgingEnabled(env)) return jsonResponse({ error: "Judging is disabled", code: "judging_disabled" }, { status: 410 });
  const now = new Date().toISOString();
  if (input.mode === "production" && now < JUDGING_START_ISO) return jsonResponse({ error: "Production judging starts at 17:30 JST", code: "judging_not_started" }, { status: 403 });
  const admission = crypto.randomUUID();
  const max = input.mode === "production" ? PRODUCTION_SUBMISSION_LIMIT : VALIDATION_SUBMISSION_LIMIT;
  const names = input.items.map((item) => item.repo.normalized);
  const placeholders = names.map(() => "?").join(",");
  try {
    const results = await env.JUDGE_DB.batch([
      env.JUDGE_DB.prepare(`INSERT INTO devday_judge_batches (id, event_id, mode, effort, request_json, admission_key, status, created_at, freeze_dispatched_at) SELECT ?, ?, ?, ?, ?, ?, 'queued', ?, ? WHERE (SELECT COUNT(*) FROM devday_judge_submissions WHERE event_id = ? AND mode = ?) + ? <= ? AND NOT EXISTS (SELECT 1 FROM devday_judge_submissions WHERE event_id = ? AND mode = ? AND repo_normalized IN (${placeholders}))`).bind(input.id, EVENT_ID, input.mode, input.effort, canonical, admission, now, now, EVENT_ID, input.mode, input.items.length, max, EVENT_ID, input.mode, ...names),
      ...input.items.map((item) => env.JUDGE_DB.prepare("INSERT INTO devday_judge_submissions (id, event_id, repo_url, repo_normalized, repo_owner, repo_name, team_name, demo_url, mode, effort, scoring_effort, status, dispatch_count, created_at, updated_at, batch_id, submitted_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM devday_judge_batches WHERE id = ? AND admission_key = ?)").bind(crypto.randomUUID(), EVENT_ID, item.repo.canonicalUrl, item.repo.normalized, item.repo.owner, item.repo.repo, item.teamName, item.demoUrl ?? null, input.mode, input.effort === "medium" ? "high" : input.effort, input.effort, now, now, input.id, item.submittedAt, input.id, admission))
    ]);
    if (!results[0]?.meta.changes) {
      const repeated = await replay();
      if (repeated) return repeated;
      const duplicate = await env.JUDGE_DB.prepare(`SELECT id FROM devday_judge_submissions WHERE event_id = ? AND mode = ? AND repo_normalized IN (${placeholders}) LIMIT 1`).bind(EVENT_ID, input.mode, ...names).first();
      return jsonResponse({ error: duplicate ? "Repository already admitted" : "Submission limit reached", code: duplicate ? "duplicate_repository" : "submission_limit" }, { status: duplicate ? 409 : 429 });
    }
  } catch (error) {
    const repeated = await replay();
    if (repeated) return repeated;
    throw error;
  }
  try {
    await env.SCORING_QUEUE.send({ type: "freeze_batch", eventId: EVENT_ID, batchId: input.id, dispatch: 1 });
  } catch {
    await failBatch(input.id, 1, "Batch freeze queue delivery failed. Retry this batch explicitly after service recovery.", env);
    return jsonResponse({ error: "Batch freeze queue send failed", code: "queue_send_failed", ...await batchPayload((await getBatchRow(input.id, env))!, env) }, { status: 503 });
  }
  return batchResponse((await getBatchRow(input.id, env))!, env, single);
}

async function getBatchRow(id: string, env: Env): Promise<BatchRow | null> {
  return env.JUDGE_DB.prepare("SELECT * FROM devday_judge_batches WHERE id = ? AND event_id = ?").bind(id, EVENT_ID).first<BatchRow>();
}

async function batchPayload(row: BatchRow, env: Env): Promise<{ batch: PublicBatchRecord; submissions: PublicSubmissionRecord[] }> {
  const members = await env.JUDGE_DB.prepare(`SELECT ${PUBLIC_SUBMISSION_COLUMNS} FROM devday_judge_submissions WHERE batch_id = ? AND event_id = ? ORDER BY repo_normalized`).bind(row.id, EVENT_ID).all<PublicSubmissionRow>();
  return summarize(row, members.results.map(toPublic));
}

function summarize(row: BatchRow, submissions: PublicSubmissionRecord[]): { batch: PublicBatchRecord; submissions: PublicSubmissionRecord[] } {
  const counts = { total: submissions.length, queued: 0, processing: 0, completed: 0, failed: 0 };
  for (const submission of submissions) counts[submission.status] += 1;
  const terminal = row.status === "scoring" && counts.queued + counts.processing === 0;
  const status = terminal ? counts.failed > 0 ? "failed" : "completed" : row.status;
  const completedAt = terminal ? submissions.map((item) => item.completedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null : row.completed_at;
  return { batch: { id: row.id, eventId: row.event_id, mode: row.mode, effort: row.effort, status, createdAt: row.created_at, startedAt: row.started_at, frozenAt: row.frozen_at, completedAt, failureMessage: row.failure_message ?? (terminal && counts.failed ? "One or more submissions failed. Review individual results." : null), counts, frozenCount: submissions.filter((item) => Boolean(item.frozenAt)).length, scoredCount: submissions.filter((item) => item.result !== null).length, freezeRequestedAt: row.freeze_dispatched_at, freezeDispatches: row.freeze_dispatches, maxFreezeDispatches: 3 }, submissions };
}

async function batchResponse(row: BatchRow, env: Env, single = false): Promise<Response> {
  const payload = await batchPayload(row, env);
  return jsonResponse(single ? { submission: payload.submissions[0] } : payload, { status: 202 });
}

export async function getBatch(id: string, env: Env): Promise<Response> {
  const row = await getBatchRow(id, env);
  return row ? jsonResponse(await batchPayload(row, env)) : jsonResponse({ error: "Not found" }, { status: 404 });
}

export async function listBatches(env: Env, submissions?: PublicSubmissionRecord[]): Promise<PublicBatchRecord[]> {
  const rows = await env.JUDGE_DB.prepare("SELECT * FROM devday_judge_batches WHERE event_id = ? ORDER BY created_at DESC, id DESC").bind(EVENT_ID).all<BatchRow>();
  const items = submissions ?? (await env.JUDGE_DB.prepare(`SELECT ${PUBLIC_SUBMISSION_COLUMNS} FROM devday_judge_submissions WHERE event_id = ?`).bind(EVENT_ID).all<PublicSubmissionRow>()).results.map(toPublic);
  return rows.results.map((row) => summarize(row, items.filter((item) => item.batchId === row.id)).batch);
}

async function failBatch(id: string, dispatch: number, message: string, env: Env): Promise<void> {
  const now = new Date().toISOString();
  await env.JUDGE_DB.batch([
    env.JUDGE_DB.prepare("UPDATE devday_judge_batches SET status = 'failed', completed_at = ?, failure_message = ? WHERE id = ? AND event_id = ? AND freeze_dispatches = ? AND status IN ('queued', 'freezing')").bind(now, message, id, EVENT_ID, dispatch),
    env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET status = 'failed', completed_at = ?, updated_at = ?, failure_message = ? WHERE batch_id = ? AND event_id = ? AND status = 'queued' AND dispatch_count = 0 AND EXISTS (SELECT 1 FROM devday_judge_batches WHERE id = ? AND freeze_dispatches = ? AND status = 'failed')").bind(now, now, message, id, EVENT_ID, id, dispatch)
  ]);
}

export async function retryBatch(request: Request, id: string, env: Env): Promise<Response> {
  try {
    const body = await readJson(request, 2048);
    if (!object(body) || Object.keys(body).length !== 1 || body.confirm !== true) throw new Error("Batch retry requires {confirm:true}");
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Invalid retry body" }, { status: error instanceof Error && error.message === "Request body too large" ? 413 : 400 });
  }
  if (!workEnabled(env)) return jsonResponse({ error: "Judging is disabled or submissions are closed", code: "judging_disabled" }, { status: 410 });
  const row = await getBatchRow(id, env);
  if (!row) return jsonResponse({ error: "Not found" }, { status: 404 });
  const now = new Date().toISOString();
  if (row.mode === "production" && now < JUDGING_START_ISO) return jsonResponse({ error: "Production judging has not started", code: "judging_not_started" }, { status: 403 });
  const staleBefore = new Date(Date.parse(now) - 30 * 60 * 1000).toISOString();
  if (row.freeze_dispatches >= 3) return jsonResponse({ error: "Batch freeze dispatch limit reached", code: "retry_limit" }, { status: 409 });
  const eligible = row.frozen_at === null && (row.status === "failed" || (["queued", "freezing"].includes(row.status) && (row.started_at ?? row.freeze_dispatched_at ?? row.created_at) < staleBefore));
  if (!eligible) return jsonResponse({ error: "Batch retry unavailable; queued/freezing recovery requires 30 minutes", code: "retry_unavailable" }, { status: 409 });
  const results = await env.JUDGE_DB.batch([
    env.JUDGE_DB.prepare("UPDATE devday_judge_batches SET status = 'queued', freeze_dispatches = freeze_dispatches + 1, freeze_dispatched_at = ?, started_at = NULL, completed_at = NULL, failure_message = NULL WHERE id = ? AND event_id = ? AND freeze_dispatches = ? AND freeze_dispatches < 3 AND frozen_at IS NULL AND (status = 'failed' OR (status IN ('queued', 'freezing') AND COALESCE(started_at, freeze_dispatched_at, created_at) < ?)) AND NOT EXISTS (SELECT 1 FROM devday_judge_submissions WHERE batch_id = ? AND (dispatch_count > 0 OR attempts > 0))").bind(now, id, EVENT_ID, row.freeze_dispatches, staleBefore, id),
    env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET status = 'queued', completed_at = NULL, failure_message = NULL, updated_at = ? WHERE changes() = 1 AND batch_id = ? AND dispatch_count = 0 AND attempts = 0 AND EXISTS (SELECT 1 FROM devday_judge_batches WHERE id = ? AND status = 'queued' AND freeze_dispatches = ? AND freeze_dispatched_at = ?)").bind(now, id, id, row.freeze_dispatches + 1, now)
  ]);
  if (!results[0]?.meta.changes) return jsonResponse({ error: "Batch retry unavailable", code: "retry_unavailable" }, { status: 409 });
  try {
    await env.SCORING_QUEUE.send({ type: "freeze_batch", eventId: EVENT_ID, batchId: id, dispatch: row.freeze_dispatches + 1 });
  } catch {
    await failBatch(id, row.freeze_dispatches + 1, "Batch freeze queue delivery failed. Retry this batch explicitly after service recovery.", env);
    return jsonResponse({ error: "Batch freeze queue send failed", code: "queue_send_failed", ...await batchPayload((await getBatchRow(id, env))!, env) }, { status: 503 });
  }
  return batchResponse((await getBatchRow(id, env))!, env);
}

export function validFreezeMessage(value: unknown): value is FreezeQueueMessage {
  return object(value) && Object.keys(value).length === 4 && value.type === "freeze_batch" && value.eventId === EVENT_ID && typeof value.batchId === "string" && /^[0-9a-f-]{36}$/.test(value.batchId) && Number.isSafeInteger(value.dispatch) && Number(value.dispatch) >= 1 && Number(value.dispatch) <= 3;
}

export async function processFreezeMessage(message: FreezeQueueMessage, env: Env): Promise<void> {
  if (!validFreezeMessage(message)) return;
  const existing = await getBatchRow(message.batchId, env);
  if (!existing || existing.status !== "queued" || existing.freeze_dispatches !== message.dispatch) return;
  const claimed = await env.JUDGE_DB.prepare("UPDATE devday_judge_batches SET status = 'freezing', started_at = ? WHERE id = ? AND event_id = ? AND status = 'queued' AND freeze_dispatches = ? RETURNING *").bind(new Date().toISOString(), message.batchId, EVENT_ID, message.dispatch).first<BatchRow>();
  if (!claimed) return;
  try {
    if (!workEnabled(env)) throw new Error("paused");
    const members = await env.JUDGE_DB.prepare("SELECT * FROM devday_judge_submissions WHERE batch_id = ? AND event_id = ? ORDER BY repo_normalized").bind(message.batchId, EVENT_ID).all<SubmissionRow>();
    const resolutions: Array<{ row: SubmissionRow; resolution: RepoResolution; frozenAt: string }> = [];
    let cursor = 0;
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, members.results.length) }, async () => {
      while (cursor < members.results.length) {
        const row = members.results[cursor++]!;
        const resolution: RepoResolution = row.frozen_at && row.frozen_resolution_json ? JSON.parse(row.frozen_resolution_json) : await resolveRepoAuthority({ owner: row.repo_owner, repo: row.repo_name, normalized: row.repo_normalized, canonicalUrl: row.repo_url }, `${row.repo_normalized} batch repository snapshot`);
        if (!["scored", "empty_repository", "missing_or_private", "no_default_branch", "unjudgeable"].includes(resolution.assessment) || (resolution.assessment === "scored" && !/^[0-9a-f]{40}$/.test(resolution.pinnedSha ?? ""))) throw new Error("Invalid repository resolution");
        resolutions.push({ row, resolution, frozenAt: row.frozen_at ?? new Date().toISOString() });
      }
    }));
    const complete = !results.some((result) => result.status === "rejected") && resolutions.length === members.results.length && resolutions.length > 0 && workEnabled(env);
    const frozenAt = new Date().toISOString();
    const persisted = await env.JUDGE_DB.batch([
      ...resolutions.filter(({ row }) => !row.frozen_at).map(({ row, resolution, frozenAt }) => env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET pinned_sha = ?, default_branch = ?, frozen_at = ?, frozen_resolution_json = ?, updated_at = ? WHERE id = ? AND batch_id = ? AND frozen_at IS NULL AND EXISTS (SELECT 1 FROM devday_judge_batches WHERE id = ? AND status = 'freezing' AND freeze_dispatches = ?)").bind(resolution.pinnedSha, resolution.defaultBranch, frozenAt, JSON.stringify(resolution), frozenAt, row.id, message.batchId, message.batchId, message.dispatch)),
      env.JUDGE_DB.prepare("UPDATE devday_judge_batches SET status = 'scoring', frozen_at = ? WHERE id = ? AND event_id = ? AND status = 'freezing' AND freeze_dispatches = ? AND ? = 1 AND NOT EXISTS (SELECT 1 FROM devday_judge_submissions WHERE batch_id = ? AND (frozen_at IS NULL OR frozen_resolution_json IS NULL))").bind(frozenAt, message.batchId, EVENT_ID, message.dispatch, Number(complete), message.batchId),
      env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET dispatch_count = 1, updated_at = ? WHERE batch_id = ? AND event_id = ? AND status = 'queued' AND dispatch_count = 0 AND EXISTS (SELECT 1 FROM devday_judge_batches WHERE id = ? AND status = 'scoring' AND freeze_dispatches = ? AND frozen_at = ?)").bind(frozenAt, message.batchId, EVENT_ID, message.batchId, message.dispatch, frozenAt)
    ]);
    if (!persisted.at(-2)?.meta.changes) throw new Error("Freeze barrier failed");
    const failed: string[] = [];
    for (const { row } of resolutions) {
      try {
        if (!workEnabled(env)) throw new Error("paused");
        await env.SCORING_QUEUE.send({ eventId: EVENT_ID, submissionId: row.id, mode: row.mode, attempt: row.attempts, dispatch: 1 });
      } catch {
        failed.push(row.id);
      }
    }
    if (failed.length) {
      const failure = "Scoring queue delivery failed or judging paused. Some batch jobs may already be running. Retry failed submissions explicitly.";
      await env.JUDGE_DB.prepare(`UPDATE devday_judge_submissions SET status = 'failed', failure_message = ?, updated_at = ?, completed_at = ? WHERE id IN (${failed.map(() => "?").join(",")}) AND batch_id = ? AND status = 'queued' AND dispatch_count = 1`).bind(failure, frozenAt, frozenAt, ...failed, message.batchId).run();
    }
  } catch {
    await failBatch(message.batchId, message.dispatch, "Repository freeze failed or judging paused. Saved snapshots are retained. Retry this batch explicitly after service recovery.", env);
  }
}

export async function frozenBarrier(row: SubmissionRow, env: Env): Promise<boolean> {
  if (!row.batch_id) return row.mode === "validation";
  if (!row.frozen_at || !row.frozen_resolution_json) return false;
  const batch = await getBatchRow(row.batch_id, env);
  return batch?.status === "scoring" && batch.frozen_at !== null;
}
