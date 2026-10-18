import { z } from "zod";
import { API_BODY_LIMIT_BYTES, CALLBACK_BODY_LIMIT_BYTES, CRITERIA } from "./constants";
import { visibleAttackScore } from "./attack-score";
import { MAX_CRITERION_SCORE, MAX_TOTAL_SCORE, SCORE_LEVELS, rubricText } from "./rubric";
import type { CriterionKey, FinalizePayload, NormalizedRepo, PublicScoreResult, SubmissionMode } from "./types";

const submissionBodySchema = z.object({
  repoUrl: z.string().min(1).max(512),
  teamName: z.string().trim().max(100).optional(),
  mode: z.enum(["production", "validation"])
}).strict();

const usageSchema = z.object({
  model: z.string().min(1),
  effort: z.enum(["low", "high"]),
  decisionsModel: z.string().min(1),
  referenceVersion: z.string().min(1).max(100).optional(),
  rubricVersion: z.string().min(1).max(100).optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative(),
  decisionsScores: z.record(z.string(), z.number().finite().min(0).max(MAX_CRITERION_SCORE)),
  requestIds: z.array(z.string().min(1)).max(2)
}).strict();

const criterionSchema = z.object({
  key: z.enum(["technical", "ux", "impact", "idea"]),
  label: z.string().min(1),
  score: z.union(SCORE_LEVELS.map((score) => z.literal(score))),
  reason: z.string().min(1).max(280),
  evidencePaths: z.array(z.string().min(1).max(300)).max(24)
}).strict();

export const publicScoreResultSchema = z.object({
  summary: z.string().min(1).max(400),
  publicReason: z.string().min(1).max(400),
  repoAssessment: z.enum([
    "scored",
    "empty_repository",
    "missing_or_private",
    "no_default_branch",
    "retryable_failure",
    "unjudgeable"
  ]),
  pinnedSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  criteria: z.array(criterionSchema).length(4),
  total: z.number().int().min(0).max(MAX_TOTAL_SCORE),
  attackScore: z.number().int().min(80).max(100).nullable(),
  attackProbability: z.number().finite().min(0).max(1).optional(),
  usage: usageSchema.optional()
}).strict();

export const scoringModelResultSchema = publicScoreResultSchema.omit({
  attackScore: true,
  attackProbability: true,
  usage: true
}).strict();

const scoringCallbackBodySchema = z.object({
  submissionId: z.string().min(1).max(100),
  callbackToken: z.string().min(1).max(100),
  outcome: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("completed"),
      result: publicScoreResultSchema
    }).strict(),
    z.object({
      kind: z.literal("retryable_failure"),
      message: z.string().min(1).max(400)
    }).strict(),
    z.object({
      kind: z.literal("failed"),
      message: z.string().min(1).max(400)
    }).strict()
  ])
}).strict();

export const scoringOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "publicReason", "repoAssessment", "pinnedSha", "criteria", "total"],
  properties: {
    summary: { type: "string" },
    publicReason: { type: "string" },
    repoAssessment: {
      type: "string",
      enum: ["scored", "empty_repository", "missing_or_private", "no_default_branch", "retryable_failure", "unjudgeable"]
    },
    pinnedSha: {
      anyOf: [
        { type: "string" },
        { type: "null" }
      ]
    },
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "score", "reason", "evidencePaths"],
        properties: {
          key: { type: "string", enum: ["technical", "ux", "impact", "idea"] },
          label: { type: "string" },
          score: { type: "integer", enum: SCORE_LEVELS },
          reason: { type: "string" },
          evidencePaths: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    },
    total: { type: "integer" }
  }
} as const;

export function parseSubmissionBody(input: string): { repoUrl: string; teamName?: string; mode: SubmissionMode } {
  if (new TextEncoder().encode(input).length > API_BODY_LIMIT_BYTES) {
    throw new Error("Request body too large");
  }
  const parsed = JSON.parse(input);
  const value = submissionBodySchema.parse(parsed);
  return {
    repoUrl: value.repoUrl,
    mode: value.mode,
    ...(value.teamName === undefined ? {} : { teamName: value.teamName })
  };
}

