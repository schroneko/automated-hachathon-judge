import {
  DEFAULT_JUDGE_STATE_ROWS_WRITTEN_DAILY_LIMIT,
  DEFAULT_JUDGE_STATE_ROWS_WRITTEN_DAILY_WARNING
} from "../shared/constants";
import type { AppStateSnapshot, StateWriteBudget, StateWriteBudgetStatus } from "../shared/types";
import { planStatePersistence, type StatePersistencePlan } from "./state-persistence";

export interface StateWriteBudgetConfig {
  warningRows: number;
  hardLimitRows: number;
}

export type StateWriteBudgetDecision =
  | {
      kind: "noop";
      status: StateWriteBudgetStatus;
    }
  | {
      kind: "persist";
      plan: StatePersistencePlan;
      status: StateWriteBudgetStatus;
      logWarning: boolean;
      logHardLimit: boolean;
    }
  | {
      kind: "exceeded";
      markerPlan?: StatePersistencePlan;
      status: StateWriteBudgetStatus;
      logWarning: boolean;
      logHardLimit: boolean;
    };

export function resolveStateWriteBudgetConfig(env: Env): StateWriteBudgetConfig {
  const hardLimitRows = positiveSafeInteger(
    env.JUDGE_STATE_ROWS_WRITTEN_DAILY_LIMIT,
    DEFAULT_JUDGE_STATE_ROWS_WRITTEN_DAILY_LIMIT
  );
  const configuredWarningRows = positiveSafeInteger(
    env.JUDGE_STATE_ROWS_WRITTEN_DAILY_WARNING,
    DEFAULT_JUDGE_STATE_ROWS_WRITTEN_DAILY_WARNING
  );
  return {
    warningRows: Math.min(configuredWarningRows, hardLimitRows),
    hardLimitRows
  };
}

export function getStateWriteBudgetStatus(
  snapshot: AppStateSnapshot,
  nowIso: string,
  config: StateWriteBudgetConfig
): StateWriteBudgetStatus {
  return toStatus(currentBudget(snapshot.writeBudget, nowIso, config), config);
}

export function prepareStateWriteBudget(
  before: AppStateSnapshot,
  after: AppStateSnapshot,
  nowIso: string,
  config: StateWriteBudgetConfig
): StateWriteBudgetDecision {
  const domainPlan = planStatePersistence(before, after);
  if (countStatePersistenceRows(domainPlan) === 0) {
    return {
      kind: "noop",
      status: getStateWriteBudgetStatus(before, nowIso, config)
    };
  }

  const budget = currentBudget(before.writeBudget, nowIso, config);
  if (budget.exhausted || budget.rowsWritten >= config.hardLimitRows) {
    return {
      kind: "exceeded",
      status: toStatus({ ...budget, exhausted: true }, config),
      logWarning: false,
      logHardLimit: false
    };
  }

  const plannedRows = Object.keys(domainPlan.jobsToPut).length + domainPlan.jobIdsToDelete.length + 1;
  if (budget.rowsWritten + plannedRows > config.hardLimitRows) {
    const markerSnapshot = structuredClone(before);
    const markerRowsWritten = budget.rowsWritten + 1;
    const logWarning = !budget.warningEmitted && markerRowsWritten >= config.warningRows;
    markerSnapshot.writeBudget = {
      ...budget,
      rowsWritten: markerRowsWritten,
      warningEmitted: budget.warningEmitted || logWarning,
      exhausted: true,
      exhaustedAt: canonicalIso(nowIso)
    };
    const markerPlan = planStatePersistence(before, markerSnapshot);
    return {
      kind: "exceeded",
      markerPlan,
      status: toStatus(markerSnapshot.writeBudget, config),
      logWarning,
      logHardLimit: true
    };
  }

  const rowsWritten = budget.rowsWritten + plannedRows;
  const logWarning = !budget.warningEmitted && rowsWritten >= config.warningRows;
  const exhausted = rowsWritten >= config.hardLimitRows;
  after.writeBudget = {
    ...budget,
    rowsWritten,
    warningEmitted: budget.warningEmitted || logWarning,
    exhausted,
    exhaustedAt: exhausted ? canonicalIso(nowIso) : null
  };
  const plan = planStatePersistence(before, after);
  return {
    kind: "persist",
    plan,
    status: toStatus(after.writeBudget, config),
    logWarning,
    logHardLimit: exhausted
  };
}

export function countStatePersistenceRows(plan: StatePersistencePlan): number {
  return Object.keys(plan.jobsToPut).length + plan.jobIdsToDelete.length + (plan.meta ? 1 : 0);
}

function currentBudget(
  stored: StateWriteBudget | undefined,
  nowIso: string,
  config: StateWriteBudgetConfig
): StateWriteBudget {
  const utcDate = canonicalIso(nowIso).slice(0, 10);
  if (!stored || validUtcDate(stored.utcDate) && stored.utcDate < utcDate) {
    return {
      utcDate,
      rowsWritten: 0,
      warningEmitted: false,
      exhausted: false,
      exhaustedAt: null
    };
  }
  if (!validUtcDate(stored.utcDate)) {
    return {
      utcDate,
      rowsWritten: config.hardLimitRows,
      warningEmitted: true,
      exhausted: true,
      exhaustedAt: canonicalIso(nowIso)
    };
  }
  const rowsWritten = Number.isSafeInteger(stored.rowsWritten) && stored.rowsWritten >= 0
    ? Math.min(stored.rowsWritten, config.hardLimitRows)
    : config.hardLimitRows;
  const exhausted = stored.exhausted || rowsWritten >= config.hardLimitRows;
  return {
    utcDate: stored.utcDate,
    rowsWritten,
    warningEmitted: stored.warningEmitted === true,
    exhausted,
    exhaustedAt: exhausted ? stored.exhaustedAt ?? canonicalIso(nowIso) : null
  };
}

function toStatus(budget: StateWriteBudget, config: StateWriteBudgetConfig): StateWriteBudgetStatus {
  return {
    ...budget,
    warningRows: config.warningRows,
    hardLimitRows: config.hardLimitRows,
    remainingRows: budget.exhausted ? 0 : Math.max(0, config.hardLimitRows - budget.rowsWritten)
  };
}

function positiveSafeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function canonicalIso(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function validUtcDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = new Date(`${value}T00:00:00.000Z`).getTime();
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
