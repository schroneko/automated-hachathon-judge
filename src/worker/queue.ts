import { explainScoredSnapshot, scoreSubmissionDecisions, type ScoringOptions } from "../container/scorer";
import { EVENT_ID, MAX_MEMORY_DEFERRALS, MEMORY_DEFERRAL_DELAY_SECONDS } from "../shared/constants";
import { tryAcquireJudgingMemory, type JudgingMemoryLease } from "../shared/judging-memory";
import { prepareFullSourceSnapshot } from "../shared/validation";
import type { BudgetReservationInput, BudgetUsage, ExplanationQueueMessage, LeaseJob, RecoveryQueueMessage, ScoringQueueMessage } from "../shared/types";
import { callback, claimQueueMessage, claimRecoveryMessage, effectiveEffort, getRow, reserve, settle, validQueueMessage, validRecoveryMessage, workEnabled, type SubmissionRow } from "./api";
import { claimExplanation, completeExplanation, failExplanation, persistDecisions, sendExplanation, validExplanationMessage } from "./explanations";
import { loadEvidenceSnapshot, persistEvidenceSnapshot } from "./evidence-store";

export async function processScoringMessage(value: unknown, env: Env): Promise<void> {
  if (!validQueueMessage(value)) return;
  const row = await getRow(value.submissionId, env);
  if (!row || row.event_id !== value.eventId || row.result_json || row.mode !== value.mode || row.status !== "queued"
    || row.attempts !== value.attempt || row.dispatch_count !== value.dispatch
    || (row.recovery_dispatch_count === 1 && row.callback_token !== null)) return;
  if (!workEnabled(env)) {
    await claimQueueMessage(value, env);
    return;
  }
  const memory = tryAcquireJudgingMemory();
  if (!memory) {
    await deferForMemory(value, row, env);
    return;
  }
  try {
    const job = await claimQueueMessage(value, env);
    if (job) await executeScoring(job, env, memory);
  } finally {
    memory.release();
  }
}

export async function processRecoveryMessage(value: unknown, env: Env): Promise<void> {
  if (!validRecoveryMessage(value)) return;
  const row = await getRow(value.submissionId, env);
  if (!row || row.event_id !== value.eventId || row.result_json || row.mode !== value.mode || row.status !== "queued"
    || row.attempts !== value.attempt || row.callback_token !== value.callbackToken || row.recovery_dispatch_count !== 1) return;
  if (!workEnabled(env)) {
    await claimRecoveryMessage(value, env);
    return;
  }
  const memory = tryAcquireJudgingMemory();
  if (!memory) {
    await deferForMemory(value, row, env);
    return;
  }
  try {
    const job = await claimRecoveryMessage(value, env);
    if (job) await executeScoring(job, env, memory);
  } finally {
    memory.release();
  }
}

async function executeScoring(job: LeaseJob, env: Env, memory: JudgingMemoryLease): Promise<void> {
  let stage = "model_check";
  try {
    const zero = job.frozenResolution && job.frozenResolution.assessment !== "scored";
    const apiKey = zero ? "" : await requireModel(env, "gpt-6-luna");
    stage = "scoring";
    const { result, snapshot } = await scoreSubmissionDecisions(job, {
      ...budgetOptions(job.submissionId, job.callbackToken, env),
      onSnapshotBytes: (bytes) => memory.reduceForSnapshot(bytes),
      apiKey,
      effort: job.mode === "production" ? "medium" : job.effort
    });
    stage = "validation";
    const saved = await persistDecisions(job, result, snapshot, env);
    if (saved?.explanation_status === "pending") await sendExplanation(saved, env);
    return;
  } catch (error) {
    const message = failureMessage(error, stage === "validation" ? "The scoring result failed validation. Review and retry manually." : "Scoring failed. Review the submission and retry manually.");
    const diagnostic = failureDiagnostic(error);
    console.error(JSON.stringify({ event: "judging_failed", submissionId: job.submissionId, stage, message, diagnostic }));
    const response = await callback(internalRequest({ submissionId: job.submissionId, callbackToken: job.callbackToken, outcome: { kind: "failed", message } }), env);
    if (!response.ok && response.status !== 403 && response.status !== 409) throw new Error("Scoring finalization failed");
  }
}

export async function processExplanationMessage(value: unknown, env: Env): Promise<void> {
  if (!validExplanationMessage(value)) return;
  const pending = await getRow(value.submissionId, env);
  if (!pending || pending.event_id !== value.eventId || pending.status !== "processing" || pending.explanation_status !== "pending"
    || pending.attempts !== value.attempt || pending.explanation_dispatches !== value.dispatch || !pending.result_json) return;
  if (!workEnabled(env)) {
    await claimExplanation(value, env);
    return;
  }
  const memory = tryAcquireJudgingMemory();
  if (!memory) {
    await deferForMemory(value, pending, env);
    return;
  }
  try {
    const row = await claimExplanation(value, env);
    if (!row) return;
    await executeExplanation(row, value, env, memory);
  } finally {
    memory.release();
  }
}

