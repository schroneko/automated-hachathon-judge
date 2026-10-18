import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const help = { usage: "node scripts/verify-worker-concurrency.mjs [--timeout]", runtime: "local workerd via global wrangler", offline: true,
  scenarios: ["small", "wait", "source", "restore"], requestsPerScenario: 8,
  timeout: "Opt in to a 125000ms holder, a 120000ms memory admission timeout, and a subsequent acquisition check" };

if (args.length === 1 && args[0] === "--help") {
  output(help);
} else if (args.length > 1 || (args.length === 1 && args[0] !== "--timeout")) {
  output({ ok: false, stage: "arguments", error: "unknown_arguments", usage: help.usage });
  process.exitCode = 1;
} else {
  await verify(args[0] === "--timeout");
}

async function globalWrangler(root) {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = join(entry, "wrangler");
    try {
      await access(candidate, constants.X_OK);
      const target = await realpath(candidate);
      if (candidate.startsWith(`${root}${sep}`) || target.startsWith(`${root}${sep}`)) continue;
      return target;
    } catch {}
  }
  throw Object.assign(new Error("global_wrangler_unavailable"), { safeError: "global_wrangler_unavailable" });
}

async function ephemeralPort() {
  const server = createServer();
  try {
    await new Promise((resolvePort, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePort);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("port_unavailable");
    return address.port;
  } finally {
    if (server.listening) await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
}

function childEnvironment(directory) {
  const env = {};
  for (const name of ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SYSTEMROOT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, TMPDIR: join(directory, "tmp"), TMP: join(directory, "tmp"), TEMP: join(directory, "tmp"),
    XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"),
    WRANGLER_LOG_PATH: join(directory, "logs", "wrangler.log"), WRANGLER_SEND_METRICS: "false", CI: "true" };
}

async function verify(includeTimeout) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const shutdown = new AbortController();
  let interrupted = 0;
  let stage = "setup";
  let directory;
  let child;
  let childClosed;
  let closed = false;
  let childExit = null;
  let spawnFailed = false;
  let logTail = Buffer.alloc(0);
  let logBytes = 0;
  const onInterrupt = () => { interrupted = 130; shutdown.abort(); };
  const onTerminate = () => { interrupted = 143; shutdown.abort(); };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const check = (condition, error = "bad_metadata", metadata = {}) => {
    if (!condition) throw Object.assign(new Error(error), { safeError: error, metadata });
  };
  const checkChild = () => {
    check(!shutdown.signal.aborted, "interrupted");
    check(!closed && !spawnFailed, "child_exited");
  };
  const capture = (chunk) => {
    logBytes += chunk.length;
    logTail = Buffer.concat([logTail, chunk]).subarray(-65_536);
  };
  const signalGroup = (signal) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const groupAlive = () => {
    if (!child?.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  const request = async (base, route, timeoutMs = 20_000) => {
    checkChild();
    let response;
    try {
      response = await fetch(`${base}/${route}`, { signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs)]), redirect: "error" });
      const body = await response.json();
      checkChild();
      return { status: response.status, body };
    } catch (error) {
      if (error.safeError) throw error;
      throw Object.assign(new Error("request_failed"), { safeError: "request_failed", metadata: { route, status: response?.status ?? null } });
    }
  };
  const expectOk = (result, route) => {
    check(result.status === 200 && result.body.ok === true && result.body.route === route, "unexpected_response", { route, status: result.status });
    check(Number.isFinite(result.body.durationMs) && result.body.durationMs >= 0);
  };
  let failure;
  try {
    stage = "wrangler_resolution";
    const wrangler = await globalWrangler(root);
    check(!shutdown.signal.aborted, "interrupted");
    stage = "temporary_config";
    directory = await mkdtemp(join(tmpdir(), "workerd-concurrency-"));
    await Promise.all(["tmp", "config", "cache", "state", "logs"].map((name) => mkdir(join(directory, name))));
    const config = join(directory, "wrangler.json");
    await writeFile(config, JSON.stringify({ name: "workerd-concurrency-fixture", main: join(root, "tests", "workerd-concurrency.fixture.ts"),
      compatibility_date: "2026-10-18", compatibility_flags: ["nodejs_compat"] }));
    stage = "loopback_port";
    let port = await ephemeralPort();
    while (port === 8791) port = await ephemeralPort();
    check(!shutdown.signal.aborted, "interrupted");
    stage = "startup";
    child = spawn(wrangler, ["dev", "--local", "--config", config, "--ip", "127.0.0.1", "--port", String(port),
      "--inspector-port", "0", "--persist-to", join(directory, "state"), "--log-level", "error"], {
      cwd: directory, env: childEnvironment(directory), detached: true, stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", () => { spawnFailed = true; });
    childClosed = new Promise((resolveClosed) => child.once("close", (code, signal) => {
      closed = true;
      childExit = { code, signal };
      resolveClosed();
    }));
    const base = `http://127.0.0.1:${port}`;
    const healthDeadline = Date.now() + 45_000;
    let health;
    stage = "health";
    while (Date.now() < healthDeadline) {
      checkChild();
      try { health = await request(base, "health", Math.max(1, Math.min(2000, healthDeadline - Date.now()))); } catch (error) {
        checkChild();
        if (error.safeError !== "request_failed") throw error;
      }
      if (health?.status === 200) break;
      await delay(100, undefined, { signal: shutdown.signal });
    }
    check(health?.status === 200, "health_deadline");
    expectOk(health, "health");
    check(health.body.ready === true && health.body.offline === true && health.body.runtime === "workerd"
      && health.body.concurrency === 8 && health.body.holdMs === 250 && health.body.phaseMs === 25 && health.body.expectedFiles === 2);
    check(["refsReads", "filteredReads", "blobReads", "deniedFetches"].every((key) => health.body[key] === 0));
    for (const route of ["small", "wait", "source", "restore"]) {
      stage = route;
      const started = Date.now();
      const results = await Promise.all(Array.from({ length: 8 }, () => request(base, route)));
      for (const result of results) {
        expectOk(result, route);
        const body = result.body;
        if (route === "small" || route === "wait") {
          check(body.holdMs === 250 && body.initialReservationMiB === 64 && body.durationMs >= 250 && body.admittedMs >= 0);
          check(Number.isSafeInteger(body.acquiredAt) && Number.isSafeInteger(body.completedAt) && body.completedAt - body.acquiredAt >= 250);
          check(body.arrivalOrder === body.admissionOrder, "fifo_order");
          if (route === "small") check(body.snapshotBytes === 1000);
        } else {
          check(body.files === 2 && body.fullSource === true);
          if (route === "source") check(body.offline === true);
          else check(body.chunkReads === 1 && body.chunks === 1);
        }
      }
      const durationMs = Date.now() - started;
      if (route === "small" || route === "wait") {
        check(results.map(({ body }) => body.arrivalOrder).sort((a, b) => a - b).every((value, index) => value === index + 1));
        if (route === "wait") {
          const ordered = results.map(({ body }) => body).sort((a, b) => a.admissionOrder - b.admissionOrder);
          check(durationMs >= 2000 && ordered.every((body, index) => index === 0 || body.acquiredAt >= ordered[index - 1].completedAt), "wait_not_serialized");
        }
      }
      const finalHealth = await request(base, "health");
      expectOk(finalHealth, "health");
      check(finalHealth.body.deniedFetches === 0, "network_denied");
      if (route === "source") check(["refsReads", "filteredReads", "blobReads"].every((key) => finalHealth.body[key] === 8), "git_phases_missing");
      output({ route, requests: 8, statuses: results.map(({ status }) => status), durationMs,
        requestDurationMs: results.map(({ body }) => body.durationMs),
        ...(route === "small" || route === "wait" ? { fifo: true, admissionMs: results.map(({ body }) => body.admittedMs) } : { files: 2, fullSource: true }),
        ...(route === "source" ? { offline: true, refsReads: 8, filteredReads: 8, blobReads: 8 } : {}),
        ...(route === "restore" ? { chunkReads: results.map(({ body }) => body.chunkReads) } : {}), pass: true });
    }
    if (includeTimeout) {
      stage = "timeout";
      const holder = request(base, "holder", 140_000).then((result) => ({ result }), () => ({ failed: true }));
      const readinessDeadline = Date.now() + 5000;
      let ready;
      while (Date.now() < readinessDeadline) {
        ready = await request(base, "holder-ready", 2000);
        expectOk(ready, "holder-ready");
        if (ready.body.holderActive === true) break;
        await delay(25, undefined, { signal: shutdown.signal });
      }
      check(ready?.body.holderActive === true && ready.body.holderStarted === true, "holder_not_ready");
      const timedOut = await request(base, "wait", 130_000);
      check(timedOut.status === 408 && timedOut.body.ok === false && timedOut.body.route === "wait"
        && timedOut.body.error === "memory_acquisition_timeout" && timedOut.body.timeoutMs === 120_000
        && timedOut.body.durationMs >= 120_000 && timedOut.body.durationMs < 125_000, "timeout_contract", { status: timedOut.status });
      const held = await holder;
      check(!held.failed, "holder_failed");
      expectOk(held.result, "holder");
      check(held.result.body.holdMs === 125_000 && held.result.body.durationMs >= 125_000);
      const finished = await request(base, "holder-ready");
      expectOk(finished, "holder-ready");
      check(finished.body.holderFinished === true && finished.body.holderActive === false);
      const recovered = await request(base, "wait");
      expectOk(recovered, "wait");
      check(recovered.body.holdMs === 250 && recovered.body.admittedMs < 1000, "leaked_memory_ticket");
      output({ route: "timeout", statuses: [held.result.status, timedOut.status, recovered.status],
        holderDurationMs: held.result.body.durationMs, timeoutDurationMs: timedOut.body.durationMs,
        recoveredDurationMs: recovered.body.durationMs, noLeakedTicket: true, pass: true });
    }
    stage = "cleanup";
  } catch (error) {
    failure = { ok: false, stage, error: error.safeError ?? "verification_failed",
      ...(/^[A-Z][A-Z0-9_]+$/.test(error.code ?? "") ? { code: error.code } : {}), ...(error.metadata ?? {}) };
  } finally {
    shutdown.abort();
    try {
      if (child) {
        signalGroup("SIGTERM");
        const deadline = Date.now() + 3000;
        while ((groupAlive() || !closed) && Date.now() < deadline) await delay(50);
        if (groupAlive() || !closed) signalGroup("SIGKILL");
        const killDeadline = Date.now() + 3000;
        while ((groupAlive() || !closed) && Date.now() < killDeadline) await delay(50);
        check(closed && !groupAlive(), "process_group_cleanup_failed");
        await childClosed;
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    } catch {
      failure ??= { ok: false, stage: "cleanup", error: "cleanup_failed" };
    }
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
  if (failure || interrupted) {
    output({ ...(failure ?? { ok: false, stage, error: "interrupted" }), childExit, logBytes });
    process.exitCode = interrupted || 1;
  } else {
    output({ ok: true, runtime: "workerd", offline: true, scenarios: 4, requests: 32, timeoutTest: includeTimeout, cleanedUp: true, pass: true });
  }
}
