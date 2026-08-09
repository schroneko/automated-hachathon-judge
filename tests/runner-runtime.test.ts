import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/container/scorer", () => ({
  scoreSubmission: async (job: { submissionId: string }) => {
    if (job.submissionId === "drain") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return {};
  }
}));

describe("Runner runtime", () => {
  it("uses the configured callback origin and drains active slots before terminal exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-runtime-"));
    const tokenPath = join(directory, "runner-token");
    const spoolPath = join(directory, "spool");
    await writeFile(tokenPath, "runner-secret\n", { mode: 0o600 });

    const originalEnvironment = new Map(
      [
        "GITHUB_TOKEN",
        "RUNNER_BASE_URL",
        "RUNNER_CONCURRENCY",
        "RUNNER_POLL_INTERVAL_MS",
        "RUNNER_SPOOL_DIR",
        "RUNNER_TOKEN_FILE"
      ].map((key) => [key, process.env[key]])
    );
    process.env.GITHUB_TOKEN = "github-token";
    process.env.RUNNER_BASE_URL = "https://judge.example.com";
    process.env.RUNNER_CONCURRENCY = "2";
    process.env.RUNNER_POLL_INTERVAL_MS = "500";
    process.env.RUNNER_SPOOL_DIR = spoolPath;
    process.env.RUNNER_TOKEN_FILE = tokenPath;

    let claimCount = 0;
    const callbackUrls: string[] = [];
    const callbackAuthorizations: Array<string | null> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/internal/runner/recover")) {
        return Response.json({ recovered: 0 });
      }
      if (url.endsWith("/internal/runner/heartbeat")) {
        return Response.json({ ok: true });
      }
      if (url.endsWith("/internal/runner/claim")) {
        claimCount += 1;
        if (claimCount > 2) {
          return new Response(null, { status: 204 });
        }
        const submissionId = claimCount === 1 ? "terminal" : "drain";
        return Response.json({
          job: {
            submissionId,
            repoUrl: `https://github.com/example/${submissionId}`,
            repo: {
              owner: "example",
              repo: submissionId,
              normalized: `example/${submissionId}`,
              canonicalUrl: `https://github.com/example/${submissionId}`
            },
            bucket: 0,
            callbackToken: `callback-${submissionId}`,
            callbackUrl: "https://attacker.example/steal",
            attempt: 1,
            pinnedSha: null,
            defaultBranch: "main",
            summary: submissionId
          }
        });
      }
      if (url.endsWith("/internal/scoring-callback")) {
        callbackUrls.push(url);
        callbackAuthorizations.push(new Headers(init?.headers).get("authorization"));
        const payload = JSON.parse(String(init?.body)) as { submissionId: string };
        return new Response(null, { status: payload.submissionId === "terminal" ? 507 : 204 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      vi.resetModules();
      await expect(import("../src/runner/index")).rejects.toThrow("Callback failed with status 507");

      expect(claimCount).toBe(2);
      expect(callbackUrls).toEqual([
        "https://judge.example.com/internal/scoring-callback",
        "https://judge.example.com/internal/scoring-callback"
      ]);
      expect(callbackAuthorizations).toEqual(["Bearer runner-secret", "Bearer runner-secret"]);
      expect(callbackUrls).not.toContain("https://attacker.example/steal");
      await expect(readdir(spoolPath)).resolves.toEqual(["terminal.json"]);
      const spooled = JSON.parse(await readFile(join(spoolPath, "terminal.json"), "utf8")) as {
        callbackUrl: string;
      };
      expect(spooled.callbackUrl).toBe("https://judge.example.com/internal/scoring-callback");
    } finally {
      consoleError.mockRestore();
      consoleLog.mockRestore();
      vi.unstubAllGlobals();
      for (const [key, value] of originalEnvironment) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