async function executeExplanation(row: SubmissionRow, value: ExplanationQueueMessage, env: Env, memory: JudgingMemoryLease): Promise<void> {
  try {
    if (!row.decisions_result_json || !row.callback_token) throw new Error("Missing evidence snapshot");
    const snapshot = await loadEvidenceSnapshot(row, env);
    if (!snapshot || snapshot.fullSource !== true) throw new Error("Missing complete source evidence snapshot");
    memory.reduceForSnapshot(new TextEncoder().encode((await prepareFullSourceSnapshot(snapshot)).serialized).byteLength);
    const apiKey = await requireModel(env, "gpt-6.1-sol");
    const result = await explainScoredSnapshot(snapshot, JSON.parse(row.decisions_result_json), {
      ...budgetOptions(row.id, row.callback_token, env, value.dispatch),
      apiKey,
      effort: row.mode === "production" ? "medium" : effectiveEffort(row)
    });
    await completeExplanation(row, result, snapshot, env);
  } catch (error) {
    await failExplanation(row, value.dispatch, failureMessage(error, "Explanation failed validation or generation. Scores are retained. Review and retry explanations manually."), env);
  }
}

async function deferForMemory(message: ScoringQueueMessage | RecoveryQueueMessage | ExplanationQueueMessage, row: SubmissionRow, env: Env): Promise<void> {
  const deferralCount = message.memoryDeferrals ?? 0;
  let failure = "Judging memory capacity stayed unavailable. Retry manually when capacity is available.";
  if (deferralCount < MAX_MEMORY_DEFERRALS) {
    try {
      const deferred = { ...message, memoryDeferrals: deferralCount + 1 };
      if ("type" in deferred && deferred.type === "explain_submission") {
        await env.EXPLANATION_QUEUE.send(deferred, { delaySeconds: MEMORY_DEFERRAL_DELAY_SECONDS });
      } else {
        await env.SCORING_QUEUE.send(deferred, { delaySeconds: MEMORY_DEFERRAL_DELAY_SECONDS });
      }
    } catch {
      failure = "Judging memory deferral delivery failed. Retry manually when queue delivery is available.";
      await failMemoryDeferral(message, row, failure, deferralCount, env);
      return;
    }
    const nextCount = deferralCount + 1;
    if (nextCount === 1 || nextCount % 60 === 0 || nextCount === MAX_MEMORY_DEFERRALS) {
      console.log(JSON.stringify({ event: "judging_memory_deferred", submissionId: message.submissionId, deferralCount: nextCount }));
    }
    return;
  }
  await failMemoryDeferral(message, row, failure, deferralCount, env);
}

async function failMemoryDeferral(message: ScoringQueueMessage | RecoveryQueueMessage | ExplanationQueueMessage, row: SubmissionRow, failure: string, deferralCount: number, env: Env): Promise<void> {
  if ("type" in message && message.type === "explain_submission") {
    const now = new Date().toISOString();
    await env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET explanation_status = 'failed', status = 'completed', failure_message = ?, result_json = json_set(result_json, '$.reviewRequired', json('true')), completed_at = ?, updated_at = ?, outcome_json = NULL WHERE id = ? AND event_id = ? AND status = 'processing' AND callback_token = ? AND attempts = ? AND explanation_dispatches = ? AND explanation_status = 'pending' AND result_json IS NOT NULL")
      .bind(`${failure} Scores are retained; review and retry explanations manually.`, now, now, row.id, EVENT_ID, row.callback_token, row.attempts, message.dispatch).run();
  } else {
    const now = new Date().toISOString();
    await env.JUDGE_DB.prepare("UPDATE devday_judge_submissions SET status = 'failed', failure_message = ?, updated_at = ?, completed_at = ?, outcome_json = ? WHERE id = ? AND event_id = ? AND mode = ? AND status = 'queued' AND result_json IS NULL AND attempts = ? AND dispatch_count = ? AND callback_token IS ? AND recovery_dispatch_count = ?")
      .bind(failure, now, now, JSON.stringify({ kind: "failed", message: failure }), row.id, EVENT_ID, row.mode, row.attempts, row.dispatch_count, row.callback_token, row.recovery_dispatch_count).run();
  }
  console.error(JSON.stringify({ event: "judging_memory_deferral_failed", submissionId: message.submissionId, deferralCount }));
}

