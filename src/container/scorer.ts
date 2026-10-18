import { CRITERIA, MAX_EVIDENCE_FILE_BYTES, MAX_EVIDENCE_FILES, MAX_EVIDENCE_TOTAL_BYTES } from "../shared/constants";
import { visibleAttackScore, validateAttackProbability } from "../shared/attack-score";
import { buildDecisionsQuestions, buildScoringPrompt, DECISION_SCORE_LEVELS } from "../shared/prompt";
import { DEVDAY_REFERENCE_VERSION } from "../shared/devday-reference";
import { RUBRIC_VERSION } from "../shared/rubric";
import { scoringModelResultSchema, scoringOutputSchema, validatePublicScoreResult } from "../shared/validation";
import type { ApiReservation, ApiUsage, CriterionKey, LeaseJob, PublicScoreResult, RepoEvidenceSnapshot } from "../shared/types";
import { fetchRepoEvidence, resolveRepoEvidence, RetryableGithubError, zeroResultForAssessment } from "./github";

export type { ApiReservation, ApiUsage } from "../shared/types";

export interface ScoringOptions {
  effort?: "low" | "high";
  apiKey?: string;
  trustedFeatureReference?: string;
  fetch?: typeof globalThis.fetch;
  beforeCall?: (reservation: ApiReservation) => Promise<string | void>;
  afterCall?: (usage: ApiUsage) => Promise<void>;
}

export class RetryableScoringError extends Error {}

const DECISIONS_MODEL = "gpt-6-luna";
const RESPONSES_MODEL = "gpt-6.1-sol";
const TIMEOUT_MS = 180_000;
const MAX_INPUT_TOKENS = 272_000;

export async function scoreSubmission(job: LeaseJob, options: ScoringOptions = {}): Promise<PublicScoreResult> {
  let snapshot: RepoEvidenceSnapshot;
  try {
    snapshot = job.pinnedSha && job.defaultBranch
      ? await fetchRepoEvidence(job.repo, job.pinnedSha, job.defaultBranch, job.summary)
      : await resolveRepoEvidence(job.repo, job.summary);
  } catch (error) {
    if (error instanceof RetryableGithubError) {
      throw new RetryableScoringError(error.message);
    }
    throw error;
  }
  return evaluateSnapshot(snapshot, { ...options, effort: options.effort ?? (job.mode === "validation" ? "low" : "high") });
}

