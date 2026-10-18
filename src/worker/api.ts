import { API_BODY_LIMIT_BYTES, CALLBACK_BODY_LIMIT_BYTES, EVENT_DATE, EVENT_ID, EVENT_NAME, FINALIST_COUNT, MAX_MEMORY_DEFERRALS, PRODUCTION_SUBMISSION_LIMIT, TARGET_TEAMS, VALIDATION_SUBMISSION_LIMIT } from "../shared/constants";
import { jsonResponse } from "../shared/json";
import { calculateUsageCost, quoteReservation } from "../shared/pricing";
import { validatePublicScoreResult } from "../shared/validation";
import { createBatch, frozenBarrier, getBatch, listBatches, retryBatch } from "./batches";
import { matchesFrozenResolution, retryExplanation } from "./explanations";
import { normalizeDemoUrl, SUBMISSION_METADATA_BODY_LIMIT_BYTES } from "./submission-metadata";
import type { BudgetReservationInput, BudgetUsage, FinalizePayload, LeaseJob, PublicScoreResult, PublicSubmissionRecord, RankingEntry, RecoveryQueueMessage, ScoringQueueMessage, SubmissionMode } from "../shared/types";

export interface SubmissionRow {
  explanation_status: "pending" | "processing" | "completed" | "failed" | null;
  evidence_snapshot_json: string | null;
  decisions_result_json: string | null;
  scored_at: string | null;
  explanation_dispatches: number;
  explanation_requested_at: string | null;
  explanation_started_at: string | null;
  batch_id: string | null;
  submitted_at: string | null;
  default_branch: string | null;
  frozen_at: string | null;
  frozen_resolution_json: string | null;
  id: string;
  event_id: string;
  repo_url: string;
  repo_normalized: string;
  repo_owner: string;
  repo_name: string;
  team_name: string;
  demo_url: string | null;
  mode: SubmissionMode;
  effort: "low" | "high";
  scoring_effort: "low" | "medium" | "high" | null;
  status: "queued" | "processing" | "completed" | "failed";
  attempts: number;
  dispatch_count: number;
  recovery_dispatch_count: number;
  recovery_requested_at: string | null;
  recovery_previous_started_at: string | null;
  recovery_previous_updated_at: string | null;
  callback_token: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  pinned_sha: string | null;
  failure_message: string | null;
  result_json: string | null;
  outcome_json: string | null;
}

const publicSubmissionFields = [
  "id", "event_id", "repo_url", "repo_normalized", "repo_owner", "repo_name", "team_name", "demo_url", "mode", "effort", "scoring_effort", "status", "attempts", "dispatch_count", "recovery_dispatch_count", "recovery_requested_at", "created_at", "updated_at", "started_at", "completed_at", "pinned_sha", "failure_message", "result_json", "batch_id", "submitted_at", "frozen_at", "explanation_status", "explanation_dispatches", "scored_at"
] as const;

export const PUBLIC_SUBMISSION_COLUMNS = publicSubmissionFields.join(", ");
export type PublicSubmissionRow = Pick<SubmissionRow, typeof publicSubmissionFields[number]>;

interface AccountRow {
  mode: SubmissionMode;
  limit_micro_usd: number;
  spent_micro_usd: number;
  reserved_micro_usd: number;
}

interface ReservationRow {
  id: string;
  submission_id: string;
  callback_token: string;
  mode: SubmissionMode;
  kind: "decisions" | "responses";
  model: string;
  max_input_tokens: number;
  max_output_tokens: number;
  reserved_micro_usd: number;
  actual_micro_usd: number | null;
  usage_json: string | null;
  status: "reserved" | "settled";
}

export async function handleApiRequest(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !sameOrigin(request)) return jsonResponse({ error: "Cross-origin mutation rejected" }, { status: 403 });
  if (request.method === "POST" && path === "/api/batches") return createBatch(request, env);
  if (request.method === "POST" && /^\/api\/batches\/[^/]+\/retry$/.test(path)) return retryBatch(request, path.split("/")[3]!, env);
  if (request.method === "GET" && /^\/api\/batches\/[^/]+$/.test(path)) return getBatch(path.split("/").at(-1) ?? "", env);
  if (request.method === "GET" && path === "/api/dashboard") return dashboard(env);
  if (request.method === "GET" && path === "/api/submission-status") return jsonResponse({ open: submissionsOpen(env) });
  if (request.method === "GET" && path === "/api/runner-status") return jsonResponse(await runnerStatus(env));
  if (request.method === "GET" && path === "/api/ranking") return jsonResponse({ items: await ranking(env) });
  if (request.method === "GET" && path === "/api/recent") return jsonResponse({ items: (await listSubmissions(env)).slice(0, 50) });
  if (request.method === "GET" && /^\/api\/(submissions|results)\/[^/]+$/.test(path)) return getSubmission(path.split("/").at(-1) ?? "", env);
  if (request.method === "PATCH" && /^\/api\/submissions\/[^/]+$/.test(path)) return updateSubmissionMetadata(request, path.split("/").at(-1) ?? "", env);
  if (request.method === "POST" && path === "/api/submissions") {
    return createBatch(request, env, true);
  }
  if (request.method === "POST" && /^\/api\/submissions\/[^/]+\/retry$/.test(path)) {
    return retrySubmission(request, path.split("/")[3]!, env);
  }
  if (request.method === "POST" && /^\/api\/submissions\/[^/]+\/recover$/.test(path)) {
    return recoverSubmission(request, path.split("/")[3]!, env);
  }
  return jsonResponse({ error: "Not found" }, { status: 404 });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

