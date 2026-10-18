import { scoreSubmission } from "../container/scorer";
import type { BudgetReservationInput, BudgetUsage, FinalizePayload, ScoringQueueMessage } from "../shared/types";
import { callback, claimQueueMessage, reserve, settle, validQueueMessage } from "./api";

export async function processScoringMessage(value: unknown, env: Env): Promise<void> {
  if (!validQueueMessage(value)) return;
  const message: ScoringQueueMessage = value;
  const job = await claimQueueMessage(message, env);
  if (!job) return;
  let outcome: FinalizePayload["outcome"];
  try {
    const apiKey = env.OPENAI_API_KEY_20261018_HACKATHON?.trim();
    if (!apiKey) throw new Error("Scoring service is unavailable");
    await requireModels(apiKey);
    const result = await scoreSubmission(job, {
      apiKey,
      effort: job.mode === "production" ? "high" : job.effort,
      beforeCall: async (reservation: BudgetReservationInput): Promise<string> => {
        const reservationId = crypto.randomUUID();
        const response = await reserve(internalRequest({ submissionId: job.submissionId, callbackToken: job.callbackToken, reservationId, reservation }), env);
        if (!response.ok) throw new Error(response.status === 402 ? "Budget exhausted" : "Budget reservation failed");
        return reservationId;
      },
      afterCall: async (usage: BudgetUsage): Promise<void> => {
        if (!usage.reservationId) throw new Error("Usage settlement failed");
        const response = await settle(internalRequest({ submissionId: job.submissionId, callbackToken: job.callbackToken, reservationId: usage.reservationId, usage }), env);
        if (!response.ok) throw new Error("Usage settlement failed");
      }
    });
    outcome = { kind: "completed", result };
  } catch (error) {
    const message = error instanceof Error && ["Budget exhausted", "Scoring service is unavailable", "Budget reservation failed", "Usage settlement failed"].includes(error.message)
      ? error.message
      : "Scoring failed. Review the submission and retry manually.";
    outcome = { kind: "failed", message };
  }
  let response = await callback(internalRequest({ submissionId: job.submissionId, callbackToken: job.callbackToken, outcome }), env);
  if (outcome.kind === "completed" && (response.status === 400 || response.status === 413)) {
    response = await callback(internalRequest({ submissionId: job.submissionId, callbackToken: job.callbackToken, outcome: { kind: "failed", message: "The scoring result failed validation. Review and retry manually." } }), env);
  }
  if (!response.ok && response.status !== 403 && response.status !== 409) throw new Error("Scoring finalization failed");
}

function internalRequest(body: unknown): Request {
  return new Request("https://internal.invalid/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function requireModels(apiKey: string): Promise<void> {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error("Model listing failed");
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) throw new Error("Invalid model listing");
  const ids = new Set((body as { data: Array<{ id?: unknown }> }).data.map((item) => item?.id));
  if (!ids.has("gpt-6.1-sol") || !ids.has("gpt-6-luna")) throw new Error("Required model unavailable");
}
