import { z } from "zod";
import { API_BODY_LIMIT_BYTES, CALLBACK_BODY_LIMIT_BYTES, CRITERIA, MAX_EVIDENCE_FILES, MAX_EVIDENCE_FILE_BYTES, MAX_EVIDENCE_TOTAL_BYTES, MAX_SNAPSHOT_SERIALIZED_BYTES } from "./constants";
import { visibleAttackScore } from "./attack-score";
import { MAX_CRITERION_SCORE, MAX_TOTAL_SCORE, SCORE_LEVELS, rubricText } from "./rubric";
import { CONDITION_PROBABILITY_THRESHOLD, deriveConditionScores } from "./decision-conditions";
import type { CriterionKey, FinalizePayload, FullSourceMetadata, NormalizedRepo, PublicScoreResult, RepoEvidenceSnapshot, SubmissionMode } from "./types";

const submissionBodySchema = z.object({
  repoUrl: z.string().min(1).max(512),
  teamName: z.string().trim().max(100).optional(),
  mode: z.enum(["production", "validation"])
}).strict();

const usageSchema = z.object({
  fullSource: z.literal(true).optional(),
  sourceFiles: z.number().int().min(0).max(MAX_EVIDENCE_FILES).optional(),
  sourceBytes: z.number().int().min(0).max(MAX_EVIDENCE_TOTAL_BYTES).optional(),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high"]),
  decisionsModel: z.string().min(1),
  explanationModel: z.string().min(1).optional(),
  referenceVersion: z.string().min(1).max(100).optional(),
  rubricVersion: z.string().min(1).max(100).optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative(),
  decisionsScores: z.record(z.string(), z.number().finite().min(0).max(MAX_CRITERION_SCORE)),
  decisionsConditions: z.record(z.string(), z.boolean()).optional(),
  decisionsConditionProbabilities: z.record(z.string(), z.number().finite().min(0).max(1)).optional(),
  conditionThreshold: z.literal(CONDITION_PROBABILITY_THRESHOLD).optional(),
  requestIds: z.array(z.string().min(1)).max(2)
}).strict().refine((value) => {
  const values = [value.fullSource, value.sourceFiles, value.sourceBytes, value.sourceHash];
  return values.every((item) => item === undefined) || values.every((item) => item !== undefined);
}, "Full-source metadata must be a complete group");

const criterionSchema = z.object({
  key: z.enum(["technical", "ux", "impact", "idea"]),
  label: z.string().min(1),
  score: z.union(SCORE_LEVELS.map((score) => z.literal(score))),
  reason: z.string().min(1).max(280),
  evidencePaths: z.array(z.string().min(1).max(1024)).max(24)
}).strict();

export const publicScoreResultSchema = z.object({
  eligibility: z.enum(["eligible", "no_implementation"]).optional(),
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
  reviewRequired: z.boolean().optional(),
  usage: usageSchema.optional()
}).strict();

export const explanationModelResultSchema = publicScoreResultSchema.omit({
  eligibility: true,
  attackScore: true,
  attackProbability: true,
  usage: true
}).extend({ reviewRequired: z.boolean() }).strict();

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

export const explanationOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "publicReason", "repoAssessment", "pinnedSha", "criteria", "total", "reviewRequired"],
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
    total: { type: "integer" },
    reviewRequired: { type: "boolean" }
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
  if (parsed.usage?.rubricVersion === "2026-10-18-v4" || parsed.usage?.decisionsConditions !== undefined
    || parsed.usage?.decisionsConditionProbabilities !== undefined || parsed.usage?.conditionThreshold !== undefined) {
    if (!parsed.usage?.decisionsConditions || !parsed.usage.decisionsConditionProbabilities
      || parsed.usage.conditionThreshold !== CONDITION_PROBABILITY_THRESHOLD) throw new Error("Condition-based judging requires complete Decisions condition evidence");
    const derived = deriveConditionScores(parsed.usage.decisionsConditions);
    const probabilities = parsed.usage.decisionsConditionProbabilities;
    if (Object.keys(probabilities).sort().join(",") !== Object.keys(parsed.usage.decisionsConditions).sort().join(",")
      || Object.entries(parsed.usage.decisionsConditions).some(([name, met]) => met !== (probabilities[name]! >= CONDITION_PROBABILITY_THRESHOLD))) {
      throw new Error("Decisions conditions do not match recorded probabilities and threshold");
    }
    if (parsed.criteria.some((criterion) => derived.scores[criterion.key] !== criterion.score
      || parsed.usage!.decisionsScores[criterion.key] !== criterion.score)) throw new Error("Scores do not match Decisions conditions");
    if (derived.reviewRequired && parsed.reviewRequired !== true) throw new Error("Inconsistent Decisions conditions require review");
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
  const { usage, reviewRequired, ...fields } = parsed;
  const result = { ...fields, ...(reviewRequired === undefined ? {} : { reviewRequired }) };
  if (!usage) return result;
  const { referenceVersion, explanationModel, ...audit } = usage;
  return { ...result, usage: {
    ...audit,
    ...(referenceVersion === undefined ? {} : { referenceVersion }),
    ...(explanationModel === undefined ? {} : { explanationModel })
  } };
}