function budgetOptions(submissionId: string, callbackToken: string, env: Env, explanationDispatch?: number): Pick<ScoringOptions, "beforeCall" | "afterCall" | "beforeSnapshot"> {
  let snapshotStored = false;
  return {
    ...(explanationDispatch === undefined ? { beforeSnapshot: async (snapshot) => {
      const row = await getRow(submissionId, env);
      if (!row || row.callback_token !== callbackToken || row.status !== "processing" || row.result_json) throw new Error("Stale evidence lease");
      await persistEvidenceSnapshot(snapshot, row, env);
      snapshotStored = true;
    } } : {}),
    beforeCall: async (reservation: BudgetReservationInput): Promise<string> => {
      if (reservation.kind !== (explanationDispatch === undefined ? "decisions" : "responses")) throw new Error("Budget reservation failed");
      if (explanationDispatch === undefined && !snapshotStored) throw new Error("Evidence snapshot was not saved before scoring");
      const reservationId = crypto.randomUUID();
      const response = await reserve(internalRequest({ submissionId, callbackToken, reservationId, reservation, ...(explanationDispatch === undefined ? {} : { explanationDispatch }) }), env);
      if (!response.ok) throw new Error(response.status === 402 ? "Budget exhausted" : "Budget reservation failed");
      return reservationId;
    },
    afterCall: async (usage: BudgetUsage): Promise<void> => {
      if (!usage.reservationId) throw new Error("Usage settlement failed");
      const response = await settle(internalRequest({ submissionId, callbackToken, reservationId: usage.reservationId, usage }), env);
      if (!response.ok) throw new Error("Usage settlement failed");
    }
  };
}

function failureMessage(error: unknown, fallback: string): string {
  if (capacityFailure(error)) return "全文の容量が審査上限を超えています。要確認です。ソースは途中で切らず、採点を停止しました。";
  return error instanceof Error && ["Budget exhausted", "Scoring service is unavailable", "Budget reservation failed", "Usage settlement failed"].includes(error.message) ? error.message : fallback;
}

function capacityFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return new Set([
    "GitHub evidence exceeds candidate file capacity", "GitHub evidence file exceeds byte capacity", "GitHub evidence exceeds file capacity", "GitHub evidence exceeds total byte capacity", "GitHub evidence snapshot exceeds serialized byte capacity",
    "Git tree exceeds depth capacity or has a cycle", "Git tree exceeds entry capacity", "Git tree path exceeds byte capacity", "Git tree metadata exceeds byte capacity", "Evidence snapshot exceeds limits",
    "Snapshot file count limit exceeded", "Snapshot file byte limit exceeded or size mismatch", "Snapshot total byte limit exceeded", "Snapshot serialized byte limit exceeded", "API request exceeds conservative input or context token bound"
  ]).has(error.message) || /^GitHub (?:upload-pack|public refs) exceeds [0-9]+ bytes$/.test(error.message)
    || /^Invalid Git upload-pack: (?:object size cap exceeded|aggregate expanded size cap exceeded|object count cap exceeded|wire size cap exceeded|delta size exceeds object cap|invalid zlib stream or inflated size cap exceeded|prefix packet count cap exceeded|delta depth cap exceeded|delta depth or resolution work cap exceeded)$/.test(error.message);
}

function failureDiagnostic(error: unknown): string {
  if (capacityFailure(error)) return "Full repository evidence exceeds configured source or context capacity";
  if (!(error instanceof Error)) return "UnknownError";
  const upstreamStatus = /^(?:Pinned )?GitHub (?:API|raw|public refs|upload-pack) (?:fetch )?failed with status [0-9]{3}$/.exec(error.message)?.[0];
  if (upstreamStatus) return upstreamStatus;
  if (/^(?:GitHub upload-pack |Invalid Git upload-pack: |Pinned Git commit |Filtered Git pack )/.test(error.message)) return "GitHub upload-pack validation failed";
  if (error.message.startsWith("Git tree ")) return "Git tree validation failed";
  if (/^(?:GitHub (?:API|raw|public refs|upload-pack) redirected from canonical repository|Pinned GitHub tree was not found|Pinned GitHub tree is truncated or malformed|Pinned repository has no readable source evidence|OpenAI request returned status [0-9]{3})$/.test(error.message)) return error.message;
  return new Set(["Error", "TypeError", "SyntaxError", "AbortError", "RetryableGithubError", "RetryableScoringError"]).has(error.name) ? error.name : "UnknownError";
}

function internalRequest(body: unknown): Request {
  return new Request("https://internal.invalid/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function requireModel(env: Env, model: string): Promise<string> {
  const apiKey = env.OPENAI_API_KEY_20261018_HACKATHON?.trim();
  if (!apiKey) throw new Error("Scoring service is unavailable");
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Model listing failed with status ${response.status}`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) throw new Error("Invalid model listing");
  const ids = new Set((body as { data: Array<{ id?: unknown }> }).data.map((item) => item?.id));
  if (!ids.has(model)) throw new Error("Required model unavailable");
  return apiKey;
}
