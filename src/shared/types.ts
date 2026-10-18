export type CriterionKey = "technical" | "ux" | "impact" | "idea";
export type SubmissionStatus = "queued" | "processing" | "completed" | "failed";
export type SubmissionMode = "production" | "validation";
export type BatchStatus = "queued" | "freezing" | "scoring" | "completed" | "failed";
export interface FreezeQueueMessage {
  type: "freeze_batch";
  eventId: string;
  batchId: string;
  dispatch: number;
}
export type ExplanationStatus = "pending" | "processing" | "completed" | "failed";
export interface ExplanationQueueMessage {
  type: "explain_submission";
  eventId: string;
  submissionId: string;
  attempt: number;
  dispatch: number;
}
export interface RecoveryQueueMessage {
  type: "resume_submission";
  eventId: string;
  submissionId: string;
  mode: SubmissionMode;
  attempt: number;
  dispatch: 1;
  callbackToken: string;
}
export type JudgeQueueMessage = ScoringQueueMessage | FreezeQueueMessage | ExplanationQueueMessage | RecoveryQueueMessage;
export interface PublicBatchRecord {
  id: string;
  eventId: string;
  mode: SubmissionMode;
  effort: "low" | "medium" | "high";
  status: BatchStatus;
  createdAt: string;
  startedAt: string | null;
  frozenAt: string | null;
  completedAt: string | null;
  failureMessage: string | null;
  counts: Record<SubmissionStatus | "total", number>;
  frozenCount: number;
  scoredCount?: number;
  freezeRequestedAt?: string | null;
  freezeDispatches?: number;
  maxFreezeDispatches?: number;
}
export interface ScoringQueueMessage {
  eventId: string;
  submissionId: string;
  mode: SubmissionMode;
  attempt: number;
  dispatch: number;
}
export type RepoAssessmentKind = "scored" | "empty_repository" | "missing_or_private" | "no_default_branch" | "retryable_failure" | "unjudgeable";

export interface NormalizedRepo {
  owner: string;
  repo: string;
  normalized: string;
  canonicalUrl: string;
}

export interface ScoreItem {
  key: CriterionKey;
  label: string;
  score: number;
  reason: string;
  evidencePaths: string[];
}

export interface ScoreUsage {
  fullSource?: true | undefined;
  sourceFiles?: number | undefined;
  sourceBytes?: number | undefined;
  sourceHash?: string | undefined;
  model: string;
  explanationModel?: string;
  effort: "low" | "medium" | "high";
  decisionsModel: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  decisionsScores: Record<string, number>;
  requestIds: string[];
  referenceVersion?: string;
  rubricVersion?: string | undefined;
}

export interface PublicScoreResult {
  eligibility?: "eligible" | "no_implementation" | undefined;
  reviewRequired?: boolean;
  summary: string;
  publicReason: string;
  repoAssessment: RepoAssessmentKind;
  pinnedSha: string | null;
  criteria: ScoreItem[];
  total: number;
  attackScore: number | null;
  attackProbability?: number | undefined;
  usage?: ScoreUsage | undefined;
}

export interface RepoResolution {
  assessment: Exclude<RepoAssessmentKind, "retryable_failure">;
  pinnedSha: string | null;
  defaultBranch: string | null;
  summary: string;
}

export interface PublicSubmissionRecord {
  recoveryDispatches?: number;
  recoveryRequestedAt?: string | null;
  demoUrl?: string | null;
  explanationStatus?: ExplanationStatus;
  explanationDispatches?: number;
  scoredAt?: string | null;
  batchId?: string;
  submittedAt?: string;
  pinnedSha?: string | null;
  frozenAt?: string | null;
  id: string;
  eventId: string;
  repoUrl: string;
  repo: NormalizedRepo;
  teamName: string;
  mode: SubmissionMode;
  effort: "low" | "medium" | "high";
  status: SubmissionStatus;
  attempts: number;
  dispatches: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failureMessage: string | null;
  result: PublicScoreResult | null;
}

export interface SubmissionRecord extends PublicSubmissionRecord {
  callbackToken: string | null;
  outcomeJson: string | null;
}

export interface LeaseJob {
  frozenResolution?: RepoResolution;
  submissionId: string;
  repoUrl: string;
  repo: NormalizedRepo;
  teamName: string;
  mode: SubmissionMode;
  effort: "low" | "medium" | "high";
  startedAt: string;
  callbackToken: string;
  pinnedSha: string | null;
  defaultBranch: string | null;
  summary: string;
}

export interface FinalizePayload {
  submissionId: string;
  callbackToken: string;
  outcome:
    | { kind: "completed"; result: PublicScoreResult }
    | { kind: "retryable_failure"; message: string }
    | { kind: "failed"; message: string };
}

export interface RankingEntry {
  demoUrl?: string | null;
  submissionId: string;
  repo: string;
  repoUrl: string;
  teamName: string;
  mode: SubmissionMode;
  pinnedSha: string | null;
  total: number;
  criteria: ScoreItem[];
  completedAt: string | null;
  summary: string;
  attackScore: number | null;
  rank: number;
  finalist: boolean;
  tiedAtCutoff: boolean;
}

export interface RepoEvidenceFile {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
}

export interface RepoEvidenceSnapshot {
  fullSource?: true;
  repo: NormalizedRepo;
  pinnedSha: string | null;
  defaultBranch: string | null;
  summary: string;
  assessment: Exclude<RepoAssessmentKind, "retryable_failure" | "unjudgeable">;
  files: RepoEvidenceFile[];
}

export interface FullSourceMetadata {
  fullSource: true;
  sourceFiles: number;
  sourceBytes: number;
  sourceHash: string;
}

export interface BudgetReservationInput {
  kind: "decisions" | "responses";
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  reservedUsd: number;
}

export interface BudgetUsage {
  kind: "decisions" | "responses";
  model: string;
  reservationId?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  costUsd: number;
  requestId?: string | null;
}

export type ApiReservation = BudgetReservationInput;
export type ApiUsage = BudgetUsage;
