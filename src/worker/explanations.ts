import { EVENT_ID, MAX_MEMORY_DEFERRALS } from "../shared/constants";
import { jsonResponse } from "../shared/json";
import type { ExplanationQueueMessage, LeaseJob, PublicScoreResult, RepoEvidenceSnapshot } from "../shared/types";
import { implementationEligibility, prepareFullSourceSnapshot, validatePublicScoreResult } from "../shared/validation";
import { effectiveEffort, getRow, toPublic, workEnabled, type SubmissionRow } from "./api";
import { hasStoredEvidenceSnapshot, requireStoredEvidenceSnapshot, validateSnapshot } from "./evidence-store";

export { validateSnapshot } from "./evidence-store";

export function matchesFrozenResolution(row: SubmissionRow, result: PublicScoreResult): boolean {
  if (!row.frozen_resolution_json) return true;
  const resolution = JSON.parse(row.frozen_resolution_json) as { pinnedSha: string | null; assessment: string };
  return result.pinnedSha === resolution.pinnedSha && (result.repoAssessment === resolution.assessment
    || (resolution.assessment === "scored" && result.repoAssessment === "empty_repository"));
}

export async function persistDecisions(job: LeaseJob, result: PublicScoreResult, snapshot: RepoEvidenceSnapshot, env: Env): Promise<SubmissionRow | null> {
  const row = await getRow(job.submissionId, env);
  if (!row || row.callback_token !== job.callbackToken || row.status !== "processing" || row.result_json) return null;
  validateSnapshot(snapshot, row);
  await requireStoredEvidenceSnapshot(snapshot, row, env);
  const fixed = validatePublicScoreResult(result, new Set(snapshot.files.map((file) => file.path)));
  if (!matchesFrozenResolution(row, fixed) || fixed.pinnedSha !== snapshot.pinnedSha || fixed.repoAssessment !== snapshot.assessment) throw new Error("Result does not match frozen repository");
  if (fixed.eligibility !== implementationEligibility(snapshot)) throw new Error("Invalid implementation eligibility");
  const explain = fixed.repoAssessment === "scored";
  if (explain && (fixed.usage?.fullSource !== true || fixed.usage.model !== "gpt-6-luna" || fixed.usage.decisionsModel !== "gpt-6-luna" || fixed.usage.explanationModel !== undefined
    || fixed.usage.outputTokens !== 0 || fixed.criteria.some((item) => fixed.usage!.decisionsScores[item.key] !== item.score))) throw new Error("Invalid Decisions authority");
  if (fixed.usage?.fullSource) {
    const { metadata } = await prepareFullSourceSnapshot(snapshot);
    if (fixed.usage.sourceHash !== metadata.sourceHash || fixed.usage.sourceFiles !== metadata.sourceFiles || fixed.usage.sourceBytes !== metadata.sourceBytes) throw new Error("Invalid Decisions source authority");
  }
  const now = new Date().toISOString();
  const resultJson = JSON.stringify(fixed);
  return env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET result_json = ?, decisions_result_json = ?, scored_at = ?, updated_at = ?, explanation_status = ?, explanation_dispatches = explanation_dispatches + ?, explanation_requested_at = ?, explanation_started_at = NULL, status = ?, completed_at = ?, failure_message = NULL, outcome_json = ? WHERE id = ? AND event_id = ? AND status = 'processing' AND callback_token = ? AND attempts = ? AND result_json IS NULL AND (? = 0 OR explanation_dispatches < 3) RETURNING *")
    .bind(resultJson, resultJson, now, now, explain ? "pending" : "completed", Number(explain), explain ? now : null, explain ? "processing" : "completed", explain ? null : now, explain ? null : JSON.stringify({ kind: "completed", result: fixed }), row.id, EVENT_ID, job.callbackToken, row.attempts, Number(explain)).first<SubmissionRow>();
}

export function validExplanationMessage(value: unknown): value is ExplanationQueueMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return Object.keys(message).every((key) => ["type", "eventId", "submissionId", "attempt", "dispatch", "memoryDeferrals"].includes(key)) && message.type === "explain_submission" && message.eventId === EVENT_ID
    && (message.memoryDeferrals === undefined || Number.isSafeInteger(message.memoryDeferrals) && Number(message.memoryDeferrals) >= 0 && Number(message.memoryDeferrals) <= MAX_MEMORY_DEFERRALS)
    && typeof message.submissionId === "string" && /^[A-Za-z0-9-]{1,100}$/.test(message.submissionId)
    && Number.isSafeInteger(message.attempt) && Number(message.attempt) >= 1 && Number(message.attempt) <= 3
    && Number.isSafeInteger(message.dispatch) && Number(message.dispatch) >= 1 && Number(message.dispatch) <= 3;
}