export async function evaluateSnapshot(snapshot: RepoEvidenceSnapshot, options: ScoringOptions = {}): Promise<PublicScoreResult> {
  assertSnapshotAuthority(snapshot);
  if (snapshot.assessment !== "scored") {
    return validatePublicScoreResult(zeroResultForAssessment(snapshot));
  }

  const key = options.apiKey;
  if (!key) {
    throw new Error("Hackathon OpenAI API key is required");
  }
  const effort = options.effort ?? "high";
  if (effort !== "low" && effort !== "high") {
    throw new Error("Invalid scoring effort");
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const questions = buildDecisionsQuestions(options.trustedFeatureReference);
  const decisionsBody = {
    model: DECISIONS_MODEL,
    input: JSON.stringify(snapshot),
    questions
  };
  const decisionsCall = await callApi("decisions", decisionsBody, 0, key, fetcher, options);
  const signals = parseDecisions(decisionsCall.body);
  const prompt = buildScoringPrompt(options.trustedFeatureReference);
  const outputCap = effort === "low" ? 6000 : 12000;
  const responsesBody = {
    model: RESPONSES_MODEL,
    reasoning: { effort },
    max_output_tokens: outputCap,
    store: false,
    input: [
      { role: "developer", content: prompt },
      { role: "user", content: JSON.stringify({ snapshot, decisionsSignals: signals.scores }) }
    ],
    text: { format: { type: "json_schema", name: "hackathon_judgment", strict: true, schema: scoringOutputSchema } }
  };
  const responsesCall = await callApi("responses", responsesBody, outputCap, key, fetcher, options);
  const modelResult = parseResponseResult(responsesCall.body);
  if (modelResult.repoAssessment !== "scored" || modelResult.pinnedSha !== snapshot.pinnedSha) {
    throw new Error("Model assessment or pinned SHA does not match the scored snapshot");
  }
  const result: PublicScoreResult = {
    ...modelResult,
    attackProbability: signals.attackProbability,
    attackScore: visibleAttackScore(signals.attackProbability),
    usage: {
      model: RESPONSES_MODEL,
      effort,
      decisionsModel: DECISIONS_MODEL,
      referenceVersion: options.trustedFeatureReference === undefined ? DEVDAY_REFERENCE_VERSION : "organizer-override",
      rubricVersion: RUBRIC_VERSION,
      inputTokens: decisionsCall.usage.inputTokens + responsesCall.usage.inputTokens,
      outputTokens: decisionsCall.usage.outputTokens + responsesCall.usage.outputTokens,
      costUsd: decisionsCall.usage.costUsd + responsesCall.usage.costUsd,
      decisionsScores: signals.scores,
      requestIds: [decisionsCall.usage.requestId, responsesCall.usage.requestId].filter((id): id is string => typeof id === "string" && id.length > 0)
    }
  };
  return validatePublicScoreResult(result, new Set(snapshot.files.map((file) => file.path)));
}

function assertSnapshotAuthority(snapshot: RepoEvidenceSnapshot): void {
  if (!snapshot || !snapshot.repo || !Array.isArray(snapshot.files)) {
    throw new Error("Invalid repository snapshot");
  }
  const { owner, repo, normalized, canonicalUrl } = snapshot.repo;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)
    || normalized !== `${owner.toLowerCase()}/${repo.toLowerCase()}`
    || canonicalUrl !== `https://github.com/${owner}/${repo}`) {
    throw new Error("Invalid canonical repository identity");
  }
  if (snapshot.assessment !== "scored") {
    if (snapshot.files.length !== 0) {
      throw new Error("Non-scored snapshot must contain no files");
    }
    return;
  }
  if (!snapshot.pinnedSha || !/^[0-9a-f]{40}$/.test(snapshot.pinnedSha)
    || !snapshot.defaultBranch || !snapshot.defaultBranch.trim()) {
    throw new Error("Scored snapshot requires a valid pinned SHA and branch");
  }
  if (snapshot.files.length === 0 || snapshot.files.length > MAX_EVIDENCE_FILES) {
    throw new Error("Scored snapshot requires bounded file evidence");
  }
  const seen = new Set<string>();
  let total = 0;
  for (const file of snapshot.files) {
    if (!file.path || seen.has(file.path) || typeof file.content !== "string" || typeof file.truncated !== "boolean") {
      throw new Error("Invalid snapshot evidence file");
    }
    seen.add(file.path);
    const size = new TextEncoder().encode(file.content).byteLength;
    if (size === 0 || size > MAX_EVIDENCE_FILE_BYTES || file.size !== size) {
      throw new Error("Snapshot file byte limit exceeded");
    }
    total += size;
  }
  if (total > MAX_EVIDENCE_TOTAL_BYTES) {
    throw new Error("Snapshot total byte limit exceeded");
  }
}