function submissionsOpen(env: Env): boolean {
  return env.SUBMISSIONS_OPEN?.trim().toLowerCase() === "true";
}

function disabled(): Response {
  return jsonResponse({ error: "Judging is disabled", code: "judging_disabled" }, { status: 410 });
}

export function judgingEnabled(env: Env): boolean {
  return env.JUDGING_ENABLED?.trim().toLowerCase() === "true";
}

export function workEnabled(env: Env): boolean {
  return judgingEnabled(env) && submissionsOpen(env);
}

export function effectiveEffort(row: Pick<SubmissionRow, "scoring_effort" | "effort">): "low" | "medium" | "high" {
  return row.scoring_effort ?? row.effort;
}

async function getSubmission(id: string, env: Env): Promise<Response> {
  const row = await env.JUDGE_DB.prepare(`SELECT ${PUBLIC_SUBMISSION_COLUMNS} FROM devday_judge_submissions WHERE id = ? AND event_id = ?`).bind(id, EVENT_ID).first<PublicSubmissionRow>();
  return row ? jsonResponse(toPublic(row)) : jsonResponse({ error: "Not found" }, { status: 404 });
}

async function updateSubmissionMetadata(request: Request, id: string, env: Env): Promise<Response> {
  let teamName: string;
  let demoUrl: string | null | undefined;
  try {
    const body = await readJson(request, SUBMISSION_METADATA_BODY_LIMIT_BYTES);
    if (!object(body) || Object.keys(body).some((key) => !["teamName", "demoUrl"].includes(key)) || typeof body.teamName !== "string" || !body.teamName.trim() || body.teamName.trim().length > 100) throw new Error("Invalid submission metadata");
    teamName = body.teamName.trim();
    demoUrl = body.demoUrl === undefined ? undefined : body.demoUrl === null ? null : normalizeDemoUrl(body.demoUrl);
  } catch (error) {
    return invalid(error);
  }
  const select = () => env.JUDGE_DB.prepare(`SELECT ${PUBLIC_SUBMISSION_COLUMNS} FROM devday_judge_submissions WHERE id = ? AND event_id = ?`).bind(id, EVENT_ID).first<PublicSubmissionRow>();
  const current = await select();
  if (!current) return jsonResponse({ error: "Not found" }, { status: 404 });
  if (current.team_name === teamName && (demoUrl === undefined || current.demo_url === demoUrl)) return jsonResponse({ submission: toPublic(current) });
  const suppliedDemo = Number(demoUrl !== undefined);
  const updated = await env.JUDGE_DB.prepare(`UPDATE devday_judge_submissions SET team_name = ?, demo_url = CASE WHEN ? = 1 THEN ? ELSE demo_url END WHERE id = ? AND event_id = ? AND (team_name IS NOT ? OR (? = 1 AND demo_url IS NOT ?)) RETURNING ${PUBLIC_SUBMISSION_COLUMNS}`)
    .bind(teamName, suppliedDemo, demoUrl ?? null, id, EVENT_ID, teamName, suppliedDemo, demoUrl ?? null).first<PublicSubmissionRow>();
  const latest = updated ?? await select();
  return latest ? jsonResponse({ submission: toPublic(latest) }) : jsonResponse({ error: "Not found" }, { status: 404 });
}

async function retrySubmission(request: Request, id: string, env: Env): Promise<Response> {
  let requestedEffort: "medium" | "high" | undefined;
  try {
    const body = await readJson(request, API_BODY_LIMIT_BYTES);
    if (!object(body) || Object.keys(body).some((key) => !["confirm", "effort"].includes(key)) || body.confirm !== true || (body.effort !== undefined && body.effort !== "medium" && body.effort !== "high")) throw new Error("Invalid retry body");
    requestedEffort = body.effort;
  } catch (error) {
    return invalid(error);
  }
  if (!workEnabled(env)) return disabled();
  const current = await getRow(id, env);
  if (!current) return jsonResponse({ error: "Not found" }, { status: 404 });
  if (requestedEffort && current.mode !== "validation") return invalid(new Error("Effort changes require validation mode"));
  if (current.result_json) return retryExplanation(current, requestedEffort, env);
  if (!await frozenBarrier(current, env)) return jsonResponse({ error: "Retry the batch to finish freezing", code: "freeze_incomplete", batchId: current.batch_id, retryUrl: current.batch_id ? `/api/batches/${current.batch_id}/retry` : null, retryBody: { confirm: true } }, { status: 409 });
  if (current.attempts >= 3 || current.dispatch_count >= 3) return jsonResponse({ error: "Retry limit reached", code: "retry_limit" }, { status: 409 });
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.parse(now) - 30 * 60 * 1000).toISOString();
  const staleProcessing = current.status === "processing" && current.started_at && current.started_at < staleBefore;
  const staleQueued = current.status === "queued" && current.updated_at < staleBefore;
  const completedLowValidation = Boolean(requestedEffort) && current.mode === "validation" && effectiveEffort(current) === "low" && current.status === "completed";
  if (current.status !== "failed" && !staleProcessing && !staleQueued && !completedLowValidation) {
    return jsonResponse({ error: "Retry is unavailable for this submission", code: "retry_unavailable" }, { status: 409 });
  }
  const updated = await env.JUDGE_DB.prepare(
    "UPDATE devday_judge_submissions SET status = 'queued', scoring_effort = ?, dispatch_count = dispatch_count + 1, callback_token = NULL, started_at = NULL, completed_at = NULL, failure_message = NULL, outcome_json = NULL, updated_at = ? WHERE id = ? AND event_id = ? AND result_json IS NULL AND attempts < 3 AND attempts = ? AND dispatch_count < 3 AND dispatch_count = ? AND callback_token IS ? AND (status = 'failed' OR (status = 'processing' AND started_at < ?) OR (status = 'queued' AND updated_at < ?) OR (? = 1 AND status = 'completed' AND mode = 'validation' AND COALESCE(scoring_effort, effort) = 'low')) RETURNING *"
  ).bind(current.mode === "production" ? "medium" : requestedEffort ?? effectiveEffort(current), now, id, EVENT_ID, current.attempts, current.dispatch_count, current.callback_token, staleBefore, staleBefore, Number(completedLowValidation)).first<SubmissionRow>();
  if (updated) {
    if (!await sendQueueMessage(env, updated)) return jsonResponse({ error: "Scoring queue send failed", code: "queue_send_failed" }, { status: 503 });
    return jsonResponse({ submission: toPublic(updated) }, { status: 202 });
  }
  const latest = await getRow(id, env);
  return latest && (latest.attempts >= 3 || latest.dispatch_count >= 3)
    ? jsonResponse({ error: "Retry limit reached", code: "retry_limit" }, { status: 409 })
    : jsonResponse({ error: "Retry is unavailable for this submission", code: "retry_unavailable" }, { status: 409 });
}

