import { CRITERIA } from "./constants";
import { criteriaLabels } from "./validation";
import type { PublicScoreResult, RepoAssessmentKind } from "./types";

export function buildZeroScoreResult(input: {
  summary: string;
  publicReason: string;
  repoAssessment: Extract<RepoAssessmentKind, "empty_repository" | "missing_or_private" | "no_default_branch" | "unjudgeable">;
  pinnedSha: string | null;
}): PublicScoreResult {
  const labels = criteriaLabels();
  return {
    summary: input.summary,
    publicReason: input.publicReason,
    repoAssessment: input.repoAssessment,
    pinnedSha: input.pinnedSha,
    criteria: CRITERIA.map((criterion) => ({
      key: criterion.key,
      label: labels[criterion.key],
      score: 0,
      reason: input.publicReason,
      evidencePaths: []
    })),
    total: 0,
    nukoScore: null
  };
}