export async function failExplanation(row: SubmissionRow, dispatch: number, failure: string, env: Env): Promise<void> {
  const now = new Date().toISOString();
  await env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET explanation_status = 'failed', status = 'completed', failure_message = ?, result_json = json_set(result_json, '$.reviewRequired', json('true')), completed_at = ?, updated_at = ?, outcome_json = NULL WHERE id = ? AND event_id = ? AND callback_token = ? AND attempts = ? AND explanation_dispatches = ? AND explanation_status IN ('pending', 'processing') AND result_json IS NOT NULL")
    .bind(failure, now, now, row.id, EVENT_ID, row.callback_token, row.attempts, dispatch).run();
}

export async function sendExplanation(row: SubmissionRow, env: Env): Promise<boolean> {
  try {
    if (!workEnabled(env)) throw new Error("paused");
    await env.EXPLANATION_QUEUE.send({ type: "explain_submission", eventId: EVENT_ID, submissionId: row.id, attempt: row.attempts, dispatch: row.explanation_dispatches });
    return true;
  } catch {
    await failExplanation(row, row.explanation_dispatches, "Explanation queue delivery failed or judging paused. Scores are retained. Retry explanations explicitly after recovery.", env);
    return false;
  }
}

export async function retryExplanation(row: SubmissionRow, effort: "medium" | "high" | undefined, env: Env): Promise<Response> {
  if (!workEnabled(env)) return jsonResponse({ error: "Judging is disabled", code: "judging_disabled" }, { status: 410 });
  if (!row.decisions_result_json || !row.callback_token || !await hasStoredEvidenceSnapshot(row, env)) return jsonResponse({ error: "This historical score has no saved Decisions snapshot. Its score is preserved and explanation regeneration is unavailable.", code: "explanation_snapshot_missing" }, { status: 409 });
  if (row.explanation_dispatches >= 3) return jsonResponse({ error: "Explanation dispatch limit reached", code: "retry_limit" }, { status: 409 });
  const fixed = JSON.parse(row.decisions_result_json) as PublicScoreResult;
  if (fixed.repoAssessment !== "scored") return jsonResponse({ error: "This zero result needs no explanation", code: "retry_unavailable" }, { status: 409 });
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.parse(now) - 30 * 60 * 1000).toISOString();
  const stale = (row.explanation_status === "pending" || row.explanation_status === "processing")
    && (row.explanation_started_at ?? row.explanation_requested_at ?? row.scored_at ?? row.updated_at) < staleBefore;
  const upgrade = Boolean(effort) && row.mode === "validation" && effectiveEffort(row) === "low" && row.explanation_status === "completed";
  if (row.explanation_status !== "failed" && !stale && !upgrade) return jsonResponse({ error: "Explanation retry requires a failure, 30 minutes of inactivity, or an explicit validation low-effort upgrade", code: "retry_unavailable" }, { status: 409 });
  const updated = await env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET status = 'processing', explanation_status = 'pending', explanation_dispatches = explanation_dispatches + 1, explanation_requested_at = ?, explanation_started_at = NULL, scoring_effort = ?, completed_at = NULL, failure_message = NULL, outcome_json = NULL, updated_at = ? WHERE id = ? AND event_id = ? AND callback_token = ? AND attempts = ? AND result_json IS NOT NULL AND explanation_dispatches = ? AND explanation_dispatches < 3 AND (explanation_status = 'failed' OR (explanation_status IN ('pending', 'processing') AND COALESCE(explanation_started_at, explanation_requested_at, scored_at, updated_at) < ?) OR (? = 1 AND explanation_status = 'completed' AND mode = 'validation' AND COALESCE(scoring_effort, effort) = 'low')) RETURNING *")
    .bind(now, row.mode === "production" ? "medium" : effort ?? effectiveEffort(row), now, row.id, EVENT_ID, row.callback_token, row.attempts, row.explanation_dispatches, staleBefore, Number(upgrade)).first<SubmissionRow>();
  if (!updated) return jsonResponse({ error: "Explanation retry unavailable", code: "retry_unavailable" }, { status: 409 });
  if (!await sendExplanation(updated, env)) return jsonResponse({ error: "Explanation queue send failed; scores retained", code: "queue_send_failed" }, { status: 503 });
  return jsonResponse({ submission: toPublic(updated) }, { status: 202 });
}

