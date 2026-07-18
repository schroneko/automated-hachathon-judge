import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FinalizePayload, LeaseJob } from "../shared/types";
import { scoreSubmission } from "../container/scorer";

type RunnerOutcome = Omit<FinalizePayload, "callbackBaseUrl" | "nowIso">;

interface PendingResult {
  callbackUrl: string;
  payload: RunnerOutcome;
}

const baseUrl = (process.env.RUNNER_BASE_URL ?? "https://hackathon.nukoevi.app").replace(/\/+$/, "");
const tokenFile = process.env.RUNNER_TOKEN_FILE ?? join(homedir(), "Library", "Application Support", "Hackathon Judge", "runner-token");
const spoolDir = process.env.RUNNER_SPOOL_DIR ?? join(homedir(), "Library", "Application Support", "Hackathon Judge", "spool");
const concurrency = boundedInteger(process.env.RUNNER_CONCURRENCY, 4, 1, 4);
const pollIntervalMs = boundedInteger(process.env.RUNNER_POLL_INTERVAL_MS, 2000, 500, 30000);
const token = (await readFile(tokenFile, "utf8")).trim();
let shuttingDown = false;

if (!token) {
  throw new Error("Runner token is empty");
}

process.once("SIGINT", () => {
  shuttingDown = true;
});
process.once("SIGTERM", () => {
  shuttingDown = true;
});

await mkdir(spoolDir, { recursive: true, mode: 0o700 });
await replayPendingResults();

const heartbeatTimer = setInterval(() => {
  void sendHeartbeat();
}, 5000);
heartbeatTimer.unref();
await sendHeartbeat();

console.log(`Runner started with ${concurrency} slots`);
await Promise.all(Array.from({ length: concurrency }, (_, slot) => runSlot(slot + 1)));

async function runSlot(slot: number): Promise<void> {
  while (!shuttingDown) {
    try {
      const job = await claimJob();
      if (!job) {
        await sleep(pollIntervalMs);
        continue;
      }
      console.log(`Slot ${slot} claimed ${job.submissionId}`);
      await processJob(job);
      console.log(`Slot ${slot} completed ${job.submissionId}`);
    } catch (error) {
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
    outcome = {
      kind: "failed",
      message: error instanceof Error ? error.message : "Unexpected failure"
    };
  }

  const pending: PendingResult = {
    callbackUrl: job.callbackUrl,
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
      const response = await fetch(pending.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pending.payload),
        signal: AbortSignal.timeout(15000)
      });
      if (response.ok || response.status === 409) {
        return;
      }
      throw new Error(`Callback failed with status ${response.status}`);
    } catch (error) {
      console.error(`Callback pending for ${pending.payload.submissionId}`, error);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 30000);
    }
  }
  throw new Error("Runner stopped before callback completed");
}

async function sendHeartbeat(): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/internal/runner/heartbeat`, {
      method: "POST",
      headers: runnerHeaders(),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      throw new Error(`Heartbeat failed with status ${response.status}`);
    }
  } catch (error) {
    console.error("Heartbeat error", error);
  }
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
