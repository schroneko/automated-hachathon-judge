import { explainScoredSnapshot, scoreSubmissionDecisions, type ScoringOptions } from "../container/scorer";
import { acquireJudgingMemory, type JudgingMemoryLease } from "../shared/judging-memory";
import { prepareFullSourceSnapshot } from "../shared/validation";
import type { BudgetReservationInput, BudgetUsage, LeaseJob } from "../shared/types";
import { callback, claimQueueMessage, claimRecoveryMessage, effectiveEffort, getRow, reserve, settle, validQueueMessage, validRecoveryMessage } from "./api";
import { claimExplanation, completeExplanation, failExplanation, persistDecisions, sendExplanation, validExplanationMessage } from "./explanations";
import { loadEvidenceSnapshot, persistEvidenceSnapshot } from "./evidence-store";

export async function processScoringMessage(value: unknown, env: Env): Promise<void> {
  if (!validQueueMessage(value)) return;
  const job = await claimQueueMessage(value, env);
  if (!job) return;
  await executeScoring(job, env);
}

export async function processRecoveryMessage(value: unknown, env: Env): Promise<void> {
  if (!validRecoveryMessage(value)) return;
  const job = await claimRecoveryMessage(value, env);
  if (!job) return;
  await executeScoring(job, env);
}

async function executeScoring(job: LeaseJob, env: Env): Promise<void> {
  let stage = "model_check";
  let memory: JudgingMemoryLease | undefined;
  try {
    memory = await acquireJudgingMemory();
    const zero = job.frozenResolution && job.frozenResolution.assessment !== "scored";
    const apiKey = zero ? "" : await requireModel(env, "gpt-6-luna");
    stage = "scoring";
    const { result, snapshot } = await scoreSubmissionDecisions(job, {
      ...budgetOptions(job.submissionId, job.callbackToken, env),
      onSnapshotBytes: (bytes) => memory?.reduceForSnapshot(bytes),
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
  } finally {
    memory?.release();
  }
}

export async function processExplanationMessage(value: unknown, env: Env): Promise<void> {
  if (!validExplanationMessage(value)) return;
  const row = await claimExplanation(value, env);
  if (!row) return;
  let memory: JudgingMemoryLease | undefined;
  try {
    memory = await acquireJudgingMemory();
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
  } finally {
    memory?.release();
  }
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
