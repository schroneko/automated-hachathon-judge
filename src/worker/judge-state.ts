import { jsonResponse } from "../shared/json";
import { RUNNER_ONLINE_WINDOW_MS } from "../shared/constants";
import { DurableObject } from "cloudflare:workers";
import { claimJob, createInitialSnapshot, finalizeJob, getRanking, getRecentSubmissions, getSubmission, recoverProcessingJobs, submitJob, toPublicSubmission } from "./state-machine";
import type { AppStateSnapshot, FinalizePayload, SubmissionRecord, SubmitJobInput } from "../shared/types";

export class JudgeState extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const snapshot = await this.load();

    if (request.method === "POST" && url.pathname === "/submit") {
      const body = (await request.json()) as SubmitJobInput;
      const result = submitJob(snapshot, body);
      await this.save(snapshot);
      return jsonResponse(result, { status: result.ok ? 202 : 409 });
    }

    if (request.method === "POST" && url.pathname === "/finalize") {
      const body = (await request.json()) as FinalizePayload;
      const result = finalizeJob(snapshot, body);
      await this.save(snapshot);
      return jsonResponse(result, { status: result.ok ? 200 : 409 });
    }

    if (request.method === "POST" && url.pathname === "/claim") {
      const body = (await request.json()) as { callbackBaseUrl: string; nowIso: string };
      const job = claimJob(snapshot, body.callbackBaseUrl, body.nowIso);
      await this.save(snapshot);
      return job ? jsonResponse({ job }) : new Response(null, { status: 204 });
    }

    if (request.method === "POST" && url.pathname === "/heartbeat") {
      const body = (await request.json()) as { nowIso: string };
      snapshot.runnerLastSeenAt = body.nowIso;
      await this.save(snapshot);
      return jsonResponse({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/recover") {
      const body = (await request.json()) as { nowIso: string };
      const recovered = recoverProcessingJobs(snapshot, body.nowIso);
      await this.save(snapshot);
      return jsonResponse({ ok: true, recovered });
    }

    if (request.method === "GET" && url.pathname.startsWith("/submission/")) {
      const id = url.pathname.split("/").at(-1) ?? "";
      const submission = getSubmission(snapshot, id);
      if (!submission) {
        return jsonResponse({ error: "Not found" }, { status: 404 });
      }
      return jsonResponse(toPublicSubmission(submission));
    }

    if (request.method === "GET" && url.pathname === "/recent") {
      return jsonResponse({ items: getRecentSubmissions(snapshot) });
    }

    if (request.method === "GET" && url.pathname === "/ranking") {
      return jsonResponse({ items: getRanking(snapshot) });
    }

    if (request.method === "GET" && url.pathname === "/runner-status") {
      const lastSeenAt = snapshot.runnerLastSeenAt;
      const online = Boolean(
        lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() <= RUNNER_ONLINE_WINDOW_MS
      );
      return jsonResponse({ online, lastSeenAt });
    }

    return jsonResponse({ error: "Not found" }, { status: 404 });
  }

  private async load(): Promise<AppStateSnapshot> {
    const meta = await this.ctx.storage.get<Omit<AppStateSnapshot, "jobs">>("meta");
    if (!meta) return createInitialSnapshot();
    const storedJobs = await this.ctx.storage.list<SubmissionRecord>({ prefix: "job:" });
    return {
      ...meta,
      runnerLastSeenAt: meta.runnerLastSeenAt ?? null,
      jobs: Object.fromEntries(Array.from(storedJobs.entries()).map(([key, value]) => [key.slice(4), value]))
    };
  }

  private async save(snapshot: AppStateSnapshot): Promise<void> {
    const { jobs, ...meta } = snapshot;
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.put(Object.fromEntries(Object.entries(jobs).map(([id, job]) => [`job:${id}`, job])));
  }
}
