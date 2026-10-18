import { CRITERIA } from "../shared/constants";
import { visibleAttackScore, validateAttackProbability } from "../shared/attack-score";
import { buildDecisionsQuestions, buildExplanationPrompt } from "../shared/prompt";
import { CONDITION_PROBABILITY_THRESHOLD, DECISION_CONDITIONS, deriveConditionScores } from "../shared/decision-conditions";
import { packModelEvidence, SHARED_CONTENT_INSTRUCTIONS } from "../shared/model-evidence";
import { DEVDAY_REFERENCE_VERSION } from "../shared/devday-reference";
import { RUBRIC_VERSION } from "../shared/rubric";
import { explanationModelResultSchema, explanationOutputSchema, implementationEligibility, prepareFullSourceSnapshot, validatePublicScoreResult } from "../shared/validation";
import { calculateUsageCost, MAX_MODEL_INPUT_TOKENS, MODEL_CONTEXT_TOKENS, quoteReservation } from "../shared/pricing";
import type { ApiReservation, ApiUsage, CriterionKey, LeaseJob, PublicScoreResult, RepoEvidenceSnapshot } from "../shared/types";
import { fetchRepoEvidence, resolveRepoEvidence, RetryableGithubError, zeroResultForAssessment } from "./github";

export type { ApiReservation, ApiUsage } from "../shared/types";

export interface ScoringOptions {
  effort?: "low" | "medium" | "high";
  apiKey?: string;
  trustedFeatureReference?: string;
  fetch?: typeof globalThis.fetch;
  onSnapshotBytes?: (serializedBytes: number) => void;
  beforeSnapshot?: (snapshot: RepoEvidenceSnapshot) => Promise<void>;
  beforeCall?: (reservation: ApiReservation) => Promise<string | void>;
  afterCall?: (usage: ApiUsage) => Promise<void>;
}

export class RetryableScoringError extends Error {}

const DECISIONS_MODEL = "gpt-6-luna";
const RESPONSES_MODEL = "gpt-6.1-sol";
const TIMEOUT_MS = 180_000;

export async function scoreSubmissionDecisions(job: LeaseJob, options: ScoringOptions = {}): Promise<{ result: PublicScoreResult; snapshot: RepoEvidenceSnapshot }> {
  let snapshot: RepoEvidenceSnapshot;
  try {
    const frozen = job.frozenResolution;
    if (frozen?.assessment === "scored") {
      if (!frozen.pinnedSha || !frozen.defaultBranch) throw new Error("Frozen repository authority is incomplete");
      snapshot = await fetchRepoEvidence(job.repo, frozen.pinnedSha, frozen.defaultBranch, frozen.summary);
    } else if (frozen) {
      if (!["missing_or_private", "empty_repository", "no_default_branch"].includes(frozen.assessment)
        || frozen.pinnedSha !== null || frozen.defaultBranch !== null) throw new Error("Invalid frozen repository assessment");
      snapshot = {
        repo: job.repo,
        pinnedSha: null,
        defaultBranch: null,
        summary: frozen.summary,
        assessment: frozen.assessment as "missing_or_private" | "empty_repository" | "no_default_branch",
        files: []
      };
    } else {
      snapshot = job.pinnedSha && job.defaultBranch
        ? await fetchRepoEvidence(job.repo, job.pinnedSha, job.defaultBranch, job.summary)
        : await resolveRepoEvidence(job.repo, job.summary);
    }
  } catch (error) {
    if (error instanceof RetryableGithubError) {
      throw new RetryableScoringError(error.message);
    }
    throw error;
  }
  return scoreCanonicalSnapshot(snapshot, { ...options, effort: options.effort ?? (job.mode === "validation" ? job.effort ?? "low" : "medium") });
}

export async function scoreSnapshotWithDecisions(snapshot: RepoEvidenceSnapshot, options: ScoringOptions = {}): Promise<PublicScoreResult> {
  return (await scoreCanonicalSnapshot(snapshot, options)).result;
}

