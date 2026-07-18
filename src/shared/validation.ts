import { z } from "zod";
import { API_BODY_LIMIT_BYTES, CRITERIA, SCORE_ANCHORS, SCORER_BUCKET_COUNT } from "./constants";
import type { CriterionKey, NormalizedRepo, PublicScoreResult } from "./types";

const submissionBodySchema = z.object({
  repoUrl: z.string().min(1).max(512)
});

const criterionSchema = z.object({
  key: z.enum(["technical", "ux", "impact", "idea"]),
  label: z.string().min(1),
  score: z.number().int().min(0).max(10),
  reason: z.string().min(1).max(280),
  evidencePaths: z.array(z.string().min(1).max(300)).max(24)
});

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
  total: z.number().int().min(0).max(40),
  nukoScore: z.number().int().min(80).max(100).nullable().default(null)
});

export const codexOutputSchema = {
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
        { type: "string", pattern: "^[0-9a-f]{40}$" },
        { type: "null" }
      ]
    },
    criteria: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "score", "reason", "evidencePaths"],
        properties: {
          key: { type: "string", enum: ["technical", "ux", "impact", "idea"] },
          label: { type: "string" },
          score: { type: "integer", minimum: 0, maximum: 10 },
          reason: { type: "string" },
          evidencePaths: {
            type: "array",
            maxItems: 24,
            items: { type: "string" }
          }
        }
      }
    },
    total: { type: "integer", minimum: 0, maximum: 40 }
  }
} as const;

export function parseSubmissionBody(input: string): { repoUrl: string } {
  if (new TextEncoder().encode(input).length > API_BODY_LIMIT_BYTES) {
    throw new Error("Request body too large");
  }
  const parsed = JSON.parse(input);
  return submissionBodySchema.parse(parsed);
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

export function repoBucket(normalizedRepo: string): number {
  let hash = 2166136261;
  for (const char of normalizedRepo) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % SCORER_BUCKET_COUNT;
}

export function hashIp(ip: string): string {
  let hash = 0;
  for (const char of ip) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function validatePublicScoreResult(input: unknown, allowedEvidencePaths?: ReadonlySet<string>): PublicScoreResult {
  const parsed = publicScoreResultSchema.parse(input);
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
  return parsed;
}

export function scoreAnchorsText(): string {
  return SCORE_ANCHORS;
}

export function criteriaLabels(): Record<CriterionKey, string> {
  return Object.fromEntries(CRITERIA.map((item) => [item.key, item.label])) as Record<CriterionKey, string>;
}