const recoverySafety = `result_json IS NULL AND decisions_result_json IS NULL
  AND attempts BETWEEN 1 AND 3 AND callback_token IS NOT NULL AND length(callback_token) > 0
  AND evidence_snapshot_json IS NULL
  AND NOT EXISTS (SELECT 1 FROM devday_judge_budget_reservations WHERE submission_id = devday_judge_submissions.id)
  AND NOT EXISTS (SELECT 1 FROM devday_judge_evidence_manifests WHERE submission_id = devday_judge_submissions.id)
  AND NOT EXISTS (SELECT 1 FROM devday_judge_evidence_chunks WHERE submission_id = devday_judge_submissions.id)
  AND frozen_at IS NOT NULL AND frozen_resolution_json IS NOT NULL
  AND EXISTS (SELECT 1 FROM devday_judge_batches AS batch WHERE batch.id = devday_judge_submissions.batch_id AND batch.event_id = devday_judge_submissions.event_id AND batch.mode = devday_judge_submissions.mode AND batch.status = 'scoring' AND batch.frozen_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM devday_judge_submissions AS sibling WHERE sibling.batch_id = devday_judge_submissions.batch_id AND (sibling.frozen_at IS NULL OR sibling.frozen_resolution_json IS NULL))`;

async function recoverSubmission(request: Request, id: string, env: Env): Promise<Response> {
  try {
    const body = await readJson(request, API_BODY_LIMIT_BYTES);
    if (!object(body) || Object.keys(body).length !== 1 || body.confirm !== true) throw new Error("Invalid recovery confirmation");
  } catch (error) {
    return invalid(error);
  }
  if (!workEnabled(env)) return disabled();
  const unavailable = () => jsonResponse({ error: "Recovery is unavailable for this submission", code: "recovery_unavailable" }, { status: 409 });
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.parse(now) - 5 * 60 * 1000).toISOString();
  const predicate = `id = ? AND event_id = ? AND status = 'processing' AND updated_at <= ? AND recovery_dispatch_count = 0 AND ${recoverySafety}`;
  const current = await env.JUDGE_DB.prepare(`SELECT * FROM devday_judge_submissions WHERE ${predicate}`).bind(id, EVENT_ID, staleBefore).first<SubmissionRow>();
  if (!current) return unavailable();
  const token = crypto.randomUUID();
  const updated = await env.JUDGE_DB.prepare(`UPDATE devday_judge_submissions SET recovery_dispatch_count = recovery_dispatch_count + 1, recovery_requested_at = ?, recovery_previous_started_at = started_at, recovery_previous_updated_at = updated_at, callback_token = ?, status = 'queued', updated_at = ?, failure_message = NULL, completed_at = NULL WHERE ${predicate} AND callback_token = ? AND attempts = ? AND updated_at = ? RETURNING *`)
    .bind(now, token, now, id, EVENT_ID, staleBefore, current.callback_token, current.attempts, current.updated_at).first<SubmissionRow>();
  if (!updated) return unavailable();
  const message: RecoveryQueueMessage = { type: "resume_submission", eventId: EVENT_ID, submissionId: updated.id, mode: updated.mode, attempt: updated.attempts, dispatch: 1, callbackToken: token };
  try {
    await env.SCORING_QUEUE.send(message);
  } catch {
    const failedAt = new Date().toISOString();
    await env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET status = 'failed', failure_message = ?, updated_at = ?, completed_at = ? WHERE id = ? AND event_id = ? AND mode = ? AND status = 'queued' AND callback_token = ? AND attempts = ? AND recovery_dispatch_count = 1")
      .bind("Recovery queue delivery failed. The one-time recovery has been consumed.", failedAt, failedAt, updated.id, EVENT_ID, updated.mode, token, updated.attempts).run();
    return jsonResponse({ error: "Recovery queue send failed", code: "queue_send_failed" }, { status: 503 });
  }
  return jsonResponse({ submission: toPublic(updated) }, { status: 202 });
}

export async function getRow(id: string, env: Env): Promise<SubmissionRow | null> {
  return env.JUDGE_DB.prepare("SELECT * FROM devday_judge_submissions WHERE id = ? AND event_id = ?").bind(id, EVENT_ID).first<SubmissionRow>();
}