async function scoreCanonicalSnapshot(source: RepoEvidenceSnapshot, options: ScoringOptions): Promise<{ result: PublicScoreResult; snapshot: RepoEvidenceSnapshot }> {
  const prepared = await prepareFullSourceSnapshot(source);
  options.onSnapshotBytes?.(new TextEncoder().encode(prepared.serialized).byteLength);
  const snapshot: RepoEvidenceSnapshot = JSON.parse(prepared.serialized);
  const eligibility = implementationEligibility(snapshot);
  if (snapshot.assessment !== "scored") {
    await options.beforeSnapshot?.(JSON.parse(prepared.serialized));
    return { snapshot, result: validatePublicScoreResult({ ...zeroResultForAssessment(snapshot), eligibility }) };
  }

  const { key, effort } = scoringSettings(options);
  const fetcher = options.fetch ?? globalThis.fetch;
  const modelEvidence = packModelEvidence(snapshot);
  const modelSource = modelEvidence.shared ? JSON.stringify(modelEvidence.data) : prepared.serialized;
  const baseQuestions = buildDecisionsQuestions(options.trustedFeatureReference);
  const questions = modelEvidence.shared ? baseQuestions.map((question) => ({ ...question, instructions: `${question.instructions}\n${SHARED_CONTENT_INSTRUCTIONS}` })) : baseQuestions;
  const decisionsBody = {
    model: DECISIONS_MODEL,
    input: modelSource,
    questions
  };
  const maxInputTokens = await countInput({
    model: DECISIONS_MODEL,
    input: [
      { role: "developer", content: JSON.stringify(questions) },
      { role: "user", content: modelSource }
    ]
  }, 0, key, fetcher);
  const future = explanationBody(snapshot, {
    repoAssessment: snapshot.assessment,
    pinnedSha: snapshot.pinnedSha,
    criteria: CRITERIA.map(({ key, label }) => ({ key, label, score: 10 })),
    total: 40
  }, options.trustedFeatureReference, effort, RUBRIC_VERSION, Object.fromEntries(DECISION_CONDITIONS.map((condition) => [condition.name, true])), Object.fromEntries(DECISION_CONDITIONS.map((condition) => [condition.name, 1])));
  await countInput({ model: RESPONSES_MODEL, input: future.input }, future.max_output_tokens, key, fetcher);
  await options.beforeSnapshot?.(JSON.parse(prepared.serialized));
  const decisionsCall = await callApi("decisions", decisionsBody, maxInputTokens, 0, key, fetcher, options);
  const signals = parseDecisions(decisionsCall.body);
  const result = validatePublicScoreResult({
    eligibility,
    reviewRequired: signals.reviewRequired,
    summary: "採点が完了しました。採点理由を生成中です。",
    publicReason: "Decisionsによる点数が確定しました。採点理由を生成中です。",
    repoAssessment: "scored",
    pinnedSha: snapshot.pinnedSha,
    criteria: CRITERIA.map((item) => ({
      key: item.key,
      label: item.label,
      score: signals.scores[item.key],
      reason: "採点理由を生成中です",
      evidencePaths: []
    })),
    total: CRITERIA.reduce((sum, item) => sum + signals.scores[item.key], 0),
    attackProbability: signals.attackProbability,
    attackScore: visibleAttackScore(signals.attackProbability),
    usage: {
      ...prepared.metadata,
      model: DECISIONS_MODEL,
      effort,
      decisionsModel: DECISIONS_MODEL,
      referenceVersion: options.trustedFeatureReference === undefined ? DEVDAY_REFERENCE_VERSION : "organizer-override",
      rubricVersion: RUBRIC_VERSION,
      inputTokens: decisionsCall.usage.inputTokens,
      outputTokens: decisionsCall.usage.outputTokens,
      costUsd: decisionsCall.usage.costUsd,
      decisionsScores: signals.scores,
      decisionsConditions: signals.conditions,
      decisionsConditionProbabilities: signals.probabilities,
      conditionThreshold: CONDITION_PROBABILITY_THRESHOLD,
      requestIds: decisionsCall.usage.requestId ? [decisionsCall.usage.requestId] : []
    }
  });
  return { result, snapshot };
}

