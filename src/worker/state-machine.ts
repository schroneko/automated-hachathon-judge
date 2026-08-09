import { DEFAULT_MAX_ACCEPTED_SUBMISSIONS, IP_SUBMISSION_COOLDOWN_MS, MAX_RECENT_SUBMISSIONS, MAX_RECOVERED_JOBS_PER_REQUEST, SCORER_BUCKET_COUNT } from "../shared/constants";
import type {
  AppStateSnapshot,
  FinalizePayload,
  FinalizeResult,
  LeaseJob,
  RankingEntry,
  SubmissionListItem,
  SubmissionRecord,
  PublicSubmissionRecord,
  SubmitJobInput,
  SubmitJobResult
} from "../shared/types";
import { normalizeGitHubRepoUrl, repoBucket } from "../shared/validation";
import { buildZeroScoreResult } from "../shared/scoring";

export function createInitialSnapshot(): AppStateSnapshot {
  return {
    acceptedSubmissions: 0,
    jobs: {},
    recentIds: [],
    repoInflight: {},
    repoLatestCompleted: {},
    ipCooldowns: {},
    bucketQueues: Object.fromEntries(
      Array.from({ length: SCORER_BUCKET_COUNT }, (_, bucket) => [String(bucket), [] as string[]])
    ),
    bucketActive: Object.fromEntries(
      Array.from({ length: SCORER_BUCKET_COUNT }, (_, bucket) => [String(bucket), false])
    ),
    runnerLastSeenAt: null
  };
}

export function submitJob(state: AppStateSnapshot, input: SubmitJobInput): SubmitJobResult {
  const submissionLimit = validSubmissionLimit(input.maxAcceptedSubmissions);
  if (state.acceptedSubmissions >= submissionLimit) {
    return {
      ok: false,
      code: "submission_limit",
      message: "このイベントの投稿上限に達しました。"
    };
  }

  const repo = normalizeGitHubRepoUrl(input.repoUrl);
  const cooldownUntilIso = state.ipCooldowns[input.ipHash];
  if (cooldownUntilIso) {
    const remaining = new Date(cooldownUntilIso).getTime() - new Date(input.nowIso).getTime();
    if (remaining > 0) {
      return {
        ok: false,
        code: "cooldown",
        message: "投稿間隔が短すぎます。少し待ってから再送してください。",
        retryAfterMs: remaining
      };
    }
  }
  if (state.repoInflight[repo.normalized]) {
    return {
      ok: false,
      code: "duplicate_inflight",
      message: "このリポジトリはジャッジ中です。完了まで待ってください。"
    };
  }

  const id = crypto.randomUUID();
  const bucket = repoBucket(repo.normalized);
  const record: SubmissionRecord = {
    id,
    repoUrl: repo.canonicalUrl,
    repo,
    bucket,
    status: "queued",
    callbackToken: crypto.randomUUID(),
    resolution: input.resolution,
    attempts: 0,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    startedAt: null,
    completedAt: null,
    ipHash: input.ipHash,
    failureMessage: null,
    result: null
  };

  state.jobs[id] = record;
  state.acceptedSubmissions += 1;
  state.recentIds.unshift(id);
  state.recentIds = state.recentIds.slice(0, MAX_RECENT_SUBMISSIONS);
  state.ipCooldowns[input.ipHash] = new Date(
    new Date(input.nowIso).getTime() + IP_SUBMISSION_COOLDOWN_MS
  ).toISOString();

  if (input.resolution.assessment === "unjudgeable") {
    record.status = "failed";
    record.completedAt = input.nowIso;
    record.failureMessage = "ジャッジ処理に失敗しました。";
    return { ok: true, submission: toPublicSubmission(record) };
  }

  if (input.resolution.assessment !== "scored") {
    record.status = "completed";
    record.completedAt = input.nowIso;
    record.result = buildZeroScoreResult({
      summary: input.resolution.summary,
      publicReason: zeroReason(input.resolution.assessment),
      repoAssessment: input.resolution.assessment,
      pinnedSha: input.resolution.pinnedSha
    });
    state.repoLatestCompleted[repo.normalized] = id;
    return { ok: true, submission: toPublicSubmission(record) };
  }

  state.repoInflight[repo.normalized] = id;
  bucketQueue(state, bucket).push(id);

  return {
    ok: true,
    submission: toPublicSubmission(record)
  };
}

export function claimJob(
  state: AppStateSnapshot,
  callbackBaseUrl: string,
  nowIso: string
): LeaseJob | undefined {
  for (let bucket = 0; bucket < SCORER_BUCKET_COUNT; bucket += 1) {
    const job = leaseNextJob(state, bucket, callbackBaseUrl, nowIso);
    if (job) {
      return job;
    }
  }
  return undefined;
}

export function recoverProcessingJobs(state: AppStateSnapshot, nowIso: string): number {
  let recovered = 0;
  for (const job of Object.values(state.jobs)) {
    if (job.status !== "processing") {
      continue;
    }
    job.status = "queued";
    job.updatedAt = nowIso;
    const queue = bucketQueue(state, job.bucket);
    if (!queue.includes(job.id)) {
      queue.unshift(job.id);
    }
    recovered += 1;
    if (recovered >= MAX_RECOVERED_JOBS_PER_REQUEST) {
      break;
    }
  }
  return recovered;
}

