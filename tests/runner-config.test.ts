import { describe, expect, it } from "vitest";
import { isPermanentCallbackFailure, requireRunnerBaseUrl, shouldStopRunner } from "../src/runner/config";

describe("runner configuration", () => {
  it("requires an explicit base URL", () => {
    expect(() => requireRunnerBaseUrl(undefined)).toThrow("RUNNER_BASE_URL is required");
    expect(() => requireRunnerBaseUrl("  ")).toThrow("RUNNER_BASE_URL is required");
  });

  it("accepts only absolute HTTP URLs", () => {
    expect(requireRunnerBaseUrl("https://judge.example.com/")).toBe("https://judge.example.com");
    expect(requireRunnerBaseUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(() => requireRunnerBaseUrl("judge.example.com")).toThrow();
    expect(() => requireRunnerBaseUrl("ftp://judge.example.com")).toThrow();
    expect(() => requireRunnerBaseUrl("http://judge.example.com")).toThrow();
    expect(() => requireRunnerBaseUrl("https://judge.example.com/path")).toThrow();
    expect(() => requireRunnerBaseUrl("https://user:pass@judge.example.com")).toThrow();
    expect(() => requireRunnerBaseUrl("https://judge.example.com?target=other")).toThrow();
  });

  it("distinguishes an explicit disabled response from transient failure", () => {
    expect(shouldStopRunner(new Response(null, { status: 401 }))).toBe(true);
    expect(shouldStopRunner(new Response(null, { status: 403 }))).toBe(true);
    expect(shouldStopRunner(new Response(null, { status: 410 }))).toBe(true);
    expect(shouldStopRunner(new Response(null, { status: 507 }))).toBe(true);
    expect(shouldStopRunner(new Response(null, { status: 503 }))).toBe(false);
  });

  it("does not retry permanent callback failures", () => {
    expect(isPermanentCallbackFailure(new Response(null, { status: 400 }))).toBe(true);
    expect(isPermanentCallbackFailure(new Response(null, { status: 401 }))).toBe(true);
    expect(isPermanentCallbackFailure(new Response(null, { status: 410 }))).toBe(true);
    expect(isPermanentCallbackFailure(new Response(null, { status: 408 }))).toBe(false);
    expect(isPermanentCallbackFailure(new Response(null, { status: 409 }))).toBe(false);
    expect(isPermanentCallbackFailure(new Response(null, { status: 429 }))).toBe(false);
    expect(isPermanentCallbackFailure(new Response(null, { status: 503 }))).toBe(false);
    expect(isPermanentCallbackFailure(new Response(null, { status: 507 }))).toBe(true);
  });
});