export function parseScoringCallbackBody(
  input: string
): FinalizePayload {
  if (new TextEncoder().encode(input).length > CALLBACK_BODY_LIMIT_BYTES) {
    throw new Error("Request body too large");
  }
  const parsed = scoringCallbackBodySchema.parse(JSON.parse(input));
  if (parsed.outcome.kind === "completed") {
    return {
      ...parsed,
      outcome: {
        ...parsed.outcome,
        result: validatePublicScoreResult(parsed.outcome.result)
      }
    };
  }
  return { submissionId: parsed.submissionId, callbackToken: parsed.callbackToken, outcome: parsed.outcome };
}

export function normalizeGitHubRepoUrl(input: string): NormalizedRepo {
  const trimmed = input.trim();
  const url = new URL(trimmed);
  if (url.protocol !== "https:") {
    throw new Error("GitHub URL must use https");
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new Error("Only github.com repository URLs are supported");
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("Repository URL must not include credentials, ports, queries, or fragments");
  }
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error("Repository URL must be in the form https://github.com/owner/repo");
  }
  const ownerRaw = parts[0];
  const repoRaw = parts[1];
  if (!ownerRaw || !repoRaw) {
    throw new Error("Repository URL must be in the form https://github.com/owner/repo");
  }
  const owner = ownerRaw.trim();
  const repo = repoRaw.replace(/\.git$/i, "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("Repository URL contains unsupported characters");
  }
  const normalized = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  return {
    owner,
    repo,
    normalized,
    canonicalUrl: `https://github.com/${owner}/${repo}`
  };
}

export function validatePublicScoreResult(input: unknown, allowedEvidencePaths?: ReadonlySet<string>): PublicScoreResult {
  const parsed = publicScoreResultSchema.parse(input);
  if (parsed.attackProbability !== undefined && visibleAttackScore(parsed.attackProbability) !== parsed.attackScore) {
    throw new Error("Attack score does not match probability visibility");
  }
  if (parsed.usage && Object.keys(parsed.usage.decisionsScores).sort().join(",") !== "idea,impact,technical,ux") {
    throw new Error("Usage Decisions scores must contain exactly four criteria");
  }
  const seen = new Set<CriterionKey>();
  for (const criterion of parsed.criteria) {
    seen.add(criterion.key);
    if (criterion.label !== criteriaLabels()[criterion.key]) {
      throw new Error("Criterion labels must match the official criteria");
    }
    if (allowedEvidencePaths && criterion.evidencePaths.some((path) => !allowedEvidencePaths.has(path))) {
      throw new Error("Evidence paths must exist in the pinned snapshot");
    }
  }
  if (seen.size !== 4) {
    throw new Error("Criteria keys must be unique");
  }
  const total = parsed.criteria.reduce((sum, item) => sum + item.score, 0);
  if (total !== parsed.total) {
    throw new Error("Total score does not match criteria sum");
  }
  if (parsed.repoAssessment !== "scored") {
    const hasNonZero = parsed.criteria.some((item) => item.score !== 0);
    if (hasNonZero || parsed.total !== 0) {
      throw new Error("Non-scored repository states must have zero scores");
    }
  }
  if (parsed.repoAssessment === "scored" && parsed.pinnedSha === null) {
    throw new Error("Scored repositories must include a pinned SHA");
  }
  const { usage, ...result } = parsed;
  if (!usage) return result;
  const { referenceVersion, ...audit } = usage;
  return { ...result, usage: { ...audit, ...(referenceVersion === undefined ? {} : { referenceVersion }) } };
}

export function scoreAnchorsText(): string {
  return rubricText();
}

export function criteriaLabels(): Record<CriterionKey, string> {
  return Object.fromEntries(CRITERIA.map((item) => [item.key, item.label])) as Record<CriterionKey, string>;
}
