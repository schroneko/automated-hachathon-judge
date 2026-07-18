import { describe, expect, it, vi } from "vitest";
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
    PUBLIC_BASE_URL: "https://hackathon.nukoevi.app",
    RUNNER_TOKEN: "runner-secret"
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