export async function sendQueueMessage(env: Env, row: SubmissionRow): Promise<boolean> {
  const message: ScoringQueueMessage = { eventId: EVENT_ID, submissionId: row.id, mode: row.mode, attempt: row.attempts, dispatch: row.dispatch_count };
  try {
    await env.SCORING_QUEUE.send(message);
    return true;
  } catch {
    const now = new Date().toISOString();
    await env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET status = 'failed', failure_message = ?, completed_at = ?, updated_at = ?, outcome_json = ? WHERE id = ? AND event_id = ? AND mode = ? AND status = 'queued' AND attempts = ? AND dispatch_count = ?")
      .bind("Scoring queue delivery failed. Retry after service recovery.", now, now, JSON.stringify({ kind: "failed", message: "Scoring queue delivery failed. Retry after service recovery." }), row.id, EVENT_ID, row.mode, row.attempts, row.dispatch_count).run();
    return false;
  }
}

export function toPublic(row: PublicSubmissionRow): PublicSubmissionRecord {
  return {
    ...(row.batch_id ? { batchId: row.batch_id } : {}),
    ...(row.submitted_at ? { submittedAt: row.submitted_at } : {}),
    pinnedSha: row.pinned_sha,
    frozenAt: row.frozen_at,
    scoredAt: row.scored_at,
    ...(row.explanation_status ? { explanationStatus: row.explanation_status } : {}),
    explanationDispatches: row.explanation_dispatches,
    id: row.id,
    eventId: row.event_id,
    repoUrl: row.repo_url,
    repo: {
      owner: row.repo_owner,
      repo: row.repo_name,
      normalized: row.repo_normalized,
      canonicalUrl: row.repo_url
    },
    teamName: row.team_name,
    demoUrl: row.demo_url,
    mode: row.mode,
    effort: effectiveEffort(row),
    status: row.status,
    attempts: row.attempts,
    dispatches: row.dispatch_count,
    recoveryDispatches: row.recovery_dispatch_count,
    recoveryRequestedAt: row.recovery_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureMessage: row.failure_message,
    result: row.result_json ? JSON.parse(row.result_json) as PublicScoreResult : null
  };
}

async function listSubmissions(env: Env): Promise<PublicSubmissionRecord[]> {
  const rows = await env.JUDGE_DB.prepare(`SELECT ${PUBLIC_SUBMISSION_COLUMNS} FROM devday_judge_submissions WHERE event_id = ? ORDER BY created_at DESC, id DESC`).bind(EVENT_ID).all<PublicSubmissionRow>();
  return rows.results.map(toPublic);
}

async function ranking(env: Env): Promise<RankingEntry[]> {
  const rows = await env.JUDGE_DB.prepare(`SELECT ${PUBLIC_SUBMISSION_COLUMNS} FROM devday_judge_submissions WHERE event_id = ? AND mode = 'production' AND result_json IS NOT NULL`).bind(EVENT_ID).all<PublicSubmissionRow>();
  const scored = rows.results.map((row) => ({ row, result: JSON.parse(row.result_json!) as PublicScoreResult }))
    .filter(({ result }) => result.repoAssessment === "scored" && result.eligibility !== "no_implementation")
    .sort((a, b) => b.result.total - a.result.total || a.row.created_at.localeCompare(b.row.created_at) || a.row.id.localeCompare(b.row.id));
  const cutoffScore = scored.length >= FINALIST_COUNT ? scored[FINALIST_COUNT - 1]!.result.total : null;
  const crossesCutoff = cutoffScore !== null && scored.filter((entry) => entry.result.total >= cutoffScore).length > FINALIST_COUNT;
  let rank = 0;
  let previous: number | null = null;
  return scored.map(({ row, result }, index) => {
    if (result.total !== previous) rank = index + 1;
    previous = result.total;
    return {
      submissionId: row.id,
      repo: row.repo_normalized,
      repoUrl: row.repo_url,
      teamName: row.team_name,
      demoUrl: row.demo_url,
      mode: row.mode,
      pinnedSha: result.pinnedSha,
      total: result.total,
      criteria: result.criteria,
      completedAt: row.completed_at,
      summary: result.summary,
      attackScore: result.attackScore,
      rank,
      finalist: rank <= FINALIST_COUNT,
      tiedAtCutoff: crossesCutoff && result.total === cutoffScore
    };
  });
}

async function runnerStatus(env: Env): Promise<{ online: boolean; lastSeenAt: string | null }> {
  const row = await env.JUDGE_DB.prepare("SELECT MAX(started_at) AS last_seen_at FROM devday_judge_submissions WHERE event_id = ?").bind(EVENT_ID).first<{ last_seen_at: string | null }>();
  const lastSeenAt = row?.last_seen_at ?? null;
  return { online: judgingEnabled(env) && Boolean(env.OPENAI_API_KEY_20261018_HACKATHON?.trim()) && Boolean(env.SCORING_QUEUE), lastSeenAt };
}