export function finalizeJob(state: AppStateSnapshot, payload: FinalizePayload): FinalizeResult {
  const job = state.jobs[payload.submissionId];
  if (!job) {
    return { ok: false, message: "Submission not found" };
  }
  if (job.callbackToken !== payload.callbackToken) {
    return { ok: false, message: "Invalid callback token" };
  }
  if (job.status !== "processing") {
    return { ok: false, message: "Submission is not processing" };
  }

  job.updatedAt = payload.nowIso;

  if (payload.outcome.kind === "retryable_failure" || payload.outcome.kind === "failed") {
    job.status = "failed";
    job.completedAt = payload.nowIso;
    job.failureMessage = "ジャッジ処理に失敗しました。";
    delete state.repoInflight[job.repo.normalized];
    return { ok: true, submission: job };
  }

  job.status = "completed";
  job.completedAt = payload.nowIso;
  job.failureMessage = null;
  job.result = payload.outcome.result;
  delete state.repoInflight[job.repo.normalized];
  state.repoLatestCompleted[job.repo.normalized] = job.id;
  return { ok: true, submission: job };
}

export function getSubmission(state: AppStateSnapshot, id: string): SubmissionRecord | null {
  return state.jobs[id] ?? null;
}

export function toPublicSubmission(job: SubmissionRecord): PublicSubmissionRecord {
  const { callbackToken: _callbackToken, ipHash: _ipHash, ...publicRecord } = job;
  return publicRecord;
}

export function getRecentSubmissions(state: AppStateSnapshot): SubmissionListItem[] {
  return state.recentIds
    .map((id) => state.jobs[id])
    .filter((item): item is SubmissionRecord => Boolean(item))
    .map((job) => ({
      id: job.id,
      repo: job.repo.normalized,
      repoUrl: job.repoUrl,
      status: job.status,
      total: job.result?.total ?? null,
      summary: job.result?.summary ?? job.failureMessage,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      pinnedSha: job.result?.pinnedSha ?? null
    }));
}

export function getRanking(state: AppStateSnapshot, unrankedOwners: readonly string[] = []): RankingEntry[] {
  return Object.values(state.repoLatestCompleted)
    .map((id) => state.jobs[id])
    .filter((job): job is SubmissionRecord => Boolean(job?.result))
    .sort((left, right) => {
      const leftRanked = isRankingEligible(left.repo.normalized, unrankedOwners);
      const rightRanked = isRankingEligible(right.repo.normalized, unrankedOwners);
      if (leftRanked !== rightRanked) {
        return leftRanked ? -1 : 1;
      }
      const byTotal = (right.result?.total ?? 0) - (left.result?.total ?? 0);
      if (byTotal !== 0) {
        return byTotal;
      }
      return left.repo.normalized.localeCompare(right.repo.normalized);
    })
    .map((job) => ({
      submissionId: job.id,
      repo: job.repo.normalized,
      repoUrl: job.repoUrl,
      pinnedSha: job.result?.pinnedSha ?? null,
      total: job.result?.total ?? 0,
      criteria: job.result?.criteria ?? [],
      completedAt: job.completedAt,
      summary: job.result?.summary ?? "",
      nukoScore: job.result?.nukoScore ?? null,
      ranked: isRankingEligible(job.repo.normalized, unrankedOwners)
    }));
}

export function isRankingEligible(normalizedRepo: string, unrankedOwners: readonly string[] = []): boolean {
  const owner = normalizedRepo.split("/", 1)[0]?.toLowerCase() ?? "";
  return !unrankedOwners.some((candidate) => candidate.toLowerCase() === owner);
}

function leaseNextJob(
  state: AppStateSnapshot,
  bucket: number,
  callbackBaseUrl: string,
  nowIso: string
): LeaseJob | undefined {
  const queue = bucketQueue(state, bucket);
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) {
      continue;
    }
    const job = state.jobs[id];
    if (!job || job.status !== "queued") {
      continue;
    }
    job.status = "processing";
    job.attempts += 1;
    job.startedAt = job.startedAt ?? nowIso;
    job.updatedAt = nowIso;
    return {
      submissionId: job.id,
      repoUrl: job.repoUrl,
      repo: job.repo,
      bucket,
      callbackToken: job.callbackToken,
      callbackUrl: `${callbackBaseUrl.replace(/\/+$/, "")}/internal/scoring-callback`,
      attempt: job.attempts,
      pinnedSha: job.resolution.pinnedSha,
      defaultBranch: job.resolution.defaultBranch,
      summary: job.resolution.summary
    };
  }
  return undefined;
}

function zeroReason(assessment: "empty_repository" | "missing_or_private" | "no_default_branch"): string {
  if (assessment === "empty_repository") return "空のリポジトリのため評価材料がありません。";
  if (assessment === "missing_or_private") return "公開リポジトリが見つからないか、非公開のため評価できません。";
  return "デフォルトブランチを解決できず評価材料を固定できませんでした。";
}

function bucketQueue(state: AppStateSnapshot, bucket: number): string[] {
  const key = String(bucket);
  const existing = state.bucketQueues[key];
  if (existing) {
    return existing;
  }
  state.bucketQueues[key] = [];
  return state.bucketQueues[key];
}

function validSubmissionLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && value && value > 0
    ? value
    : DEFAULT_MAX_ACCEPTED_SUBMISSIONS;
}
