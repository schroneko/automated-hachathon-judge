import { CALLBACK_PATH_PREFIX, STATE_OBJECT_NAME } from "../shared/constants";
import { jsonResponse } from "../shared/json";
import { hashIp, normalizeGitHubRepoUrl, parseSubmissionBody } from "../shared/validation";
import type { FinalizePayload, FinalizeResult, SubmitJobInput, SubmitJobResult } from "../shared/types";

export async function handleApiRequest(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/submissions") {
    return createSubmission(request, env);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/submissions/")) {
    const id = url.pathname.split("/").at(-1) ?? "";
    return forwardState(env, `/submission/${id}`);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/results/")) {
    const id = url.pathname.split("/").at(-1) ?? "";
    return forwardState(env, `/submission/${id}`);
  }
  if (request.method === "GET" && url.pathname === "/api/recent") {
    return forwardState(env, "/recent");
  }
  if (request.method === "GET" && url.pathname === "/api/ranking") {
    return forwardState(env, "/ranking");
  }
  if (request.method === "GET" && url.pathname === "/api/runner-status") {
    return forwardState(env, "/runner-status");
  }
  if (request.method === "POST" && url.pathname === "/internal/runner/claim") {
    return runnerAuthorized(request, env) ? claimRunnerJob(request, env) : unauthorizedRunner(env);
  }
  if (request.method === "POST" && url.pathname === "/internal/runner/heartbeat") {
    return runnerAuthorized(request, env) ? recordRunnerHeartbeat(env) : unauthorizedRunner(env);
  }
  if (request.method === "POST" && url.pathname === "/internal/runner/recover") {
    return runnerAuthorized(request, env) ? recoverRunnerJobs(env) : unauthorizedRunner(env);
  }
  if (request.method === "POST" && url.pathname === CALLBACK_PATH_PREFIX) {
    return finalizeSubmission(request, env);
  }
  return jsonResponse({ error: "Not found" }, { status: 404 });
}

async function createSubmission(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  let repoUrl: string;
  try {
    ({ repoUrl } = parseSubmissionBody(raw));
    normalizeGitHubRepoUrl(repoUrl);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const runnerStatus = await stateStub(env).fetch("https://state/runner-status");
  const runner = (await runnerStatus.json()) as { online: boolean };
  if (!runner.online) {
    return jsonResponse(
      { error: "採点 Runner が停止中です。主催者が復旧するまで待ってください。" },
      { status: 503 }
    );
  }

  const repo = normalizeGitHubRepoUrl(repoUrl);
  const body: SubmitJobInput = {
    repoUrl,
    ipHash: hashIp(clientIp(request)),
    callbackBaseUrl: workerBaseUrl(request, env),
    nowIso: new Date().toISOString(),
    resolution: {
      assessment: "scored",
      pinnedSha: null,
      defaultBranch: null,
      summary: `${repo.normalized} の提出時点スナップショット`
    }
  };

  const response = await stateStub(env).fetch("https://state/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = (await response.json()) as SubmitJobResult;
  if (!result.ok) {
    const init: ResponseInit = {
      status: result.code === "cooldown" ? 429 : 409
    };
    if (result.retryAfterMs) {
      init.headers = { "retry-after": String(Math.ceil(result.retryAfterMs / 1000)) };
    }
    return jsonResponse(result, init);
  }

  return jsonResponse(
    {
      submission: result.submission
    },
    { status: 202 }
  );
}

async function claimRunnerJob(request: Request, env: Env): Promise<Response> {
  const response = await stateStub(env).fetch("https://state/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      callbackBaseUrl: workerBaseUrl(request, env),
      nowIso: new Date().toISOString()
    })
  });
  return new Response(response.body, { status: response.status, headers: response.headers });
}

async function recordRunnerHeartbeat(env: Env): Promise<Response> {
  const response = await stateStub(env).fetch("https://state/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nowIso: new Date().toISOString() })
  });
  return new Response(response.body, { status: response.status, headers: response.headers });
}

async function recoverRunnerJobs(env: Env): Promise<Response> {
  const response = await stateStub(env).fetch("https://state/recover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nowIso: new Date().toISOString() })
  });
  return new Response(response.body, { status: response.status, headers: response.headers });
}

function runnerAuthorized(request: Request, env: Env): boolean {
  const configured = env.RUNNER_TOKEN?.trim();
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return Boolean(configured && supplied && configured === supplied);
}

function unauthorizedRunner(env: Env): Response {
  return jsonResponse(
    { error: env.RUNNER_TOKEN ? "Unauthorized" : "Runner is not configured" },
    { status: env.RUNNER_TOKEN ? 401 : 503 }
  );
}

async function finalizeSubmission(request: Request, env: Env): Promise<Response> {
  const payload = (await request.json()) as Omit<FinalizePayload, "callbackBaseUrl" | "nowIso">;
  const statePayload: FinalizePayload = {
    ...payload,
    callbackBaseUrl: workerBaseUrl(request, env),
    nowIso: new Date().toISOString()
  };
  const response = await stateStub(env).fetch("https://state/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(statePayload)
  });
  const result = (await response.json()) as FinalizeResult;
  return jsonResponse(result, { status: response.status });
}

async function forwardState(env: Env, path: string): Promise<Response> {
  const response = await stateStub(env).fetch(`https://state${path}`);
  return new Response(response.body, {
    status: response.status,
    headers: response.headers
  });
}

function stateStub(env: Env): DurableObjectStub<import("./judge-state").JudgeState> {
  return env.JUDGE_STATE.get(env.JUDGE_STATE.idFromName(STATE_OBJECT_NAME));
}

function clientIp(request: Request): string {
  const header = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "0.0.0.0";
  return header.split(",")[0]?.trim() || "0.0.0.0";
}

function workerBaseUrl(request: Request, env: Env): string {
  return env.PUBLIC_BASE_URL?.trim() || new URL(request.url).origin;
}