async function dashboard(env: Env): Promise<Response> {
  const [items, entries, account, runner] = await Promise.all([
    listSubmissions(env),
    ranking(env),
    getAccount("production", env),
    runnerStatus(env)
  ]);
  const production = items.filter((item) => item.mode === "production");
  const counts = { queued: 0, processing: 0, completed: 0, failed: 0, total: production.length };
  for (const item of production) counts[item.status] += 1;
  const cutoffScore = entries.length >= FINALIST_COUNT ? entries[FINALIST_COUNT - 1]!.total : null;
  const tiedCount = cutoffScore === null ? 0 : entries.filter((entry) => entry.total === cutoffScore).length;
  return jsonResponse({
    event: { id: EVENT_ID, name: EVENT_NAME, date: EVENT_DATE, targetTeams: TARGET_TEAMS, finalistCount: FINALIST_COUNT, submissionLimits: { production: PRODUCTION_SUBMISSION_LIMIT, validation: VALIDATION_SUBMISSION_LIMIT } },
    open: submissionsOpen(env),
    counts,
    scoredCount: production.filter((item) => item.result !== null).length,
    budget: {
      limitUsd: account.limit_micro_usd / 1_000_000,
      spentUsd: account.spent_micro_usd / 1_000_000,
      reservedUsd: account.reserved_micro_usd / 1_000_000,
      remainingUsd: (account.limit_micro_usd - account.spent_micro_usd - account.reserved_micro_usd) / 1_000_000
    },
    items,
    batches: await listBatches(env, items),
    ranking: entries,
    cutoff: { score: cutoffScore, tied: entries.some((entry) => entry.tiedAtCutoff), tiedCount },
    runner
  });
}

async function getAccount(mode: SubmissionMode, env: Env): Promise<AccountRow> {
  const row = await env.JUDGE_DB.prepare("SELECT * FROM devday_judge_budget_accounts WHERE mode = ?").bind(mode).first<AccountRow>();
  if (!row) throw new Error(`Budget account missing: ${mode}`);
  return row;
}

export function validQueueMessage(value: unknown): value is ScoringQueueMessage {
  return object(value) && Object.keys(value).every((key) => ["eventId", "submissionId", "mode", "attempt", "dispatch", "memoryDeferrals"].includes(key)) && value.eventId === EVENT_ID
    && (value.memoryDeferrals === undefined || Number.isSafeInteger(value.memoryDeferrals) && Number(value.memoryDeferrals) >= 0 && Number(value.memoryDeferrals) <= MAX_MEMORY_DEFERRALS)
    && shortString(value.submissionId, 100) && /^[A-Za-z0-9-]+$/.test(value.submissionId)
    && (value.mode === "production" || value.mode === "validation")
    && Number.isSafeInteger(value.attempt) && Number(value.attempt) >= 0 && Number(value.attempt) <= 2
    && Number.isSafeInteger(value.dispatch) && Number(value.dispatch) >= 1 && Number(value.dispatch) <= 3;
}

export function validRecoveryMessage(value: unknown): value is RecoveryQueueMessage {
  return object(value) && Object.keys(value).every((key) => ["type", "eventId", "submissionId", "mode", "attempt", "dispatch", "callbackToken", "memoryDeferrals"].includes(key)) && value.type === "resume_submission" && value.eventId === EVENT_ID
    && (value.memoryDeferrals === undefined || Number.isSafeInteger(value.memoryDeferrals) && Number(value.memoryDeferrals) >= 0 && Number(value.memoryDeferrals) <= MAX_MEMORY_DEFERRALS)
    && shortString(value.submissionId, 100) && /^[A-Za-z0-9-]+$/.test(value.submissionId)
    && (value.mode === "production" || value.mode === "validation")
    && Number.isSafeInteger(value.attempt) && Number(value.attempt) >= 1 && Number(value.attempt) <= 3
    && value.dispatch === 1 && shortString(value.callbackToken, 100) && /^[A-Za-z0-9-]+$/.test(value.callbackToken);
}

export async function claimRecoveryMessage(message: RecoveryQueueMessage, env: Env): Promise<LeaseJob | null> {
  if (!validRecoveryMessage(message) || !workEnabled(env)) return null;
  const predicate = `id = ? AND event_id = ? AND mode = ? AND status = 'queued' AND callback_token = ? AND attempts = ? AND recovery_dispatch_count = 1 AND ${recoverySafety}`;
  const values = [message.submissionId, EVENT_ID, message.mode, message.callbackToken, message.attempt];
  const queued = await env.JUDGE_DB.prepare(`SELECT * FROM devday_judge_submissions WHERE ${predicate}`).bind(...values).first<SubmissionRow>();
  if (!queued) return null;
  const now = new Date().toISOString();
  const row = await env.JUDGE_DB.prepare(`UPDATE devday_judge_submissions SET status = 'processing', started_at = ?, updated_at = ? WHERE ${predicate} RETURNING *`).bind(now, now, ...values).first<SubmissionRow>();
  return row ? leaseJob(row) : null;
}

export async function claimQueueMessage(message: ScoringQueueMessage, env: Env): Promise<LeaseJob | null> {
  if (!validQueueMessage(message)) return null;
  const queued = await getRow(message.submissionId, env);
  if (!queued || queued.result_json || queued.mode !== message.mode || queued.status !== "queued" || queued.attempts !== message.attempt || queued.dispatch_count !== message.dispatch) return null;
  if (queued.recovery_dispatch_count === 1 && queued.callback_token !== null) return null;
  if (!await frozenBarrier(queued, env)) return null;
  if (!workEnabled(env)) {
    const now = new Date().toISOString();
    const failure = "Judging is paused. Retry after it resumes.";
    await env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET status = 'failed', updated_at = ?, completed_at = ?, failure_message = ?, outcome_json = ? WHERE id = ? AND event_id = ? AND mode = ? AND status = 'queued' AND attempts = ? AND dispatch_count = ?")
      .bind(now, now, failure, JSON.stringify({ kind: "failed", message: failure }), message.submissionId, EVENT_ID, message.mode, message.attempt, message.dispatch).run();
    return null;
  }
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = await env.JUDGE_DB.prepare(
    "UPDATE devday_judge_submissions SET status = 'processing', callback_token = ?, started_at = ?, updated_at = ?, attempts = attempts + 1 WHERE id = ? AND event_id = ? AND mode = ? AND status = 'queued' AND result_json IS NULL AND attempts = ? AND attempts < 3 AND dispatch_count = ? AND (recovery_dispatch_count = 0 OR callback_token IS NULL) RETURNING *"
  ).bind(token, now, now, message.submissionId, EVENT_ID, message.mode, message.attempt, message.dispatch).first<SubmissionRow>();
  if (!row) return null;
  return leaseJob(row);
}