export async function explainScoredSnapshot(
  snapshot: RepoEvidenceSnapshot,
  fixedResult: PublicScoreResult,
  options: ScoringOptions = {}
): Promise<PublicScoreResult> {
  const prepared = await prepareFullSourceSnapshot(snapshot);
  snapshot = JSON.parse(prepared.serialized) as RepoEvidenceSnapshot;
  const fixed = validatePublicScoreResult(fixedResult, new Set(snapshot.files.map((file) => file.path)));
  if (fixed.repoAssessment !== snapshot.assessment || fixed.pinnedSha !== snapshot.pinnedSha) {
    throw new Error("Fixed assessment or pinned SHA does not match the snapshot");
  }
  const eligibility = implementationEligibility(snapshot);
  if (snapshot.assessment !== "scored") return { ...fixed, eligibility };
  if (fixed.eligibility !== eligibility) throw new Error("Fixed eligibility does not match the snapshot");
  const prior = fixed.usage;
  if (!prior || prior.model !== DECISIONS_MODEL || prior.decisionsModel !== DECISIONS_MODEL
    || prior.explanationModel !== undefined || prior.outputTokens !== 0 || prior.requestIds.length > 1
    || fixed.attackProbability === undefined
    || fixed.criteria.some((item) => prior.decisionsScores[item.key] !== item.score)) {
    throw new Error("Fixed scores must match authoritative Decisions usage");
  }
  if (prior.fullSource !== true || prior.sourceFiles !== prepared.metadata.sourceFiles
    || prior.sourceBytes !== prepared.metadata.sourceBytes || prior.sourceHash !== prepared.metadata.sourceHash) {
    throw new Error("Fixed Decisions full-source metadata does not match the snapshot; partial snapshots cannot be retried");
  }
  const { key, effort } = scoringSettings({ ...options, effort: options.effort ?? prior.effort });
  const fixedScores = {
    repoAssessment: fixed.repoAssessment,
    pinnedSha: fixed.pinnedSha,
    criteria: fixed.criteria.map(({ key, label, score }) => ({ key, label, score })),
    total: fixed.total
  };
  const responsesBody = explanationBody(snapshot, fixedScores, options.trustedFeatureReference, effort, prior.rubricVersion, prior.decisionsConditions, prior.decisionsConditionProbabilities);
  const outputCap = responsesBody.max_output_tokens;
  const fetcher = options.fetch ?? globalThis.fetch;
  const maxInputTokens = await countInput({ model: RESPONSES_MODEL, input: responsesBody.input }, outputCap, key, fetcher);
  const responsesCall = await callApi("responses", responsesBody, maxInputTokens, outputCap, key, fetcher, options);
  const modelResult = parseResponseResult(responsesCall.body);
  if (modelResult.repoAssessment !== fixed.repoAssessment || modelResult.pinnedSha !== fixed.pinnedSha
    || modelResult.total !== fixed.total
    || modelResult.criteria.some((item) => {
      const original = fixed.criteria.find((criterion) => criterion.key === item.key);
      return !original || original.score !== item.score || original.label !== item.label;
    })) {
    throw new Error("Explanation changed authoritative scores, assessment, labels, or pinned SHA");
  }
  if (modelResult.criteria.some((item) => item.evidencePaths.length === 0) && !modelResult.reviewRequired) {
    throw new Error("Explanation without evidence requires reviewRequired");
  }
  if (fixed.eligibility === "no_implementation" && fixed.total > 0 && !modelResult.reviewRequired) {
    throw new Error("Explanation without implementation support requires reviewRequired");
  }
  if (modelResult.criteria.some((item) => !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(item.reason))) {
    throw new Error("Explanation reasons must be Japanese");
  }
  const result: PublicScoreResult = {
    ...modelResult,
    reviewRequired: Boolean(fixed.reviewRequired || modelResult.reviewRequired),
    eligibility: fixed.eligibility,
    attackProbability: fixed.attackProbability,
    attackScore: fixed.attackScore,
    usage: {
      ...prior,
      effort,
      explanationModel: RESPONSES_MODEL,
      inputTokens: prior.inputTokens + responsesCall.usage.inputTokens,
      outputTokens: prior.outputTokens + responsesCall.usage.outputTokens,
      costUsd: (Math.round(prior.costUsd * 1_000_000) + Math.round(responsesCall.usage.costUsd * 1_000_000)) / 1_000_000,
      requestIds: [...prior.requestIds, ...(responsesCall.usage.requestId ? [responsesCall.usage.requestId] : [])]
    }
  };
  return validatePublicScoreResult(result, new Set(snapshot.files.map((file) => file.path)));
}

function scoringSettings(options: ScoringOptions) {
  const key = options.apiKey;
  if (!key) throw new Error("Hackathon OpenAI API key is required");
  const effort = options.effort ?? "medium";
  if (effort !== "low" && effort !== "medium" && effort !== "high") throw new Error("Invalid scoring effort");
  return { key, effort };
}