export async function claimExplanation(message: ExplanationQueueMessage, env: Env): Promise<SubmissionRow | null> {
  const row = await getRow(message.submissionId, env);
  if (!row || row.status !== "processing" || row.explanation_status !== "pending" || row.attempts !== message.attempt
    || row.explanation_dispatches !== message.dispatch || !row.result_json) return null;
  if (!workEnabled(env)) {
    await failExplanation(row, message.dispatch, "Judging is paused. Scores are retained. Retry explanations after it resumes.", env);
    return null;
  }
  const now = new Date().toISOString();
  return env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET explanation_status = 'processing', explanation_started_at = ?, updated_at = ? WHERE id = ? AND event_id = ? AND callback_token = ? AND status = 'processing' AND explanation_status = 'pending' AND attempts = ? AND explanation_dispatches = ? AND result_json IS NOT NULL RETURNING *")
    .bind(now, now, row.id, EVENT_ID, row.callback_token, message.attempt, message.dispatch).first<SubmissionRow>();
}

function sameConditionEvidence(left: Readonly<Record<string, boolean | number>> | undefined, right: Readonly<Record<string, boolean | number>> | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key]);
}

export async function completeExplanation(row: SubmissionRow, value: PublicScoreResult, snapshot: RepoEvidenceSnapshot, env: Env): Promise<void> {
  const result = validatePublicScoreResult(value, new Set(snapshot.files.map((file) => file.path)));
  const fixed = JSON.parse(row.result_json!) as PublicScoreResult;
  if (result.pinnedSha !== fixed.pinnedSha || result.pinnedSha !== snapshot.pinnedSha || !matchesFrozenResolution(row, result)
    || result.repoAssessment !== fixed.repoAssessment || result.total !== fixed.total || result.attackProbability !== fixed.attackProbability || result.attackScore !== fixed.attackScore
    || result.eligibility !== fixed.eligibility
    || result.criteria.some((item) => !fixed.criteria.some((original) => original.key === item.key && original.score === item.score && original.label === item.label))) throw new Error("Explanation changed fixed scores");
  if (result.usage?.model !== "gpt-6-luna" || result.usage.decisionsModel !== "gpt-6-luna" || result.usage.explanationModel !== "gpt-6.1-sol"
    || result.criteria.some((item) => result.usage!.decisionsScores[item.key] !== item.score)) throw new Error("Explanation changed Decisions authority");
  if (result.usage.fullSource !== fixed.usage?.fullSource || result.usage.sourceHash !== fixed.usage?.sourceHash
    || result.usage.sourceFiles !== fixed.usage?.sourceFiles || result.usage.sourceBytes !== fixed.usage?.sourceBytes) throw new Error("Explanation changed source authority");
  if (result.usage.rubricVersion !== fixed.usage?.rubricVersion || result.usage.referenceVersion !== fixed.usage?.referenceVersion) throw new Error("Explanation changed judging policy authority");
  if (result.usage.conditionThreshold !== fixed.usage?.conditionThreshold
    || !sameConditionEvidence(result.usage.decisionsConditions, fixed.usage?.decisionsConditions)
    || !sameConditionEvidence(result.usage.decisionsConditionProbabilities, fixed.usage?.decisionsConditionProbabilities)) throw new Error("Explanation changed condition authority");
  const now = new Date().toISOString();
  await env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET result_json = ?, explanation_status = 'completed', status = 'completed', completed_at = ?, updated_at = ?, failure_message = NULL, outcome_json = ? WHERE id = ? AND event_id = ? AND callback_token = ? AND attempts = ? AND explanation_dispatches = ? AND explanation_status = 'processing' AND status = 'processing' AND result_json IS NOT NULL")
    .bind(JSON.stringify(result), now, now, JSON.stringify({ kind: "completed", result }), row.id, EVENT_ID, row.callback_token, row.attempts, row.explanation_dispatches).run();
}