function leaseJob(row: SubmissionRow): LeaseJob {
  return {
    submissionId: row.id,
    repoUrl: row.repo_url,
    repo: { owner: row.repo_owner, repo: row.repo_name, normalized: row.repo_normalized, canonicalUrl: row.repo_url },
    teamName: row.team_name,
    mode: row.mode,
    startedAt: row.started_at!,
    effort: row.mode === "production" ? "medium" : effectiveEffort(row),
    callbackToken: row.callback_token!,
    pinnedSha: row.pinned_sha,
    defaultBranch: row.default_branch,
    summary: `${row.repo_normalized} repository snapshot`,
    ...(row.frozen_resolution_json ? { frozenResolution: JSON.parse(row.frozen_resolution_json) } : {})
  };
}

export async function callback(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return jsonResponse({ error: "Cross-origin mutation rejected" }, { status: 403 });
  let body: FinalizePayload;
  try {
    const parsed = await readJson(request, CALLBACK_BODY_LIMIT_BYTES);
    if (!object(parsed) || Object.keys(parsed).some((key) => !["submissionId", "callbackToken", "outcome"].includes(key)) || !shortString(parsed.submissionId, 100) || !shortString(parsed.callbackToken, 100) || !object(parsed.outcome)) throw new Error("Invalid callback body");
    const outcome = parsed.outcome;
    if (outcome.kind === "completed") {
      if (Object.keys(outcome).some((key) => !["kind", "result"].includes(key))) throw new Error("Invalid callback outcome");
      body = { submissionId: parsed.submissionId, callbackToken: parsed.callbackToken, outcome: { kind: "completed", result: validatePublicScoreResult(outcome.result) } };
    } else if ((outcome.kind === "failed" || outcome.kind === "retryable_failure") && shortString(outcome.message, 400) && Object.keys(outcome).every((key) => ["kind", "message"].includes(key))) {
      body = { submissionId: parsed.submissionId, callbackToken: parsed.callbackToken, outcome: { kind: outcome.kind, message: outcome.message } };
    } else throw new Error("Invalid callback outcome");
  } catch (error) {
    return invalid(error);
  }
  const row = await getRow(body.submissionId, env);
  if (!row) return jsonResponse({ error: "Not found" }, { status: 404 });
  if (row.callback_token !== body.callbackToken) return jsonResponse({ error: "Forbidden" }, { status: 403 });
  const outcomeJson = JSON.stringify(body.outcome);
  if (row.status === "completed" || row.status === "failed") {
    return row.outcome_json === outcomeJson
      ? jsonResponse({ ok: true, submission: toPublic(row) })
      : jsonResponse({ error: "Callback payload conflict" }, { status: 409 });
  }
  if (row.status !== "processing") return jsonResponse({ error: "Stale callback" }, { status: 409 });
  if (row.result_json) return jsonResponse({ error: "Scores are already fixed; retry explanations explicitly" }, { status: 409 });
  if (body.outcome.kind === "completed" && !matchesFrozenResolution(row, body.outcome.result)) return invalid(new Error("Result does not match frozen repository"));
  const now = new Date().toISOString();
  const status = body.outcome.kind === "completed" ? "completed" : "failed";
  const resultJson = body.outcome.kind === "completed" ? JSON.stringify(body.outcome.result) : null;
  const pinnedSha = row.frozen_at ? row.pinned_sha : body.outcome.kind === "completed" ? body.outcome.result.pinnedSha : null;
  const failure = body.outcome.kind === "completed" ? null : body.outcome.message;
  const updated = await env.JUDGE_DB.prepare(
    "UPDATE devday_judge_submissions SET status = ?, updated_at = ?, completed_at = ?, pinned_sha = ?, failure_message = ?, result_json = ?, outcome_json = ?, scored_at = CASE WHEN ? IS NOT NULL THEN ? ELSE scored_at END, explanation_status = CASE WHEN ? IS NOT NULL THEN 'completed' ELSE explanation_status END WHERE id = ? AND status = 'processing' AND callback_token = ? AND result_json IS NULL RETURNING *"
  ).bind(status, now, now, pinnedSha, failure, resultJson, outcomeJson, resultJson, now, resultJson, body.submissionId, body.callbackToken).first<SubmissionRow>();
  if (updated) return jsonResponse({ ok: true, submission: toPublic(updated) });
  const current = await getRow(body.submissionId, env);
  return current?.callback_token === body.callbackToken && current.outcome_json === outcomeJson
    ? jsonResponse({ ok: true, submission: toPublic(current) })
    : jsonResponse({ error: "Stale callback" }, { status: 409 });
}

