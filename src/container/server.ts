import { createServer } from "node:http";
import type { FinalizePayload, FinalizeResult, LeaseJob } from "../shared/types";
import { scoreSubmission, RetryableScoringError } from "./scorer";

const port = Number(process.env.PORT ?? "8080");
let queue = Promise.resolve();

createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.writeHead(400).end("Bad Request");
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && req.url === "/score") {
      const body = await readJson<{ job: LeaseJob }>(req);
      queue = queue.then(() => drainQueue(body.job)).catch((error) => console.error(error));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404).end("Not Found");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: message }));
  }
}).listen(port);

async function drainQueue(initialJob: LeaseJob): Promise<void> {
  let currentJob: LeaseJob | undefined = initialJob;

  while (currentJob) {
    const outcome = await scoreWithOutcome(currentJob);
    const response = await fetch(currentJob.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        submissionId: currentJob.submissionId,
        callbackToken: currentJob.callbackToken,
        bucket: currentJob.bucket,
        outcome
      } satisfies Omit<FinalizePayload, "callbackBaseUrl" | "nowIso">)
    });

    if (!response.ok) {
      throw new Error(`Callback failed with status ${response.status}`);
    }
    const result = (await response.json()) as FinalizeResult;
    currentJob = result.nextJob;
  }
}

async function scoreWithOutcome(job: LeaseJob): Promise<FinalizePayload["outcome"]> {
  try {
    const result = await scoreSubmission(job);
    return {
      kind: "completed",
      result
    };
  } catch (error) {
    if (error instanceof RetryableScoringError || job.attempt < 2) {
      return {
        kind: "retryable_failure",
        message: error instanceof Error ? error.message : "Unexpected failure"
      };
    }
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : "Unexpected failure"
    };
  }
}

async function readJson<T>(request: import("node:http").IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