export function scoreAnchorsText(): string {
  return rubricText();
}

export function criteriaLabels(): Record<CriterionKey, string> {
  return Object.fromEntries(CRITERIA.map((item) => [item.key, item.label])) as Record<CriterionKey, string>;
}

export async function prepareFullSourceSnapshot(snapshot: RepoEvidenceSnapshot): Promise<{ serialized: string; metadata: FullSourceMetadata }> {
  if (!snapshot || !snapshot.repo || !Array.isArray(snapshot.files) || typeof snapshot.summary !== "string") {
    throw new Error("Invalid repository snapshot");
  }
  const { owner, repo, normalized, canonicalUrl } = snapshot.repo;
  if (typeof owner !== "string" || typeof repo !== "string" || !/^[A-Za-z0-9_.-]+$/.test(owner)
    || !/^[A-Za-z0-9_.-]+$/.test(repo) || [owner, repo].some((part) => part === "." || part === "..")
    || normalized !== `${owner.toLowerCase()}/${repo.toLowerCase()}` || canonicalUrl !== `https://github.com/${owner}/${repo}`) {
    throw new Error("Invalid canonical repository identity");
  }
  if (snapshot.assessment === "scored") {
    if (snapshot.fullSource !== true) throw new Error("Scored snapshot requires fullSource true; partial snapshots cannot be reused");
    if (snapshot.files.length === 0) throw new Error("Scored snapshot requires at least one source file");
    if (typeof snapshot.pinnedSha !== "string" || !/^[0-9a-f]{40}$/.test(snapshot.pinnedSha)
      || typeof snapshot.defaultBranch !== "string" || !snapshot.defaultBranch.trim()) {
      throw new Error("Scored snapshot requires a valid pinned SHA and branch");
    }
  } else if (!["empty_repository", "missing_or_private", "no_default_branch"].includes(snapshot.assessment) || snapshot.files.length !== 0) {
    throw new Error("Non-scored snapshot must contain no files");
  }
  if (snapshot.pinnedSha !== null && (typeof snapshot.pinnedSha !== "string" || !/^[0-9a-f]{40}$/.test(snapshot.pinnedSha))) {
    throw new Error("Invalid snapshot pinned SHA");
  }
  if (snapshot.defaultBranch !== null && (typeof snapshot.defaultBranch !== "string" || !snapshot.defaultBranch.trim())) {
    throw new Error("Invalid snapshot default branch");
  }
  if (snapshot.fullSource !== undefined && snapshot.fullSource !== true) throw new Error("Invalid fullSource marker");
  if (snapshot.files.length > MAX_EVIDENCE_FILES) throw new Error("Snapshot file count limit exceeded");
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  let sourceBytes = 0;
  const files = snapshot.files.map((file) => {
    if (!file || typeof file.path !== "string" || !file.path || encoder.encode(file.path).length > 1024
      || file.path.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
      || /[\\:\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(file.path) || seen.has(file.path)) {
      throw new Error("Invalid, unsafe, or duplicate snapshot file path");
    }
    seen.add(file.path);
    if (typeof file.content !== "string" || file.truncated !== false || file.content.includes("\0")) {
      throw new Error("Snapshot requires full UTF-8 content without truncated files");
    }
    const bytes = encoder.encode(file.content);
    if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== file.content) throw new Error("Invalid snapshot UTF-8 content");
    if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(encoder.encode(file.path)) !== file.path) throw new Error("Invalid snapshot UTF-8 path");
    if (!Number.isSafeInteger(file.size) || file.size !== bytes.length || file.size > MAX_EVIDENCE_FILE_BYTES) {
      throw new Error("Snapshot file byte limit exceeded or size mismatch");
    }
    sourceBytes += bytes.length;
    if (sourceBytes > MAX_EVIDENCE_TOTAL_BYTES) throw new Error("Snapshot total byte limit exceeded");
    return { path: file.path, size: bytes.length, content: file.content, truncated: false };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const serialized = JSON.stringify({
    repo: { owner, repo, normalized, canonicalUrl },
    assessment: snapshot.assessment,
    pinnedSha: snapshot.pinnedSha,
    defaultBranch: snapshot.defaultBranch,
    summary: snapshot.summary,
    files,
    fullSource: true
  });
  const bytes = encoder.encode(serialized);
  if (bytes.length > MAX_SNAPSHOT_SERIALIZED_BYTES) throw new Error("Snapshot serialized byte limit exceeded");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sourceHash = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { serialized, metadata: { fullSource: true, sourceFiles: files.length, sourceBytes, sourceHash } };
}

export function implementationEligibility(snapshot: RepoEvidenceSnapshot): "eligible" | "no_implementation" {
  return snapshot.files.some((file) => {
    const parts = file.path.toLowerCase().split("/");
    const name = parts.at(-1)!;
    if (!file.content.trim() || parts.some((part) => /^(?:docs?|documentation|readmes?|\.?config|configs|configuration|\.?settings|\.github|\.vscode|\.idea|\.storybook|\.devcontainer)$/.test(part))
      || /^(?:readme|license|licence|changelog|contributing|code_of_conduct|security)(?:[._-]|$)/.test(name)
      || /(?:^|[._-])(?:config|settings)(?:[._-]|$)/.test(name)
      || /^(?:vite|vitest|webpack|rollup|esbuild|babel|eslint|prettier|tailwind|postcss|next|nuxt|svelte|astro|jest|playwright|cypress|tsconfig|jsconfig|setup|conftest)\./.test(name)
      || /^\.(?:babelrc|eslintrc|prettierrc|stylelintrc)(?:\.|$)/.test(name)
      || /^(?:build\.(?:gradle(?:\.kts)?|sbt|zig)|project\.clj|(?:vite|next)-env\.d\.ts)$/.test(name)) return false;
    if (name.endsWith(".ipynb")) {
      try {
        const notebook: unknown = JSON.parse(file.content);
        if (!notebook || typeof notebook !== "object" || !("cells" in notebook) || !Array.isArray(notebook.cells)) return false;
        return notebook.cells.some((cell: unknown) => {
          if (!cell || typeof cell !== "object" || !("cell_type" in cell) || cell.cell_type !== "code" || !("source" in cell)) return false;
          const source = cell.source;
          return typeof source === "string" ? !!source.trim() : Array.isArray(source) && source.every((line) => typeof line === "string") && !!source.join("").trim();
        });
      } catch {
        return false;
      }
    }
    if (/\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|css|s[ac]ss|less|styl|pyw?|pyi|rb|rake|php\d?|phtml|go|rs|java|kt|kts|scala|sc|swift|m|mm|c|h|cc|cpp|cxx|hpp|hxx|cs|fs|fsx|vb|dart|ex|exs|erl|hrl|hs|lhs|ml|mli|clj|cljs|cljc|edn|lisp|lsp|cl|scm|rkt|lua|pl|pm|r|jl|sh|bash|zsh|fish|ps1|psm1|bat|cmd|sql|graphql|gql|sol|move|zig|nim|v|cr|groovy|gvy|gradle|f|f90|f95|for|pas|pp|cob|cbl|asm|s|sv|vhd|vhdl|elm|purs|gleam|re|rei|res|resi|eex|heex|erb|hbs|handlebars|mustache|twig)$/.test(name)) return true;
    if (!name.includes(".")) {
      const lines = file.content.split(/\r?\n/);
      return /^#!\s*\S+/.test(lines[0] ?? "") && lines.slice(1).some((line) => !!line.trim() && !/^\s*#/.test(line));
    }
    return false;
  }) ? "eligible" : "no_implementation";
}