export async function reserve(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return jsonResponse({ error: "Cross-origin mutation rejected" }, { status: 403 });
  if (!workEnabled(env)) return disabled();
  let input: { submissionId: string; callbackToken: string; reservationId: string; reservation: BudgetReservationInput; explanationDispatch?: number };
  try {
    const value = await readJson(request, API_BODY_LIMIT_BYTES);
    if (!object(value) || !shortString(value.submissionId, 100) || !shortString(value.callbackToken, 100) || !shortString(value.reservationId, 100) || !object(value.reservation)) throw new Error("Invalid reservation");
    const reservation = value.reservation;
    if (value.explanationDispatch !== undefined && (!Number.isSafeInteger(value.explanationDispatch) || Number(value.explanationDispatch) < 1 || Number(value.explanationDispatch) > 3)) throw new Error("Invalid explanation dispatch");
    if (!validModel(reservation.kind, reservation.model) || !safeCount(reservation.maxInputTokens) || !safeCount(reservation.maxOutputTokens) || !positiveMoney(reservation.reservedUsd)) throw new Error("Invalid reservation");
    if (reservation.kind === "decisions" && reservation.maxOutputTokens !== 0) throw new Error("Decisions must reserve zero output tokens");
    const required = quoteReservation(reservation as unknown as BudgetReservationInput);
    if (micro(reservation.reservedUsd) < micro(required)) throw new Error("Reservation is below the maximum call cost");
    input = { submissionId: value.submissionId, callbackToken: value.callbackToken, reservationId: value.reservationId, reservation: reservation as unknown as BudgetReservationInput, ...(value.explanationDispatch === undefined ? {} : { explanationDispatch: Number(value.explanationDispatch) }) };
  } catch (error) {
    return invalid(error);
  }
  const job = await getRow(input.submissionId, env);
  if (!job || job.callback_token !== input.callbackToken) return jsonResponse({ error: "Forbidden" }, { status: 403 });
  const amount = micro(input.reservation.reservedUsd);
  if (amount <= 0) return invalid(new Error("Reserved amount too small"));
  const existing = await env.JUDGE_DB.prepare("SELECT * FROM devday_judge_budget_reservations WHERE id = ?").bind(input.reservationId).first<ReservationRow>();
  if (existing) return sameReservation(existing, input, amount)
    ? jsonResponse({ reservationId: existing.id, status: existing.status, reservedUsd: existing.reserved_micro_usd / 1_000_000 })
    : jsonResponse({ error: "Reservation conflict" }, { status: 409 });
  if (job.status !== "processing") return jsonResponse({ error: "Stale lease" }, { status: 409 });
  if (input.explanationDispatch !== undefined && (job.explanation_status !== "processing" || job.explanation_dispatches !== input.explanationDispatch)) return jsonResponse({ error: "Stale explanation lease" }, { status: 409 });
  const now = new Date().toISOString();
  try {
    const results = await env.JUDGE_DB.batch([
      env.JUDGE_DB.prepare("UPDATE devday_judge_budget_accounts SET reserved_micro_usd = reserved_micro_usd + ? WHERE mode = ? AND spent_micro_usd + reserved_micro_usd + ? <= limit_micro_usd AND NOT EXISTS (SELECT 1 FROM devday_judge_budget_reservations WHERE id = ?) AND EXISTS (SELECT 1 FROM devday_judge_submissions WHERE id = ? AND callback_token = ? AND status = 'processing' AND mode = ? AND (? IS NULL OR (explanation_status = 'processing' AND explanation_dispatches = ?)))").bind(amount, job.mode, amount, input.reservationId, job.id, input.callbackToken, job.mode, input.explanationDispatch ?? null, input.explanationDispatch ?? null),
      env.JUDGE_DB.prepare("INSERT INTO devday_judge_budget_reservations (id, submission_id, callback_token, mode, kind, model, max_input_tokens, max_output_tokens, reserved_micro_usd, status, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ? WHERE changes() = 1").bind(input.reservationId, job.id, input.callbackToken, job.mode, input.reservation.kind, input.reservation.model, input.reservation.maxInputTokens, input.reservation.maxOutputTokens, amount, now)
    ]);
    if (!results[0]?.meta.changes || !results[1]?.meta.changes) {
      const duplicate = await env.JUDGE_DB.prepare("SELECT * FROM devday_judge_budget_reservations WHERE id = ?").bind(input.reservationId).first<ReservationRow>();
      if (duplicate) return sameReservation(duplicate, input, amount)
        ? jsonResponse({ reservationId: duplicate.id, status: duplicate.status, reservedUsd: duplicate.reserved_micro_usd / 1_000_000 })
        : jsonResponse({ error: "Reservation conflict" }, { status: 409 });
      return jsonResponse({ error: "Budget exhausted", code: "budget_exhausted" }, { status: 402 });
    }
  } catch (error) {
    const duplicate = await env.JUDGE_DB.prepare("SELECT * FROM devday_judge_budget_reservations WHERE id = ?").bind(input.reservationId).first<ReservationRow>();
    if (duplicate) return sameReservation(duplicate, input, amount)
      ? jsonResponse({ reservationId: duplicate.id, status: duplicate.status, reservedUsd: duplicate.reserved_micro_usd / 1_000_000 })
      : jsonResponse({ error: "Reservation conflict" }, { status: 409 });
    throw error;
  }
  return jsonResponse({ reservationId: input.reservationId, status: "reserved", reservedUsd: amount / 1_000_000 }, { status: 201 });
}

function sameReservation(row: ReservationRow, input: { submissionId: string; callbackToken: string; reservation: BudgetReservationInput }, amount: number): boolean {
  return row.submission_id === input.submissionId && row.callback_token === input.callbackToken && row.kind === input.reservation.kind && row.model === input.reservation.model && row.max_input_tokens === input.reservation.maxInputTokens && row.max_output_tokens === input.reservation.maxOutputTokens && row.reserved_micro_usd === amount;
}

