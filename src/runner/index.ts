import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FinalizePayload, LeaseJob } from "../shared/types";
import { MAX_RECOVERED_JOBS_PER_REQUEST } from "../shared/constants";
import { scoreSubmission } from "../container/scorer";
import { isPermanentCallbackFailure, requireRunnerBaseUrl, shouldStopRunner } from "./config";

type RunnerOutcome = Omit<FinalizePayload, "callbackBaseUrl" | "nowIso">;

interface PendingResult {
  callbackUrl: string;
  payload: RunnerOutcome;
}

class PermanentCallbackError extends Error {}

const baseUrl = requireRunnerBaseUrl(process.env.RUNNER_BASE_URL);
const callbackUrl = `${baseUrl}/internal/scoring-callback`;
const tokenFile = process.env.RUNNER_TOKEN_FILE ?? join(homedir(), "Library", "Application Support", "Hackathon Judge", "runner-token");
const spoolDir = process.env.RUNNER_SPOOL_DIR ?? join(homedir(), "Library", "Application Support", "Hackathon Judge", "spool");
const concurrency = boundedInteger(process.env.RUNNER_CONCURRENCY, 10, 1, 10);
const pollIntervalMs = boundedInteger(process.env.RUNNER_POLL_INTERVAL_MS, 2000, 500, 30000);
const maxIdleBackoffMs = 30000;
const token = (await readFile(tokenFile, "utf8")).trim();
let shuttingDown = false;
let runnerDisabled = false;
let terminalError: PermanentCallbackError | null = null;

if (!token) {
  throw new Error("Runner token is empty");
}

if (!process.env.GITHUB_TOKEN?.trim()) {
  process.env.GITHUB_TOKEN = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}

process.once("SIGINT", () => {
  shuttingDown = true;
});
process.once("SIGTERM", () => {
  shuttingDown = true;
});

await mkdir(spoolDir, { recursive: true, mode: 0o700 });
await replayPendingResults();
await recoverProcessingJobs();

if (!shuttingDown && !runnerDisabled) {
  const heartbeatTimer = setInterval(() => {
    void sendHeartbeat();
  }, 5000);
  heartbeatTimer.unref();
  await sendHeartbeat();
}

if (!shuttingDown && !runnerDisabled) {
  console.log(`Runner started with ${concurrency} slots`);
  await Promise.all(Array.from({ length: concurrency }, (_, slot) => runSlot(slot + 1)));
}

if (terminalError) {
  throw terminalError;
}

async function runSlot(slot: number): Promise<void> {
  let idleDelayMs = pollIntervalMs;
  while (!shuttingDown && !runnerDisabled) {
    try {
      const job = await claimJob();
      if (!job) {
        if (shuttingDown || runnerDisabled) {
          return;
        }
        await sleep(idleDelayMs);
        idleDelayMs = Math.min(idleDelayMs * 2, maxIdleBackoffMs);
        continue;
      }
      idleDelayMs = pollIntervalMs;
      console.log(`Slot ${slot} claimed ${job.submissionId}`);
      await processJob(job);
      console.log(`Slot ${slot} completed ${job.submissionId}`);
    } catch (error) {
      if (error instanceof PermanentCallbackError) {
        terminalError ??= error;
        runnerDisabled = true;
        return;
      }
      console.error(`Slot ${slot} error`, error);
      await sleep(5000);
    }
  }
}

async function claimJob(): Promise<LeaseJob | null> {
  const response = await fetch(`${baseUrl}/internal/runner/claim`, {
    method: "POST",
    headers: runnerHeaders(),
    signal: AbortSignal.timeout(15000)
  });
  if (response.status === 204) {
    return null;
  }
  if (shouldStopRunner(response)) {
    runnerDisabled = true;
    return null;
  }
  if (!response.ok) {
    throw new Error(`Claim failed with status ${response.status}`);
  }
  const body = (await response.json()) as { job: LeaseJob };
  return body.job;
}

async function processJob(job: LeaseJob): Promise<void> {
  let outcome: FinalizePayload["outcome"];
  try {
    outcome = {
      kind: "completed",
      result: await scoreSubmission(job)
    };
  } catch (error) {
    console.error(`Job ${job.submissionId} failed`, error);
    outcome = {
      kind: "failed",
      message: error instanceof Error ? error.message : "Unexpected failure"
    };
  }

  const pending: PendingResult = {
    callbackUrl,
    payload: {
      submissionId: job.submissionId,
      callbackToken: job.callbackToken,
      bucket: job.bucket,
      outcome
    }
  };
  const path = await persistPendingResult(pending);
  await deliverPendingResult(pending);
  await unlink(path);
}

async function persistPendingResult(pending: PendingResult): Promise<string> {
  const id = pending.payload.submissionId;
  const path = join(spoolDir, `${id}.json`);
  const temporaryPath = join(spoolDir, `${id}.${process.pid}.tmp`);
  await writeFile(temporaryPath, JSON.stringify(pending), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  return path;
}

async function replayPendingResults(): Promise<void> {
  const names = (await readdir(spoolDir)).filter((name) => name.endsWith(".json"));
  for (const name of names) {
    const path = join(spoolDir, name);
    const pending = JSON.parse(await readFile(path, "utf8")) as PendingResult;
    await deliverPendingResult(pending);
    await unlink(path);
  }
}

async function deliverPendingResult(pending: PendingResult): Promise<void> {
  let delayMs = 1000;
  while (!shuttingDown) {
    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: runnerHeaders(),
        body: JSON.stringify(pending.payload),
        signal: AbortSignal.timeout(15000)
      });
      if (response.ok || response.status === 409) {
        return;
      }
      if (isPermanentCallbackFailure(response)) {
        throw new PermanentCallbackError(`Callback failed with status ${response.status}`);
      }
      throw new Error(`Callback failed with status ${response.status}`);
    } catch (error) {
      if (error instanceof PermanentCallbackError) {
        throw error;
      }
      console.error(`Callback pending for ${pending.payload.submissionId}`, error);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 30000);
    }
  }
  throw new Error("Runner stopped before callback completed");
}

async function sendHeartbeat(): Promise<void> {
  if (runnerDisabled) {
    return;
  }
  try {
    const response = await fetch(`${baseUrl}/internal/runner/heartbeat`, {
      method: "POST",
      headers: runnerHeaders(),
      signal: AbortSignal.timeout(10000)
    });
    if (shouldStopRunner(response)) {
      runnerDisabled = true;
      return;
    }
    if (!response.ok) {
      throw new Error(`Heartbeat failed with status ${response.status}`);
    }
  } catch (error) {
    console.error("Heartbeat error", error);
  }
}

async function recoverProcessingJobs(): Promise<void> {
  let recoveredTotal = 0;
  while (!shuttingDown) {
    const response = await fetch(`${baseUrl}/internal/runner/recover`, {
      method: "POST",
      headers: runnerHeaders(),
      signal: AbortSignal.timeout(15000)
    });
    if (shouldStopRunner(response)) {
      runnerDisabled = true;
      return;
    }
    if (!response.ok) {
      throw new Error(`Recovery failed with status ${response.status}`);
    }
    const body = (await response.json()) as { recovered: number };
    recoveredTotal += body.recovered;
    if (body.recovered < MAX_RECOVERED_JOBS_PER_REQUEST) {
      break;
    }
  }
  console.log(`Recovered ${recoveredTotal} interrupted jobs`);
}

function runnerHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