async function callApi(
  kind: "decisions" | "responses",
  body: object,
  maxOutputTokens: number,
  apiKey: string,
  fetcher: typeof globalThis.fetch,
  options: ScoringOptions
): Promise<{ body: Record<string, unknown>; usage: ApiUsage }> {
  const payload = JSON.stringify(body);
  const maxInputTokens = new TextEncoder().encode(payload).byteLength + 4096;
  if (maxInputTokens >= MAX_INPUT_TOKENS) {
    throw new Error("API request exceeds short-context input bound");
  }
  const model = kind === "decisions" ? DECISIONS_MODEL : RESPONSES_MODEL;
  const reservedUsd = ceilUsd(kind === "decisions"
    ? maxInputTokens * 0.1 / 1_000_000
    : (maxInputTokens * 2.5 + maxOutputTokens * 10) / 1_000_000);
  const reservationId = await options.beforeCall?.({ kind, model, maxInputTokens, maxOutputTokens, reservedUsd });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  let raw: unknown;
  try {
    response = await fetcher(`https://api.openai.com/v1/${kind}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: payload,
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
  const data = record(raw);
  if (data.model !== model) {
    throw new Error("OpenAI returned an unexpected model");
  }
  const usage = parseUsage(kind, data.usage, response.headers.get("x-request-id"), reservationId);
  await options.afterCall?.(usage);
  if (usage.inputTokens > maxInputTokens || usage.outputTokens > maxOutputTokens) {
    throw new Error("API usage exceeded reserved token bounds");
  }
  return { body: data, usage };
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
  const costUsd = ceilUsd(kind === "decisions"
    ? inputTokens * 0.1 / 1_000_000
    : ((inputTokens - cachedInputTokens - cacheWriteInputTokens) * 2 + cachedInputTokens * 0.1 + cacheWriteInputTokens * 2.5 + outputTokens * 10) / 1_000_000);
  return {
    kind,
    model: kind === "decisions" ? DECISIONS_MODEL : RESPONSES_MODEL,
    ...(typeof reservationId === "string" ? { reservationId } : {}),
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    costUsd,
    ...(requestId ? { requestId } : {})
  };
}

function parseDecisions(input: Record<string, unknown>): { attackProbability: number; scores: Record<CriterionKey, number> } {
  if (input.refusal != null || input.status === "incomplete" || input.error != null) {
    throw new Error("Decisions judgment was refused or incomplete");
  }
  const answers = input.answers;
  if (!Array.isArray(answers) || answers.length !== 5) {
    throw new Error("Decisions must provide five answers");
  }
  const expected = new Set(["prompt_injection", ...CRITERIA.map((item) => item.key)]);
  const scores = {} as Record<CriterionKey, number>;
  let attackProbability: number | undefined;
  for (const raw of answers) {
    const answer = record(raw);
    if (answer.refusal != null) {
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
    if (answer.type !== "score") {
      throw new Error("Rubric answer must be a score");
    }
    const score = finiteNumber(answer.score);
    const confidence = finiteNumber(answer.confidence);
    if (score < 0 || score > DECISION_SCORE_LEVELS.length - 1 || confidence < 0 || confidence > 1) {
      throw new Error("Decisions score or confidence is out of range");
    }
    if (!Array.isArray(answer.probabilities) || answer.probabilities.length !== DECISION_SCORE_LEVELS.length) {
      throw new Error("Decisions score distribution must contain six levels");
    }
    let sum = 0;
    let weighted = 0;
    for (let index = 0; index < DECISION_SCORE_LEVELS.length; index += 1) {
      const point = record(answer.probabilities[index]);
      const probability = finiteNumber(point.probability);
      if (point.value !== index || point.label !== String(DECISION_SCORE_LEVELS[index]) || probability < 0 || probability > 1) {
        throw new Error("Decisions score distribution has invalid levels");
      }
      sum += probability;
      weighted += index * probability;
    }
    if (Math.abs(sum - 1) > 0.001 || Math.abs(weighted - score) > 0.02) {
      throw new Error("Decisions score distribution is inconsistent");
    }
    scores[name as CriterionKey] = score * 2;
  }
  if (expected.size || attackProbability === undefined) {
    throw new Error("Decisions answers are incomplete");
  }
  return { attackProbability, scores };
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
  return scoringModelResultSchema.parse(parsed);
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

function ceilUsd(value: number): number {
  return Math.ceil(value * 1_000_000 - 1e-9) / 1_000_000;
}
