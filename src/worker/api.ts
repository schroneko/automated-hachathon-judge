import { API_BODY_LIMIT_BYTES, CALLBACK_BODY_LIMIT_BYTES, EVENT_DATE, EVENT_ID, EVENT_NAME, FINALIST_COUNT, PRODUCTION_SUBMISSION_LIMIT, TARGET_TEAMS, VALIDATION_SUBMISSION_LIMIT } from "../shared/constants";
import { jsonResponse } from "../shared/json";
import { normalizeGitHubRepoUrl, validatePublicScoreResult } from "../shared/validation";
import type { BudgetReservationInput, BudgetUsage, FinalizePayload, LeaseJob, PublicScoreResult, PublicSubmissionRecord, RankingEntry, ScoringQueueMessage, SubmissionMode } from "../shared/types";

interface SubmissionRow {
  id: string;
  event_id: string;
  repo_url: string;
  repo_normalized: string;
  repo_owner: string;
  repo_name: string;
  team_name: string;
  mode: SubmissionMode;
  effort: "low" | "high";
  status: "queued" | "processing" | "completed" | "failed";
  attempts: number;
  dispatch_count: number;
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
  if (request.method === "GET" && path === "/api/dashboard") return dashboard(env);
  if (request.method === "GET" && path === "/api/submission-status") return jsonResponse({ open: submissionsOpen(env) });
  if (request.method === "GET" && path === "/api/runner-status") return jsonResponse(await runnerStatus(env));
  if (request.method === "GET" && path === "/api/ranking") return jsonResponse({ items: await ranking(env) });
  if (request.method === "GET" && path === "/api/recent") return jsonResponse({ items: (await listSubmissions(env)).slice(0, 50) });
  if (request.method === "GET" && /^\/api\/(submissions|results)\/[^/]+$/.test(path)) return getSubmission(path.split("/").at(-1) ?? "", env);
  if (request.method === "POST" && path === "/api/submissions") {
    if (!authorized(request, env)) return unauthorized(env);
    return createSubmission(request, env);
  }
  if (request.method === "POST" && /^\/api\/submissions\/[^/]+\/retry$/.test(path)) {
    if (!authorized(request, env)) return unauthorized(env);
    return retrySubmission(request, path.split("/")[3]!, env);
  }
  return jsonResponse({ error: "Not found" }, { status: 404 });
}

function authorized(request: Request, env: Env): boolean {
  const configured = env.RUNNER_TOKEN?.trim();
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return Boolean(configured && supplied && configured === supplied);
}