function explanationBody(snapshot: RepoEvidenceSnapshot, fixedScores: object, reference: string | undefined, effort: "low" | "medium" | "high", version = RUBRIC_VERSION, conditionChecks?: Record<string, boolean>, conditionProbabilities?: Record<string, number>) {
  const modelEvidence = packModelEvidence(snapshot);
  const prompt = buildExplanationPrompt(reference, version);
  return {
    model: RESPONSES_MODEL,
    reasoning: { effort },
    max_output_tokens: effort === "low" ? 6000 : effort === "medium" ? 8192 : 12000,
    store: false,
    input: [
      { role: "developer", content: modelEvidence.shared ? `${prompt}\n\n${SHARED_CONTENT_INSTRUCTIONS}` : prompt },
      { role: "user", content: JSON.stringify({ snapshot: modelEvidence.data, fixedScores, ...(conditionChecks ? { conditionChecks, conditionProbabilities, conditionThreshold: CONDITION_PROBABILITY_THRESHOLD } : {}) }) }
    ],
    text: { format: { type: "json_schema", name: "hackathon_explanation", strict: true, schema: explanationOutputSchema } }
  };
}

async function countInput(body: { model: string; input: Array<{ role: string; content: string }> }, outputCap: number, key: string, fetcher: typeof globalThis.fetch): Promise<number> {
  const { data } = await requestApi("responses/input_tokens", body, key, fetcher);
  if (data.error != null || data.refusal != null || data.incomplete_details != null
    || (data.status !== undefined && data.status !== "completed")) throw new Error("Input token counter failed or was incomplete");
  if (data.model !== undefined && data.model !== body.model) throw new Error("Input token counter returned an unexpected model");
  const actual = nonnegativeInteger(data.input_tokens);
  if (actual === 0) throw new Error("Input token counter must return a positive token count");
  const bound = Number((BigInt(actual) * 105n + 99n) / 100n + 8192n);
  if (!Number.isSafeInteger(bound) || bound > MAX_MODEL_INPUT_TOKENS || bound + outputCap > MODEL_CONTEXT_TOKENS) {
    throw new Error("API request exceeds conservative input or context token bound");
  }
  return bound;
}

async function callApi(
  kind: "decisions" | "responses",
  body: object,
  maxInputTokens: number,
  maxOutputTokens: number,
  apiKey: string,
  fetcher: typeof globalThis.fetch,
  options: ScoringOptions
): Promise<{ body: Record<string, unknown>; usage: ApiUsage }> {
  const model = kind === "decisions" ? DECISIONS_MODEL : RESPONSES_MODEL;
  const reservedUsd = quoteReservation({ kind, model, maxInputTokens, maxOutputTokens });
  const reservationId = await options.beforeCall?.({ kind, model, maxInputTokens, maxOutputTokens, reservedUsd });
  const { data, requestId } = await requestApi(kind, body, apiKey, fetcher);
  if (data.model !== model) throw new Error("OpenAI returned an unexpected model");
  const usage = parseUsage(kind, data.usage, requestId, reservationId);
  if (usage.inputTokens > maxInputTokens || usage.outputTokens > maxOutputTokens || usage.costUsd > reservedUsd) {
    throw new Error("API usage exceeded reserved token or cost bounds");
  }
  await options.afterCall?.(usage);
  return { body: data, usage };
}

