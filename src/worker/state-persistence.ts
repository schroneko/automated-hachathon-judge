import type { AppStateSnapshot, SubmissionRecord } from "../shared/types";

export type StateMeta = Omit<AppStateSnapshot, "jobs">;

export interface StatePersistencePlan {
  meta: StateMeta | undefined;
  jobsToPut: Record<string, SubmissionRecord>;
  jobIdsToDelete: string[];
}

export function planStatePersistence(
  before: AppStateSnapshot,
  after: AppStateSnapshot
): StatePersistencePlan {
  const beforeMeta = withoutJobs(before);
  const afterMeta = withoutJobs(after);
  const jobsToPut: Record<string, SubmissionRecord> = {};
  const deletedIds = new Set<string>();

  for (const [id, job] of Object.entries(after.jobs)) {
    if (!(id in before.jobs) || !jsonEquivalent(before.jobs[id], job)) {
      jobsToPut[id] = job;
    }
  }

  for (const id of Object.keys(before.jobs)) {
    if (!(id in after.jobs)) {
      deletedIds.add(id);
    }
  }

  return {
    meta: jsonEquivalent(beforeMeta, afterMeta) ? undefined : afterMeta,
    jobsToPut,
    jobIdsToDelete: Array.from(deletedIds)
  };
}

export function pruneExpiredCooldowns(snapshot: AppStateSnapshot, nowIso: string): void {
  const now = new Date(nowIso).getTime();
  for (const [ipHash, cooldownUntilIso] of Object.entries(snapshot.ipCooldowns)) {
    const cooldownUntil = new Date(cooldownUntilIso).getTime();
    if (!Number.isFinite(cooldownUntil) || cooldownUntil <= now) {
      delete snapshot.ipCooldowns[ipHash];
    }
  }
}

export async function applyStatePersistence(
  storage: DurableObjectStorage,
  plan: StatePersistencePlan
): Promise<void> {
  if (!plan.meta && Object.keys(plan.jobsToPut).length === 0 && plan.jobIdsToDelete.length === 0) {
    return;
  }

  await storage.transaction(async (transaction) => {
    for (const [id, job] of Object.entries(plan.jobsToPut)) {
      await transaction.put(`job:${id}`, job);
    }
    if (plan.meta) {
      await transaction.put("meta", plan.meta);
    }
    for (const id of plan.jobIdsToDelete) {
      await transaction.delete(`job:${id}`);
    }
  });
}

export function jsonEquivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => jsonEquivalent(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key, index) => key === rightKeys[index] && jsonEquivalent(leftRecord[key], rightRecord[key])
  );
}

function withoutJobs(snapshot: AppStateSnapshot): StateMeta {
  const { jobs: _jobs, ...meta } = snapshot;
  return meta;
}
