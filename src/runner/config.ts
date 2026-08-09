export function requireRunnerBaseUrl(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) {
    throw new Error("RUNNER_BASE_URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("RUNNER_BASE_URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("RUNNER_BASE_URL must be an absolute http(s) URL");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("RUNNER_BASE_URL must contain only a Worker origin");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !loopback) {
    throw new Error("RUNNER_BASE_URL must use https outside local development");
  }
  return parsed.origin;
}

export function shouldStopRunner(response: Response): boolean {
  return response.status === 401 || response.status === 403 || response.status === 410 || response.status === 507;
}

export function isPermanentCallbackFailure(response: Response): boolean {
  return response.status === 507 || (
    response.status >= 400
    && response.status < 500
    && response.status !== 408
    && response.status !== 409
    && response.status !== 429
  );
}