async function requestApi(path: string, body: object, apiKey: string, fetcher: typeof globalThis.fetch): Promise<{ data: Record<string, unknown>; requestId: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  let raw: unknown;
  try {
    response = await fetcher(`https://api.openai.com/v1/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableScoringError(`OpenAI request returned status ${response.status}`);
      }
      throw new Error(`OpenAI request returned status ${response.status}`);
    }
    raw = await response.json();
  } catch (error) {
    if (error instanceof RetryableScoringError) throw error;
    if (error instanceof Error && error.message.startsWith("OpenAI request returned status")) throw error;
    if (controller.signal.aborted) throw new RetryableScoringError("OpenAI request timed out");
    if (error instanceof SyntaxError) throw new Error("OpenAI response is not valid JSON");
    throw new RetryableScoringError("OpenAI request failed or timed out");
  } finally {
    clearTimeout(timer);
  }
  return { data: record(raw), requestId: response.headers.get("x-request-id") };
}

function parseUsage(kind: "decisions" | "responses", input: unknown, requestId: string | null, reservationId: string | void): ApiUsage {
  const usage = record(input);
  const inputTokens = nonnegativeInteger(usage.input_tokens);
  const outputTokens = kind === "decisions" && usage.output_tokens === undefined ? 0 : nonnegativeInteger(usage.output_tokens);
  if (kind === "decisions" && outputTokens !== 0) {
    throw new Error("Decisions usage must have zero output tokens");
  }
  const details = usage.input_tokens_details === undefined ? {} : record(usage.input_tokens_details);
  const cachedInputTokens = details.cached_tokens === undefined ? 0 : nonnegativeInteger(details.cached_tokens);
  const cacheWriteInputTokens = details.cache_write_tokens === undefined ? 0 : nonnegativeInteger(details.cache_write_tokens);
  if (kind === "decisions" && cacheWriteInputTokens !== 0) {
    throw new Error("Decisions usage must have zero cache-write tokens");
  }
  if (cachedInputTokens + cacheWriteInputTokens > inputTokens) {
    throw new Error("Cached and cache-write tokens exceed total input tokens");
  }
  const model = kind === "decisions" ? DECISIONS_MODEL : RESPONSES_MODEL;
  const costUsd = calculateUsageCost({ kind, model, inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens });
  return {
    kind,
    model,
    ...(typeof reservationId === "string" ? { reservationId } : {}),
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    costUsd,
    ...(requestId ? { requestId } : {})
  };
}

function parseDecisions(input: Record<string, unknown>): { attackProbability: number; scores: Record<CriterionKey, number>; conditions: Record<string, boolean>; probabilities: Record<string, number>; reviewRequired: boolean } {
  if (input.refusal != null || (input.status !== undefined && input.status !== "completed")
    || input.incomplete_details != null || input.error != null) {
    throw new Error("Decisions judgment was refused or incomplete");
  }
  const answers = input.answers;
  if (!Array.isArray(answers) || answers.length !== DECISION_CONDITIONS.length + 1) {
    throw new Error("Decisions must provide all condition answers and the attack predicate");
  }
  const expected = new Set(["prompt_injection", ...DECISION_CONDITIONS.map((item) => item.name)]);
  const conditions: Record<string, boolean> = {};
  const probabilities: Record<string, number> = {};
  let attackProbability: number | undefined;
  for (const raw of answers) {
    const answer = record(raw);
    if (answer.refusal != null || answer.error != null
      || (answer.status !== undefined && answer.status !== "completed") || answer.incomplete_details != null) {
      throw new Error("Decisions answer was refused");
    }
    const name = answer.name;
    if (typeof name !== "string" || !expected.delete(name)) {
      throw new Error("Decisions answer name is duplicate or unexpected");
    }
    if (name === "prompt_injection") {
      if (answer.type !== "predicate") {
        throw new Error("Prompt injection answer must be a predicate");
      }
      attackProbability = validateAttackProbability(finiteNumber(answer.probability));
      continue;
    }
    if (answer.type !== "predicate") {
      throw new Error("Condition answer must be a predicate");
    }
    const probability = validateAttackProbability(finiteNumber(answer.probability));
    probabilities[name] = probability;
    conditions[name] = probability >= CONDITION_PROBABILITY_THRESHOLD;
  }
  if (expected.size || attackProbability === undefined) {
    throw new Error("Decisions answers are incomplete");
  }
  return { attackProbability, conditions, probabilities, ...deriveConditionScores(conditions) };
}

function parseResponseResult(input: Record<string, unknown>) {
  if (input.status !== "completed" || input.error != null || input.incomplete_details != null || input.refusal != null) {
    throw new Error("Responses judgment is incomplete or failed");
  }
  const output = input.output;
  if (!Array.isArray(output)) {
    throw new Error("Responses judgment has no output");
  }
  const textParts: string[] = [];
  for (const rawItem of output) {
    const item = record(rawItem);
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const rawPart of item.content) {
      const part = record(rawPart);
      if (part.type === "refusal" || part.refusal !== undefined) {
        throw new Error("Responses judgment was refused");
      }
      if (part.type === "output_text" && typeof part.text === "string") {
        textParts.push(part.text);
      }
    }
  }
  if (textParts.length !== 1 || !textParts[0]?.trim()) {
    throw new Error("Responses judgment text is missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textParts[0]);
  } catch {
    throw new Error("Responses judgment text is invalid JSON");
  }
  return explanationModelResultSchema.parse(parsed);
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Malformed API response");
  }
  return input as Record<string, unknown>;
}

function finiteNumber(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new Error("API response contains an invalid number");
  }
  return input;
}

function nonnegativeInteger(input: unknown): number {
  const value = finiteNumber(input);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("API usage contains an invalid token count");
  }
  return value;
}
