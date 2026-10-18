import { explainScoredSnapshot, scoreSubmissionDecisions, type ScoringOptions } from "../container/scorer";
import type { BudgetReservationInput, BudgetUsage, RepoEvidenceSnapshot } from "../shared/types";
import { callback, claimQueueMessage, effectiveEffort, reserve, settle, validQueueMessage } from "./api";
import { claimExplanation, completeExplanation, failExplanation, persistDecisions, sendExplanation, validExplanationMessage, validateSnapshot } from "./explanations";

export async function processScoringMessage(value: unknown, env: Env): Promise<void> {
  if (!validQueueMessage(value)) return;
  const job = await claimQueueMessage(value, env);
  if (!job) return;
  let stage = "model_check";
  try {
    const zero = job.frozenResolution && job.frozenResolution.assessment !== "scored";
    const apiKey = zero ? "" : await requireModel(env, "gpt-6-luna");
    stage = "scoring";
    const { result, snapshot } = await scoreSubmissionDecisions(job, {
      ...budgetOptions(job.submissionId, job.callbackToken, env),
      apiKey,
      effort: job.mode === "production" ? "medium" : job.effort
    });
    stage = "validation";
    const saved = await persistDecisions(job, result, snapshot, env);
    if (saved?.explanation_status === "pending") await sendExplanation(saved, env);
    return;
  } catch (error) {
    const message = failureMessage(error, stage === "validation" ? "The scoring result failed validation. Review and retry manually." : "Scoring failed. Review the submission and retry manually.");
    const diagnostic = error instanceof Error && /^(GitHub API failed with status [0-9]{3}|Pinned GitHub tree was not found|Pinned GitHub tree is truncated or malformed|Pinned repository has no readable source evidence|OpenAI request returned status [0-9]{3}|API request exceeds short-context input bound)$/.test(error.message) ? error.message : error instanceof Error ? error.name : "UnknownError";
    console.error(JSON.stringify({ event: "judging_failed", submissionId: job.submissionId, stage, message, diagnostic }));
    const response = await callback(internalRequest({ submissionId: job.submissionId, callbackToken: job.callbackToken, outcome: { kind: "failed", message } }), env);
    if (!response.ok && response.status !== 403 && response.status !== 409) throw new Error("Scoring finalization failed");
  }
}

export async function processExplanationMessage(value: unknown, env: Env): Promise<void> {
  if (!validExplanationMessage(value)) return;
  const row = await claimExplanation(value, env);
  if (!row) return;
  try {
    if (!row.evidence_snapshot_json || !row.decisions_result_json || !row.callback_token) throw new Error("Missing evidence snapshot");
    const snapshot = JSON.parse(row.evidence_snapshot_json) as RepoEvidenceSnapshot;
    validateSnapshot(snapshot, row);
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

function budgetOptions(submissionId: string, callbackToken: string, env: Env, explanationDispatch?: number): Pick<ScoringOptions, "beforeCall" | "afterCall"> {
  return {
    beforeCall: async (reservation: BudgetReservationInput): Promise<string> => {
      if (reservation.kind !== (explanationDispatch === undefined ? "decisions" : "responses")) throw new Error("Budget reservation failed");
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
  return error instanceof Error && ["Budget exhausted", "Scoring service is unavailable", "Budget reservation failed", "Usage settlement failed"].includes(error.message) ? error.message : fallback;
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