export async function settle(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return jsonResponse({ error: "Cross-origin mutation rejected" }, { status: 403 });
  let input: { submissionId: string; callbackToken: string; reservationId: string; usage: BudgetUsage };
  try {
    const value = await readJson(request, API_BODY_LIMIT_BYTES);
    if (!object(value) || !shortString(value.submissionId, 100) || !shortString(value.callbackToken, 100) || !shortString(value.reservationId, 100) || !object(value.usage)) throw new Error("Invalid settlement");
    const usage = value.usage;
    if (!validModel(usage.kind, usage.model) || !safeCount(usage.inputTokens) || !safeCount(usage.outputTokens) || !safeCount(usage.cachedInputTokens) || !nonnegativeMoney(usage.costUsd) || (usage.requestId !== undefined && usage.requestId !== null && !shortString(usage.requestId, 200)) || (usage.cacheWriteInputTokens !== undefined && !safeCount(usage.cacheWriteInputTokens))) throw new Error("Invalid usage");
    if (usage.cachedInputTokens + Number(usage.cacheWriteInputTokens ?? 0) > usage.inputTokens) throw new Error("Cache token counts exceed input tokens");
    if (usage.kind === "decisions" && (usage.outputTokens !== 0 || Number(usage.cacheWriteInputTokens ?? 0) !== 0)) throw new Error("Invalid Decisions usage");
    input = { submissionId: value.submissionId, callbackToken: value.callbackToken, reservationId: value.reservationId, usage: usage as unknown as BudgetUsage };
  } catch (error) {
    return invalid(error);
  }
  const reservation = await env.JUDGE_DB.prepare("SELECT * FROM devday_judge_budget_reservations WHERE id = ?").bind(input.reservationId).first<ReservationRow>();
  if (!reservation || reservation.submission_id !== input.submissionId || reservation.callback_token !== input.callbackToken) return jsonResponse({ error: "Forbidden" }, { status: 403 });
  if (reservation.kind !== input.usage.kind || reservation.model !== input.usage.model) return jsonResponse({ error: "Usage conflict" }, { status: 409 });
  if (input.usage.inputTokens > reservation.max_input_tokens || input.usage.outputTokens > reservation.max_output_tokens) return jsonResponse({ error: "Usage exceeds reserved token limits" }, { status: 409 });
  const actual = micro(input.usage.costUsd);
  let expectedCost: number;
  try { expectedCost = calculateUsageCost(input.usage); } catch (error) { return invalid(error); }
  if (actual < micro(expectedCost)) return jsonResponse({ error: "Usage cost is below the recorded token cost" }, { status: 409 });
  if (actual > reservation.reserved_micro_usd || input.usage.costUsd > reservation.reserved_micro_usd / 1_000_000) return jsonResponse({ error: "Usage exceeds reservation" }, { status: 409 });
  const usageJson = JSON.stringify(input.usage);
  if (reservation.status === "settled") return reservation.actual_micro_usd === actual && reservation.usage_json === usageJson
    ? jsonResponse({ ok: true, spentUsd: actual / 1_000_000 })
    : jsonResponse({ error: "Settlement conflict" }, { status: 409 });
  const now = new Date().toISOString();
  const results = await env.JUDGE_DB.batch([
    env.JUDGE_DB.prepare("UPDATE devday_judge_budget_accounts SET reserved_micro_usd = reserved_micro_usd - ?, spent_micro_usd = spent_micro_usd + ? WHERE mode = ? AND EXISTS (SELECT 1 FROM devday_judge_budget_reservations WHERE id = ? AND status = 'reserved' AND callback_token = ?)").bind(reservation.reserved_micro_usd, actual, reservation.mode, reservation.id, input.callbackToken),
    env.JUDGE_DB.prepare("UPDATE devday_judge_budget_reservations SET status = 'settled', actual_micro_usd = ?, usage_json = ?, settled_at = ? WHERE id = ? AND status = 'reserved' AND changes() = 1").bind(actual, usageJson, now, reservation.id)
  ]);
  if (!results[0]?.meta.changes || !results[1]?.meta.changes) {
    const current = await env.JUDGE_DB.prepare("SELECT * FROM devday_judge_budget_reservations WHERE id = ?").bind(input.reservationId).first<ReservationRow>();
    return current?.status === "settled" && current.actual_micro_usd === actual && current.usage_json === usageJson
      ? jsonResponse({ ok: true, spentUsd: actual / 1_000_000 })
      : jsonResponse({ error: "Settlement conflict" }, { status: 409 });
  }
  return jsonResponse({ ok: true, spentUsd: actual / 1_000_000 });
}

function micro(amount: number): number {
  const [coefficient, exponent = "0"] = amount.toString().toLowerCase().split("e");
  const [whole = "0", fraction = ""] = coefficient!.split(".");
  const digits = BigInt(whole + fraction);
  const scale = 6 + Number(exponent) - fraction.length;
  if (scale >= 0) return Number(digits * 10n ** BigInt(scale));
  const divisor = 10n ** BigInt(-scale);
  return Number((digits + divisor - 1n) / divisor);
}

function validModel(kind: unknown, model: unknown): boolean {
  return (kind === "decisions" && model === "gpt-6-luna") || (kind === "responses" && model === "gpt-6.1-sol");
}

function nonnegativeMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(micro(value));
}

function positiveMoney(value: unknown): value is number {
  return nonnegativeMoney(value) && micro(value) > 0;
}

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJson(request: Request, limit: number): Promise<unknown> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw new BodyTooLarge();
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function invalid(error: unknown): Response {
  return jsonResponse({ error: error instanceof Error ? error.message : "Invalid request body" }, { status: error instanceof BodyTooLarge ? 413 : 400 });
}

class BodyTooLarge extends Error {
  constructor() {
    super("Request body too large");
  }
}
