import type { BudgetReservationInput, BudgetUsage } from "./types";

export const MAX_MODEL_INPUT_TOKENS = 922_000;
export const MODEL_CONTEXT_TOKENS = 1_050_000;
export const LONG_INPUT_THRESHOLD = 272_000;

function integer(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid pricing token count");
}

function validate(kind: string, model: string, input: number, output: number): void {
  if (!((kind === "decisions" && model === "gpt-6-luna") || (kind === "responses" && model === "gpt-6.1-sol"))) {
    throw new Error("Invalid pricing kind/model pair");
  }
  integer(input);
  integer(output);
  if (input > MAX_MODEL_INPUT_TOKENS || output > 128_000 || input + output > MODEL_CONTEXT_TOKENS) {
    throw new Error("Pricing token bounds exceed model context");
  }
  if (kind === "decisions" && output !== 0) throw new Error("Decisions output tokens must be zero");
}

function dollars(tenthsOfMicrodollars: bigint): number {
  return Number((tenthsOfMicrodollars + 9n) / 10n) / 1_000_000;
}

export function quoteReservation(input: Pick<BudgetReservationInput, "kind" | "model" | "maxInputTokens" | "maxOutputTokens">): number {
  const { kind, model, maxInputTokens, maxOutputTokens } = input;
  validate(kind, model, maxInputTokens, maxOutputTokens);
  const long = maxInputTokens > LONG_INPUT_THRESHOLD;
  return dollars(BigInt(maxInputTokens) * BigInt(kind === "decisions" ? long ? 2 : 1 : long ? 50 : 25)
    + BigInt(maxOutputTokens) * BigInt(long ? 150 : 100));
}

export function calculateUsageCost(input: Pick<BudgetUsage, "kind" | "model" | "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheWriteInputTokens">): number {
  const { kind, model, inputTokens, outputTokens, cachedInputTokens } = input;
  const cacheWriteInputTokens = input.cacheWriteInputTokens ?? 0;
  validate(kind, model, inputTokens, outputTokens);
  integer(cachedInputTokens);
  integer(cacheWriteInputTokens);
  if (cachedInputTokens > inputTokens || cacheWriteInputTokens > inputTokens - cachedInputTokens) {
    throw new Error("Cached and cache-write tokens exceed total input tokens");
  }
  if (kind === "decisions" && cacheWriteInputTokens !== 0) throw new Error("Decisions cache-write tokens must be zero");
  const long = inputTokens > LONG_INPUT_THRESHOLD;
  if (kind === "decisions") return dollars(BigInt(inputTokens) * BigInt(long ? 2 : 1));
  return dollars((BigInt(inputTokens - cachedInputTokens - cacheWriteInputTokens) * 20n
    + BigInt(cachedInputTokens) + BigInt(cacheWriteInputTokens) * 25n) * BigInt(long ? 2 : 1)
    + BigInt(outputTokens) * BigInt(long ? 150 : 100));
}
