import { API_BODY_LIMIT_BYTES, CALLBACK_BODY_LIMIT_BYTES, CALLBACK_PATH_PREFIX, STATE_OBJECT_NAME } from "../shared/constants";
import { jsonResponse } from "../shared/json";
import { hashIp, normalizeGitHubRepoUrl, parseScoringCallbackBody, parseSubmissionBody } from "../shared/validation";
import type { FinalizePayload, FinalizeResult, SubmitJobInput, SubmitJobResult } from "../shared/types";

export async function handleApiRequest(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/submissions") {
    return createSubmission(request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/submission-status") {
    return jsonResponse({ open: submissionsOpen(env) && runnerOperational(env) });
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
    if (!runnerOperational(env)) {
      return runnerOffline();
    }
    return forwardState(env, "/runner-status");
  }
  if (request.method === "GET" && url.pathname === "/internal/runner/write-budget") {
    if (!runnerAuthorized(request, env)) {
      return unauthorizedRunner(env);
    }
    return forwardState(env, "/write-budget");
  }
  if (request.method === "POST" && url.pathname === "/internal/runner/claim") {
    if (!runnerAuthorized(request, env)) {
      return unauthorizedRunner(env);
    }
    return runnerOperational(env) ? claimRunnerJob(request, env) : runnerDisabled();
  }
  if (request.method === "POST" && url.pathname === "/internal/runner/heartbeat") {
    if (!runnerAuthorized(request, env)) {
      return unauthorizedRunner(env);
    }
    return runnerOperational(env) ? recordRunnerHeartbeat(env) : runnerDisabled();
  }
  if (request.method === "POST" && url.pathname === "/internal/runner/recover") {
    if (!runnerAuthorized(request, env)) {
      return unauthorizedRunner(env);
    }
    return runnerOperational(env) ? recoverRunnerJobs(env) : runnerDisabled();
  }
  if (request.method === "POST" && url.pathname === CALLBACK_PATH_PREFIX) {
    if (!runnerAuthorized(request, env)) {
      return unauthorizedRunner(env);
    }
    return callbacksEnabled(env) ? finalizeSubmission(request, env) : callbacksDisabled();
  }
  return jsonResponse({ error: "Not found" }, { status: 404 });
}

async function createSubmission(request: Request, env: Env): Promise<Response> {
  if (!submissionsOpen(env)) {
    return jsonResponse(
      { error: "新しい投稿の受付は停止中です。" },
      { status: 403 }
    );
  }
  if (!runnerOperational(env)) {
    return runnerDisabled();
  }

  let raw: string;
  try {
    raw = await readRequestBody(request, API_BODY_LIMIT_BYTES);
  } catch (error) {
    return invalidBodyResponse(error);
  }
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
  const submissionLimit = maxAcceptedSubmissions(env);
  const body: SubmitJobInput = {
    repoUrl,
    ipHash: hashIp(clientIp(request)),
    callbackBaseUrl: workerBaseUrl(request, env),
    nowIso: new Date().toISOString(),
    ...(submissionLimit ? { maxAcceptedSubmissions: submissionLimit } : {}),
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
  if (response.status === 507) {
    return new Response(response.body, { status: response.status, headers: response.headers });
  }
  const result = (await response.json()) as SubmitJobResult;
  if (!result.ok) {
    const init: ResponseInit = {
      status: result.code === "cooldown" || result.code === "submission_limit" ? 429 : 409
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

function submissionsOpen(env: Env): boolean {
  return env.SUBMISSIONS_OPEN?.trim().toLowerCase() === "true";
}

function runnerEnabled(env: Env): boolean {
  return env.RUNNER_ENABLED?.trim().toLowerCase() === "true";
}

function callbacksEnabled(env: Env): boolean {
  return env.CALLBACKS_ENABLED?.trim().toLowerCase() === "true";
}

function runnerOperational(env: Env): boolean {
  return runnerEnabled(env) && callbacksEnabled(env);
}

function maxAcceptedSubmissions(env: Env): number | undefined {
  const parsed = Number(env.MAX_ACCEPTED_SUBMISSIONS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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

function runnerDisabled(): Response {
  return jsonResponse(
    { error: "Runner is disabled", code: "runner_disabled" },
    { status: 410 }
  );
}

function callbacksDisabled(): Response {
  return jsonResponse(
    { error: "Callbacks are disabled", code: "callbacks_disabled" },
    { status: 410 }
  );
}

function runnerOffline(): Response {
  return jsonResponse({ online: false, lastSeenAt: null });
}

async function finalizeSubmission(request: Request, env: Env): Promise<Response> {
  let payload: Omit<FinalizePayload, "callbackBaseUrl" | "nowIso">;
  try {
    payload = parseScoringCallbackBody(await readRequestBody(request, CALLBACK_BODY_LIMIT_BYTES));
  } catch (error) {
    return invalidBodyResponse(error);
  }
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
  if (response.status === 507) {
    return new Response(response.body, { status: response.status, headers: response.headers });
  }
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

async function readRequestBody(request: Request, limit: number): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function invalidBodyResponse(error: unknown): Response {
  return jsonResponse(
    { error: error instanceof Error ? error.message : "Invalid request body" },
    { status: error instanceof RequestBodyTooLargeError ? 413 : 400 }
  );
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
  }
}
