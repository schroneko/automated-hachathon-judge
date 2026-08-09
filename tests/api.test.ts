import { describe, expect, it, vi } from "vitest";
import { CALLBACK_BODY_LIMIT_BYTES } from "../src/shared/constants";
import { handleApiRequest } from "../src/worker/api";

function makeEnv(fetchImpl: (request: Request) => Promise<Response> | Response) {
  const stub = {
    fetch: vi.fn(fetchImpl)
  };

  return {
    JUDGE_STATE: {
      idFromName: vi.fn(() => "state-id"),
      get: vi.fn(() => stub)
    },
    CALLBACKS_ENABLED: "true",
    PUBLIC_BASE_URL: "https://hackathon.nukoevi.app",
    RUNNER_TOKEN: "runner-secret",
    RUNNER_ENABLED: "true",
    SUBMISSIONS_OPEN: "true"
  } as any;
}

describe("handleApiRequest", () => {
  it("rejects invalid submission payloads", async () => {
    const response = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/api/submissions", {
        method: "POST",
        body: JSON.stringify({ wrong: true })
      }),
      makeEnv(async () => new Response("{}", { status: 500 })),
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );
    expect(response.status).toBe(400);
  });

  it("rejects submissions while reception is closed", async () => {
    const env = makeEnv(async () => new Response("{}", { status: 500 }));
    env.SUBMISSIONS_OPEN = "false";
    const response = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/api/submissions", {
        method: "POST",
        body: JSON.stringify({ repoUrl: "https://github.com/example/demo" })
      }),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "新しい投稿の受付は停止中です。" });
  });

  it("reports whether submissions are open", async () => {
    const env = makeEnv(async () => new Response("{}", { status: 500 }));
    env.SUBMISSIONS_OPEN = "false";
    const response = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/api/submission-status"),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );
    await expect(response.json()).resolves.toEqual({ open: false });
  });

  it("reports submissions closed when the Runner is disabled", async () => {
    const env = makeEnv(async () => new Response("{}", { status: 500 }));
    env.RUNNER_ENABLED = "false";
    env.SUBMISSIONS_OPEN = "true";

    const response = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/api/submission-status"),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );

    await expect(response.json()).resolves.toEqual({ open: false });
    expect(env.JUDGE_STATE.get).not.toHaveBeenCalled();
  });

  it("proxies ranking reads to the state object", async () => {
    const env = makeEnv(async () =>
      new Response(JSON.stringify({ items: [{ repo: "demo/app", total: 10 }] }), {
        headers: { "content-type": "application/json" }
      })
    );
    const response = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/api/ranking"),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [{ repo: "demo/app", total: 10 }] });
  });

  it("requires the runner token before claiming a job", async () => {
    const env = makeEnv(async () => new Response(null, { status: 204 }));
    const denied = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/internal/runner/claim", { method: "POST" }),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );
    expect(denied.status).toBe(401);

    const accepted = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/internal/runner/claim", {
        method: "POST",
        headers: { authorization: "Bearer runner-secret" }
      }),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );
    expect(accepted.status).toBe(204);
  });

  it("blocks disabled Runner traffic before accessing state", async () => {
    const env = makeEnv(async () => new Response(null, { status: 204 }));
    env.RUNNER_ENABLED = "false";

    for (const path of ["claim", "heartbeat", "recover"]) {
      const response = await handleApiRequest(
        new Request(`https://hackathon.nukoevi.app/internal/runner/${path}`, {
          method: "POST",
          headers: { authorization: "Bearer runner-secret" }
        }),
        env,
        { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
      );
      expect(response.status).toBe(410);
    }

    expect(env.JUDGE_STATE.get).not.toHaveBeenCalled();
  });

  it("blocks all Runner traffic when callbacks are disabled", async () => {
    const env = makeEnv(async () => new Response(null, { status: 204 }));
    env.CALLBACKS_ENABLED = "false";
    env.RUNNER_ENABLED = "true";

    for (const path of ["claim", "heartbeat", "recover"]) {
      const response = await handleApiRequest(
        new Request(`https://hackathon.nukoevi.app/internal/runner/${path}`, {
          method: "POST",
          headers: { authorization: "Bearer runner-secret" }
        }),
        env,
        { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
      );
      expect(response.status).toBe(410);
    }

    const status = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/api/runner-status"),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );
    await expect(status.json()).resolves.toEqual({ online: false, lastSeenAt: null });
    expect(env.JUDGE_STATE.get).not.toHaveBeenCalled();
  });

  it("reports a disabled Runner without accessing state", async () => {
    const env = makeEnv(async () => new Response("{}", { status: 500 }));
    env.RUNNER_ENABLED = "false";

    const response = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/api/runner-status"),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ online: false, lastSeenAt: null });
    expect(env.JUDGE_STATE.get).not.toHaveBeenCalled();
  });

  it("requires Runner authentication for write budget status even while disabled", async () => {
    const env = makeEnv(async () => Response.json({
      utcDate: "2026-08-09",
      rowsWritten: 12,
      warningEmitted: false,
      exhausted: false,
      exhaustedAt: null,
      warningRows: 25_000,
      hardLimitRows: 50_000,
      remainingRows: 49_988
    }));
    env.RUNNER_ENABLED = "false";
    env.CALLBACKS_ENABLED = "false";

    const denied = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/internal/runner/write-budget"),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );
    expect(denied.status).toBe(401);
    expect(env.JUDGE_STATE.get).not.toHaveBeenCalled();

    const accepted = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/internal/runner/write-budget", {
        headers: { authorization: "Bearer runner-secret" }
      }),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      rowsWritten: 12,
      hardLimitRows: 50_000
    });
    expect(env.JUDGE_STATE.get).toHaveBeenCalledTimes(1);
  });

  it("rejects submissions when the Runner is disabled before accessing state", async () => {
    const env = makeEnv(async () => new Response("{}", { status: 500 }));
    env.RUNNER_ENABLED = "false";

    const response = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/api/submissions", {
        method: "POST",
        body: JSON.stringify({ repoUrl: "https://github.com/example/demo" })
      }),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );

    expect(response.status).toBe(410);
    expect(env.JUDGE_STATE.get).not.toHaveBeenCalled();
  });

  it("authenticates and validates callbacks before accessing state", async () => {
    const unauthorizedEnv = makeEnv(async () => new Response("{}"));
    const unauthorized = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/internal/scoring-callback", {
        method: "POST",
        body: "{}"
      }),
      unauthorizedEnv,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorizedEnv.JUDGE_STATE.get).not.toHaveBeenCalled();

    const invalidEnv = makeEnv(async () => new Response("{}"));
    const invalid = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/internal/scoring-callback", {
        method: "POST",
        headers: { authorization: "Bearer runner-secret" },
        body: "{}"
      }),
      invalidEnv,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );
    expect(invalid.status).toBe(400);
    expect(invalidEnv.JUDGE_STATE.get).not.toHaveBeenCalled();

    const oversizedEnv = makeEnv(async () => new Response("{}"));
    const oversized = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/internal/scoring-callback", {
        method: "POST",
        headers: { authorization: "Bearer runner-secret" },
        body: "x".repeat(CALLBACK_BODY_LIMIT_BYTES + 1)
      }),
      oversizedEnv,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );
    expect(oversized.status).toBe(413);
    expect(oversizedEnv.JUDGE_STATE.get).not.toHaveBeenCalled();
  });

  it("preserves write budget exhaustion responses", async () => {
    let requestCount = 0;
    const env = makeEnv(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return Response.json({ online: true });
      }
      return Response.json(
        {
          ok: false,
          code: "write_budget_exhausted",
          message: "Durable Object write budget exhausted"
        },
        { status: 507 }
      );
    });

    const response = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/api/submissions", {
        method: "POST",
        body: JSON.stringify({ repoUrl: "https://github.com/example/budget" })
      }),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );

    expect(response.status).toBe(507);
    await expect(response.json()).resolves.toMatchObject({ code: "write_budget_exhausted" });
  });

  it("forwards a schema-valid multibyte callback larger than 64 KiB", async () => {
    const env = makeEnv(async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" }
      })
    );
    const body = multibyteCallbackBody();
    const bodySize = new TextEncoder().encode(body).byteLength;

    expect(bodySize).toBeGreaterThan(65_536);
    expect(bodySize).toBeLessThanOrEqual(CALLBACK_BODY_LIMIT_BYTES);

    const response = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/internal/scoring-callback", {
        method: "POST",
        headers: { authorization: "Bearer runner-secret" },
        body
      }),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );

    expect(response.status).toBe(200);
    expect(env.JUDGE_STATE.get).toHaveBeenCalledTimes(1);
  });

  it("allows authenticated in-flight callbacks while the Runner is disabled", async () => {
    const env = makeEnv(async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" }
      })
    );
    env.RUNNER_ENABLED = "false";

    const response = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/internal/scoring-callback", {
        method: "POST",
        headers: { authorization: "Bearer runner-secret" },
        body: JSON.stringify({
          submissionId: "submission-id",
          callbackToken: "callback-token",
          bucket: 0,
          outcome: { kind: "failed", message: "failed" }
        })
      }),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );

    expect(response.status).toBe(200);
    expect(env.JUDGE_STATE.get).toHaveBeenCalledTimes(1);
  });

  it("blocks callbacks before state access when callback draining is disabled", async () => {
    const env = makeEnv(async () => new Response("{}", { status: 500 }));
    env.RUNNER_ENABLED = "false";
    env.CALLBACKS_ENABLED = "false";

    const response = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/internal/scoring-callback", {
        method: "POST",
        headers: { authorization: "Bearer runner-secret" },
        body: JSON.stringify({
          submissionId: "submission-id",
          callbackToken: "callback-token",
          bucket: 0,
          outcome: { kind: "failed", message: "failed" }
        })
      }),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );

    expect(response.status).toBe(410);
    expect(env.JUDGE_STATE.get).not.toHaveBeenCalled();
  });

  it("proxies the public runner status", async () => {
    const env = makeEnv(async () =>
      new Response(JSON.stringify({ online: true, lastSeenAt: "2026-07-17T00:00:00.000Z" }), {
        headers: { "content-type": "application/json" }
      })
    );
    const response = await handleApiRequest(
      new Request("https://hackathon.nukoevi.app/api/runner-status"),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
    );
    await expect(response.json()).resolves.toEqual({
      online: true,
      lastSeenAt: "2026-07-17T00:00:00.000Z"
    });
  });
});

function multibyteCallbackBody(): string {
  const evidencePaths = Array.from({ length: 24 }, (_, index) =>
    `${String(index).padStart(2, "0")}-${"あ".repeat(297)}`
  );
  return JSON.stringify({
    submissionId: "submission-id",
    callbackToken: "callback-token",
    bucket: 0,
    outcome: {
      kind: "completed",
      result: {
        summary: "empty",
        publicReason: "empty",
        repoAssessment: "empty_repository",
        pinnedSha: null,
        total: 0,
        criteria: [
          { key: "technical", label: "技術的な実装", score: 0, reason: "no", evidencePaths },
          { key: "ux", label: "デザインとユーザー体験", score: 0, reason: "no", evidencePaths },
          { key: "impact", label: "潜在的なインパクト", score: 0, reason: "no", evidencePaths },
          { key: "idea", label: "アイデアの質", score: 0, reason: "no", evidencePaths }
        ]
      }
    }
  });
}
