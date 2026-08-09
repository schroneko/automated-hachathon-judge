export type CriterionKey = "technical" | "ux" | "impact" | "idea";
export type SubmissionStatus = "queued" | "processing" | "completed" | "failed";
export type RepoAssessmentKind =
  | "scored"
  | "empty_repository"
  | "missing_or_private"
  | "no_default_branch"
  | "retryable_failure"
  | "unjudgeable";

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

export interface PublicScoreResult {
  summary: string;
  publicReason: string;
  repoAssessment: RepoAssessmentKind;
  pinnedSha: string | null;
  criteria: ScoreItem[];
  total: number;
  nukoScore: number | null;
}

export interface SubmissionRecord {
  id: string;
  repoUrl: string;
  repo: NormalizedRepo;
  bucket: number;
  status: SubmissionStatus;
  callbackToken: string;
  resolution: RepoResolution;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  ipHash: string;
  failureMessage: string | null;
  result: PublicScoreResult | null;
}

export type PublicSubmissionRecord = Omit<SubmissionRecord, "callbackToken" | "ipHash">;

export interface RepoResolution {
  assessment: Exclude<RepoAssessmentKind, "retryable_failure">;
  pinnedSha: string | null;
  defaultBranch: string | null;
  summary: string;
}

export interface AppStateSnapshot {
  acceptedSubmissions: number;
  jobs: Record<string, SubmissionRecord>;
  recentIds: string[];
  repoInflight: Record<string, string>;
  repoLatestCompleted: Record<string, string>;
  ipCooldowns: Record<string, string>;
  bucketQueues: Record<string, string[]>;
  bucketActive: Record<string, boolean>;
  runnerLastSeenAt: string | null;
}

export interface LeaseJob {
  submissionId: string;
  repoUrl: string;
  repo: NormalizedRepo;
  bucket: number;
  callbackToken: string;
  callbackUrl: string;
  attempt: number;
  pinnedSha: string | null;
  defaultBranch: string | null;
  summary: string;
}

export interface SubmitJobInput {
  repoUrl: string;
  ipHash: string;
  callbackBaseUrl: string;
  nowIso: string;
  maxAcceptedSubmissions?: number;
  resolution: RepoResolution;
}

export interface SubmitJobSuccess {
  ok: true;
  submission: PublicSubmissionRecord;
}

export interface SubmitJobError {
  ok: false;
  code: "cooldown" | "duplicate_inflight" | "invalid_repo" | "submission_limit";
  message: string;
  retryAfterMs?: number;
}

export type SubmitJobResult = SubmitJobSuccess | SubmitJobError;

export interface FinalizePayload {
  submissionId: string;
  callbackToken: string;
  bucket: number;
  callbackBaseUrl: string;
  nowIso: string;
  outcome:
    | {
        kind: "completed";
        result: PublicScoreResult;
      }
    | {
        kind: "retryable_failure";
        message: string;
      }
    | {
        kind: "failed";
        message: string;
      };
}

export interface FinalizeResult {
  ok: boolean;
  submission?: SubmissionRecord;
  nextJob?: LeaseJob;
  message?: string;
}

export interface RankingEntry {
  submissionId: string;
  repo: string;
  repoUrl: string;
  pinnedSha: string | null;
  total: number;
  criteria: ScoreItem[];
  completedAt: string | null;
  summary: string;
  nukoScore: number | null;
  ranked: boolean;
}

export interface SubmissionListItem {
  id: string;
  repo: string;
  repoUrl: string;
  status: SubmissionStatus;
  total: number | null;
  summary: string | null;
  createdAt: string;
  completedAt: string | null;
  pinnedSha: string | null;
}

export interface RepoEvidenceFile {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
}

export interface RepoEvidenceSnapshot {
  repo: NormalizedRepo;
  pinnedSha: string | null;
  defaultBranch: string | null;
  summary: string;
  assessment: Exclude<RepoAssessmentKind, "retryable_failure" | "unjudgeable">;
  files: RepoEvidenceFile[];
}