function unauthorized(env: Env): Response {
  return jsonResponse({ error: env.RUNNER_TOKEN ? "Unauthorized" : "Runner is not configured" }, { status: env.RUNNER_TOKEN ? 401 : 503 });
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

async function createSubmission(request: Request, env: Env): Promise<Response> {
  let input: { repoUrl: string; teamName?: string; mode: SubmissionMode; effort: "low" | "high" };
  try {
    const value = await readJson(request, API_BODY_LIMIT_BYTES);
    if (!object(value) || Object.keys(value).some((key) => !["repoUrl", "teamName", "mode", "effort"].includes(key))) throw new Error("Invalid submission body");
    if (typeof value.repoUrl !== "string" || value.repoUrl.length > 512 || !["production", "validation"].includes(String(value.mode))) throw new Error("Invalid submission body");
    if (value.teamName !== undefined && (typeof value.teamName !== "string" || value.teamName.trim().length > 100)) throw new Error("Invalid team name");
    if (value.effort !== undefined && value.effort !== "low" && value.effort !== "high") throw new Error("Invalid scoring effort");
    if (value.mode === "production" && value.effort === "low") throw new Error("Production judging requires high effort");
    input = { repoUrl: value.repoUrl, mode: value.mode as SubmissionMode, effort: value.mode === "production" ? "high" : value.effort === "high" ? "high" : "low", ...(typeof value.teamName === "string" ? { teamName: value.teamName } : {}) };
  } catch (error) {
    return invalid(error);
  }
  let repo;
  try {
    repo = normalizeGitHubRepoUrl(input.repoUrl);
  } catch (error) {
    return invalid(error);
  }
  const existing = await env.JUDGE_DB.prepare("SELECT * FROM devday_judge_submissions WHERE event_id = ? AND repo_normalized = ? AND mode = ?").bind(EVENT_ID, repo.normalized, input.mode).first<SubmissionRow>();
  if (existing) return jsonResponse({ submission: toPublic(existing) });
  if (!submissionsOpen(env)) return jsonResponse({ error: "新しい投稿の受付は停止中です。" }, { status: 403 });
  if (!judgingEnabled(env)) return disabled();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const teamName = input.teamName?.trim() || repo.normalized;
  const max = input.mode === "production" ? PRODUCTION_SUBMISSION_LIMIT : VALIDATION_SUBMISSION_LIMIT;
  try {
    const result = await env.JUDGE_DB.prepare(
      "INSERT INTO devday_judge_submissions (id, event_id, repo_url, repo_normalized, repo_owner, repo_name, team_name, mode, effort, status, dispatch_count, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ? WHERE (SELECT COUNT(*) FROM devday_judge_submissions WHERE event_id = ? AND mode = ?) < ?"
    ).bind(id, EVENT_ID, repo.canonicalUrl, repo.normalized, repo.owner, repo.repo, teamName, input.mode, input.effort, now, now, EVENT_ID, input.mode, max).run();
    if (!result.meta.changes) {
      return jsonResponse({ error: "Submission limit reached", code: "submission_limit" }, { status: 429 });
    }
  } catch (error) {
    const duplicate = await env.JUDGE_DB.prepare("SELECT * FROM devday_judge_submissions WHERE event_id = ? AND repo_normalized = ? AND mode = ?").bind(EVENT_ID, repo.normalized, input.mode).first<SubmissionRow>();
    if (duplicate) return jsonResponse({ submission: toPublic(duplicate) });
    throw error;
  }
  const row = await getRow(id, env);
  if (!row) throw new Error("Inserted submission missing");
  if (!await sendQueueMessage(env, row)) return jsonResponse({ error: "Scoring queue send failed", code: "queue_send_failed" }, { status: 503 });
  return jsonResponse({ submission: toPublic(row) }, { status: 202 });
}

async function getSubmission(id: string, env: Env): Promise<Response> {
  const row = await getRow(id, env);
  return row ? jsonResponse(toPublic(row)) : jsonResponse({ error: "Not found" }, { status: 404 });
}

async function retrySubmission(request: Request, id: string, env: Env): Promise<Response> {
  let highValidation = false;
  try {
    const body = await readJson(request, API_BODY_LIMIT_BYTES);
    if (!object(body) || Object.keys(body).some((key) => !["confirm", "effort"].includes(key)) || body.confirm !== true || (body.effort !== undefined && body.effort !== "high")) throw new Error("Invalid retry body");
    highValidation = body.effort === "high";
  } catch (error) {
    return invalid(error);
  }
  if (!judgingEnabled(env)) return disabled();
  const current = await getRow(id, env);
  if (!current) return jsonResponse({ error: "Not found" }, { status: 404 });
  if (highValidation && current.mode !== "validation") return invalid(new Error("Effort changes require validation mode"));
  if (current.attempts >= 3 || current.dispatch_count >= 3) return jsonResponse({ error: "Retry limit reached", code: "retry_limit" }, { status: 409 });
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.parse(now) - 30 * 60 * 1000).toISOString();
  const staleProcessing = current.status === "processing" && current.started_at && current.started_at < staleBefore;
  const staleQueued = current.status === "queued" && current.updated_at < staleBefore;
  const completedLowValidation = highValidation && current.mode === "validation" && current.effort === "low" && current.status === "completed";
  if (current.status !== "failed" && !staleProcessing && !staleQueued && !completedLowValidation) {
    return jsonResponse({ error: "Retry is unavailable for this submission", code: "retry_unavailable" }, { status: 409 });
  }
  const updated = await env.JUDGE_DB.prepare(
    "UPDATE devday_judge_submissions SET status = 'queued', effort = ?, dispatch_count = dispatch_count + 1, callback_token = NULL, started_at = NULL, completed_at = NULL, pinned_sha = NULL, failure_message = NULL, result_json = NULL, outcome_json = NULL, updated_at = ? WHERE id = ? AND event_id = ? AND attempts < 3 AND attempts = ? AND dispatch_count < 3 AND dispatch_count = ? AND callback_token IS ? AND (status = 'failed' OR (status = 'processing' AND started_at < ?) OR (status = 'queued' AND updated_at < ?) OR (? = 1 AND status = 'completed' AND mode = 'validation' AND effort = 'low')) RETURNING *"
  ).bind(highValidation ? "high" : current.effort, now, id, EVENT_ID, current.attempts, current.dispatch_count, current.callback_token, staleBefore, staleBefore, Number(completedLowValidation)).first<SubmissionRow>();
  if (updated) {
    if (!await sendQueueMessage(env, updated)) return jsonResponse({ error: "Scoring queue send failed", code: "queue_send_failed" }, { status: 503 });
    return jsonResponse({ submission: toPublic(updated) }, { status: 202 });
  }
  const latest = await getRow(id, env);
  return latest && (latest.attempts >= 3 || latest.dispatch_count >= 3)
    ? jsonResponse({ error: "Retry limit reached", code: "retry_limit" }, { status: 409 })
    : jsonResponse({ error: "Retry is unavailable for this submission", code: "retry_unavailable" }, { status: 409 });
}

async function getRow(id: string, env: Env): Promise<SubmissionRow | null> {
  return env.JUDGE_DB.prepare("SELECT * FROM devday_judge_submissions WHERE id = ? AND event_id = ?").bind(id, EVENT_ID).first<SubmissionRow>();
}

async function sendQueueMessage(env: Env, row: SubmissionRow): Promise<boolean> {
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

function toPublic(row: SubmissionRow): PublicSubmissionRecord {
  return {
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
    mode: row.mode,
    effort: row.effort,
    status: row.status,
    attempts: row.attempts,
    dispatches: row.dispatch_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureMessage: row.failure_message,
    result: row.result_json ? JSON.parse(row.result_json) as PublicScoreResult : null
  };
}

async function listSubmissions(env: Env): Promise<PublicSubmissionRecord[]> {
  const rows = await env.JUDGE_DB.prepare("SELECT * FROM devday_judge_submissions WHERE event_id = ? ORDER BY created_at DESC, id DESC").bind(EVENT_ID).all<SubmissionRow>();
  return rows.results.map(toPublic);
}

async function ranking(env: Env): Promise<RankingEntry[]> {
  const rows = await env.JUDGE_DB.prepare("SELECT * FROM devday_judge_submissions WHERE event_id = ? AND mode = 'production' AND status = 'completed' AND result_json IS NOT NULL").bind(EVENT_ID).all<SubmissionRow>();
  const scored = rows.results.map((row) => ({ row, result: JSON.parse(row.result_json!) as PublicScoreResult }))
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
    event: { id: EVENT_ID, name: EVENT_NAME, date: EVENT_DATE, targetTeams: TARGET_TEAMS, finalistCount: FINALIST_COUNT },
    open: submissionsOpen(env),
    counts,
    budget: {
      limitUsd: account.limit_micro_usd / 1_000_000,
      spentUsd: account.spent_micro_usd / 1_000_000,
      reservedUsd: account.reserved_micro_usd / 1_000_000,
      remainingUsd: (account.limit_micro_usd - account.spent_micro_usd - account.reserved_micro_usd) / 1_000_000
    },
    items,
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
  return object(value) && Object.keys(value).length === 5 && value.eventId === EVENT_ID
    && shortString(value.submissionId, 100) && /^[A-Za-z0-9-]+$/.test(value.submissionId)
    && (value.mode === "production" || value.mode === "validation")
    && Number.isSafeInteger(value.attempt) && Number(value.attempt) >= 0 && Number(value.attempt) <= 2
    && Number.isSafeInteger(value.dispatch) && Number(value.dispatch) >= 1 && Number(value.dispatch) <= 3;
}

export async function claimQueueMessage(message: ScoringQueueMessage, env: Env): Promise<LeaseJob | null> {
  if (!validQueueMessage(message)) return null;
  const queued = await getRow(message.submissionId, env);
  if (!queued || queued.mode !== message.mode || queued.status !== "queued" || queued.attempts !== message.attempt || queued.dispatch_count !== message.dispatch) return null;
  if (!judgingEnabled(env)) {
    const now = new Date().toISOString();
    const failure = "Judging is paused. Retry after it resumes.";
    await env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET status = 'failed', updated_at = ?, completed_at = ?, failure_message = ?, outcome_json = ? WHERE id = ? AND event_id = ? AND mode = ? AND status = 'queued' AND attempts = ? AND dispatch_count = ?")
      .bind(now, now, failure, JSON.stringify({ kind: "failed", message: failure }), message.submissionId, EVENT_ID, message.mode, message.attempt, message.dispatch).run();
    return null;
  }
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = await env.JUDGE_DB.prepare(
    "UPDATE devday_judge_submissions SET status = 'processing', callback_token = ?, started_at = ?, updated_at = ?, attempts = attempts + 1 WHERE id = ? AND event_id = ? AND mode = ? AND status = 'queued' AND attempts = ? AND attempts < 3 AND dispatch_count = ? RETURNING *"
  ).bind(token, now, now, message.submissionId, EVENT_ID, message.mode, message.attempt, message.dispatch).first<SubmissionRow>();
  if (!row) return null;
  const job: LeaseJob = {
    submissionId: row.id,
    repoUrl: row.repo_url,
    repo: { owner: row.repo_owner, repo: row.repo_name, normalized: row.repo_normalized, canonicalUrl: row.repo_url },
    teamName: row.team_name,
    mode: row.mode,
    startedAt: row.started_at!,
    effort: row.mode === "production" ? "high" : row.effort,
    callbackToken: token,
    pinnedSha: null,
    defaultBranch: null,
    summary: `${row.repo_normalized} processing-time repository snapshot`
  };
  return job;
}

export async function callback(request: Request, env: Env): Promise<Response> {
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
  const now = new Date().toISOString();
  const status = body.outcome.kind === "completed" ? "completed" : "failed";
  const resultJson = body.outcome.kind === "completed" ? JSON.stringify(body.outcome.result) : null;
  const pinnedSha = body.outcome.kind === "completed" ? body.outcome.result.pinnedSha : null;
  const failure = body.outcome.kind === "completed" ? null : body.outcome.message;
  const updated = await env.JUDGE_DB.prepare(
    "UPDATE devday_judge_submissions SET status = ?, updated_at = ?, completed_at = ?, pinned_sha = ?, failure_message = ?, result_json = ?, outcome_json = ? WHERE id = ? AND status = 'processing' AND callback_token = ? RETURNING *"
  ).bind(status, now, now, pinnedSha, failure, resultJson, outcomeJson, body.submissionId, body.callbackToken).first<SubmissionRow>();
  if (updated) return jsonResponse({ ok: true, submission: toPublic(updated) });
  const current = await getRow(body.submissionId, env);
  return current?.callback_token === body.callbackToken && current.outcome_json === outcomeJson
    ? jsonResponse({ ok: true, submission: toPublic(current) })
    : jsonResponse({ error: "Stale callback" }, { status: 409 });
}

export async function reserve(request: Request, env: Env): Promise<Response> {
  if (!judgingEnabled(env)) return disabled();
  let input: { submissionId: string; callbackToken: string; reservationId: string; reservation: BudgetReservationInput };
  try {
    const value = await readJson(request, API_BODY_LIMIT_BYTES);
    if (!object(value) || !shortString(value.submissionId, 100) || !shortString(value.callbackToken, 100) || !shortString(value.reservationId, 100) || !object(value.reservation)) throw new Error("Invalid reservation");
    const reservation = value.reservation;
    if (!validModel(reservation.kind, reservation.model) || !safeCount(reservation.maxInputTokens) || reservation.maxInputTokens >= 272_000 || !safeCount(reservation.maxOutputTokens) || !positiveMoney(reservation.reservedUsd)) throw new Error("Invalid reservation");
    if (reservation.kind === "decisions" && reservation.maxOutputTokens !== 0) throw new Error("Decisions must reserve zero output tokens");
    const required = reservation.kind === "decisions"
      ? reservation.maxInputTokens * 0.1 / 1_000_000
      : (reservation.maxInputTokens * 2.5 + reservation.maxOutputTokens * 10) / 1_000_000;
    if (micro(reservation.reservedUsd) < micro(required)) throw new Error("Reservation is below the maximum call cost");
    input = { submissionId: value.submissionId, callbackToken: value.callbackToken, reservationId: value.reservationId, reservation: reservation as unknown as BudgetReservationInput };
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
  const now = new Date().toISOString();
  try {
    const results = await env.JUDGE_DB.batch([
      env.JUDGE_DB.prepare("UPDATE devday_judge_budget_accounts SET reserved_micro_usd = reserved_micro_usd + ? WHERE mode = ? AND spent_micro_usd + reserved_micro_usd + ? <= limit_micro_usd AND NOT EXISTS (SELECT 1 FROM devday_judge_budget_reservations WHERE id = ?) AND EXISTS (SELECT 1 FROM devday_judge_submissions WHERE id = ? AND callback_token = ? AND status = 'processing' AND mode = ?)").bind(amount, job.mode, amount, input.reservationId, job.id, input.callbackToken, job.mode),
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
  const cacheWrite = input.usage.cacheWriteInputTokens ?? 0;
  const expectedCost = input.usage.kind === "decisions"
    ? input.usage.inputTokens * 0.1 / 1_000_000
    : ((input.usage.inputTokens - input.usage.cachedInputTokens - cacheWrite) * 2 + input.usage.cachedInputTokens * 0.1 + cacheWrite * 2.5 + input.usage.outputTokens * 10) / 1_000_000;
  if (actual < micro(expectedCost)) return jsonResponse({ error: "Usage cost is below the recorded token cost" }, { status: 409 });
  if (actual > reservation.reserved_micro_usd || input.usage.costUsd > reservation.reserved_micro_usd / 1_000_000) return jsonResponse({ error: "Usage exceeds reservation" }, { status: 409 });
  const usageJson = JSON.stringify(input.usage);
  if (reservation.status === "settled") return reservation.actual_micro_usd === actual && reservation.usage_json === usageJson
    ? jsonResponse({ ok: true, spentUsd: actual / 1_000_000 })
    : jsonResponse({ error: "Settlement conflict" }, { status: 409 });
  const job = await getRow(input.submissionId, env);
  if (job?.status !== "processing" || job.callback_token !== input.callbackToken) return jsonResponse({ error: "Stale lease" }, { status: 409 });
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
  return Math.ceil(amount * 1_000_000);
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

async function readJson(request: Request, limit: number): Promise<unknown> {
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
