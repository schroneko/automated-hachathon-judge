import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRITERIA, JUDGING_START_ISO, PRODUCTION_SUBMISSION_LIMIT, SUBMISSION_DEADLINE_ISO, VALIDATION_SUBMISSION_LIMIT } from "../src/shared/constants";
import { validatePublicScoreResult } from "../src/shared/validation";
import { DECISION_CONDITIONS } from "../src/shared/decision-conditions";
import type { FreezeQueueMessage, JudgeQueueMessage, PublicBatchRecord, PublicSubmissionRecord, RepoResolution, ScoringQueueMessage } from "../src/shared/types";
import { callback, claimQueueMessage, handleApiRequest, reserve, settle } from "../src/worker/api";
import { listBatches, processFreezeMessage } from "../src/worker/batches";
import { processExplanationMessage, processScoringMessage } from "../src/worker/queue";
import { loadEvidenceSnapshot } from "../src/worker/evidence-store";
import type { SubmissionRow } from "../src/worker/api";
import type { ExplanationQueueMessage } from "../src/shared/types";
import { resolveRepoAuthority } from "../src/container/github";
import worker from "../src/worker/index";

vi.mock("../src/container/github", async (original) => ({ ...await original<typeof import("../src/container/github")>(), resolveRepoAuthority: vi.fn() }));

type Payload = { batch: PublicBatchRecord; submissions: PublicSubmissionRecord[] };
const resolver = vi.mocked(resolveRepoAuthority);
const frozen: RepoResolution = { assessment: "scored", pinnedSha: "a".repeat(40), defaultBranch: "main", summary: "snapshot" };

class LocalD1 {
  readonly db = new DatabaseSync(":memory:");
  queries = 0;
  private pending: Promise<unknown> = Promise.resolve();

  constructor() {
    const base = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(base).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) this.db.exec(readFileSync(new URL(file, base), "utf8"));
  }

  prepare(sql: string) {
    const owner = this;
    return { bind(...values: unknown[]) {
      return {
        async first<T>() { owner.queries++; return (owner.db.prepare(sql).get(...values as []) ?? null) as T | null; },
        async all<T>() { owner.queries++; return { results: owner.db.prepare(sql).all(...values as []) as T[] }; },
        async run() { owner.queries++; return { meta: { changes: Number(owner.db.prepare(sql).run(...values as []).changes) } }; }
      };
    } };
  }

  async batch(statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>) {
    const task = this.pending.then(async () => {
      this.db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        this.db.exec("COMMIT");
        return results;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
    this.pending = task.catch(() => undefined);
    return task;
  }

  changes() { return Number((this.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n); }
  rows() { return this.db.prepare("SELECT * FROM devday_judge_submissions ORDER BY repo_normalized").all() as Array<Record<string, unknown>>; }
}

function input(count = 1, mode: "production" | "validation" = "production", prefix = "repo") {
  return { id: crypto.randomUUID(), mode, items: Array.from({ length: count }, (_, index) => ({ teamName: `Team ${index}`, repoUrl: `https://github.com/example/${prefix}-${index}`, submittedAt: SUBMISSION_DEADLINE_ISO })) };
}

function setup() {
  const database = new LocalD1();
  const messages: JudgeQueueMessage[] = [];
  let sendHook: (message: JudgeQueueMessage) => void | Promise<void> = () => undefined;
  const env = { JUDGE_DB: database, JUDGING_ENABLED: "true", SUBMISSIONS_OPEN: "true", SCORING_QUEUE: { send: async (message: JudgeQueueMessage) => { messages.push(message); await sendHook(message); } } } as unknown as Env;
  const call = (path: string, method = "GET", body?: unknown, origin?: string) => handleApiRequest(new Request(`https://judge.example${path}`, { method, headers: { "content-type": "application/json", ...(origin === undefined ? {} : { origin }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, {} as ExecutionContext);
  const create = async (value = input()) => {
    const response = await call("/api/batches", "POST", value);
    return { response, payload: await response.json() as Payload };
  };
  const controls = () => messages.filter((message): message is FreezeQueueMessage => "type" in message && message.type === "freeze_batch");
  const scoring = () => messages.filter((message): message is ScoringQueueMessage => !("type" in message));
  return { database, env, messages, call, create, controls, scoring, onSend: (hook: typeof sendHook) => { sendHook = hook; } };
}

function sourceFixture(empty = false) {
  const object = (type: number, name: string, data: Buffer) => ({ type, data, sha: createHash("sha1").update(`${name} ${data.length}\0`).update(data).digest("hex") });
  const blob = object(3, "blob", Buffer.from("evidence"));
  const tree = object(2, "tree", empty ? Buffer.alloc(0) : Buffer.concat([Buffer.from("100644 main.ts\0"), Buffer.from(blob.sha, "hex")]));
  const commit = object(1, "commit", Buffer.from(`tree ${tree.sha}\nauthor Test <test@example.test> 1 +0000\ncommitter Test <test@example.test> 1 +0000\n\nfixture\n`));
  const packet = (value: string) => (Buffer.byteLength(value) + 4).toString(16).padStart(4, "0") + value;
  const refs = packet("# service=git-upload-pack\n") + "0000" + packet(`${commit.sha} HEAD\0filter shallow ofs-delta no-progress symref=HEAD:refs/heads/main\n`) + packet(`${commit.sha} refs/heads/main\n`) + "0000";
  function response(url: string, body: BodyInit, mime: string) {
    const result = new Response(body, { headers: { "content-type": mime } });
    Object.defineProperty(result, "url", { value: url });
    return result;
  }
  return {
    sha: commit.sha,
    fetch(url: string, init?: RequestInit) {
      if (url.endsWith("/info/refs?service=git-upload-pack")) return response(url, refs, "application/x-git-upload-pack-advertisement");
      if (!url.endsWith("/git-upload-pack")) throw new Error(`Unexpected fixture request: ${url}`);
      const request = Buffer.from(init?.body as Uint8Array).toString();
      const objects = request.includes("filter blob:none") ? [commit, tree] : [blob];
      const header = Buffer.alloc(12);
      header.write("PACK");
      header.writeUInt32BE(2, 4);
      header.writeUInt32BE(objects.length, 8);
      const entries = objects.map(({ type, data }) => {
        let remaining = Math.floor(data.length / 16);
        const bytes = [(type << 4) | (data.length & 15) | (remaining ? 128 : 0)];
        while (remaining) {
          const byte = remaining & 127;
          remaining = Math.floor(remaining / 128);
          bytes.push(byte | (remaining ? 128 : 0));
        }
        return Buffer.concat([Buffer.from(bytes), deflateSync(data)]);
      });
      const pack = Buffer.concat([header, ...entries]);
      return response(url, Buffer.concat([Buffer.from(packet("NAK\n")), pack, createHash("sha1").update(pack).digest()]), "application/x-git-upload-pack-result");
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-10-18T09:00:00.000Z");
  resolver.mockReset().mockResolvedValue(frozen);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected external request"); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("batch admission", () => {
  it("admits canonically, defaults production to medium, and replays with zero writes or sends", async () => {
    const { create, database, messages, call } = setup();
    const value = input(2);
    const first = await create(value);
    expect(first.response.status).toBe(202);
    expect(first.payload.batch).toMatchObject({ effort: "medium", status: "queued", counts: { total: 2, queued: 2 }, freezeDispatches: 1, maxFreezeDispatches: 3 });
    expect(database.rows().every((row) => row.effort === "high" && row.scoring_effort === "medium")).toBe(true);
    const writes = database.changes();
    const equivalent = { ...value, effort: "medium", items: value.items.toReversed().map((item) => ({ ...item, repoUrl: item.repoUrl.toUpperCase() + ".git/", submittedAt: "2026-10-18T17:15:59+09:00" })) };
    expect((await create(equivalent)).response.status).toBe(202);
    expect((await create({ ...value, items: value.items.map((item) => ({ ...item, teamName: "changed" })) })).response.status).toBe(409);
    expect(database.changes()).toBe(writes);
    expect(messages).toHaveLength(1);
    expect((await call(`/api/batches/${value.id}`)).status).toBe(200);
    expect(database.changes()).toBe(writes);
  });

  it("rejects invalid efforts, unknown fields, URLs, duplicate normalized repositories, and invalid dates before writes", async () => {
    const { create, database, messages } = setup();
    const value = input();
    const before = database.changes();
    const bad = [
      { ...value, effort: "low" }, { ...value, effort: "high" }, { ...value, effort: null }, { ...value, extra: true },
      { ...value, id: "invalid" }, { ...value, mode: "other" }, { ...value, items: [] }, input(31),
      ...["http://github.com/a/b", "https:/github.com/a/b", "https://github.com/a/b?x=1", "https://example.com/a/b", "https://github.com/a/b/tree/main", "https://github.com/a//b"].map((repoUrl) => ({ ...value, items: [{ ...value.items[0], repoUrl }] })),
      ...["bad", "2026-02-30T00:00:00Z", "2026-10-17T24:00:00Z", null].map((submittedAt) => ({ ...value, items: [{ ...value.items[0], submittedAt }] })),
      { ...value, items: [{ ...value.items[0], extra: true }] },
      { ...value, items: [value.items[0], { ...value.items[0], repoUrl: value.items[0]!.repoUrl.toUpperCase() + ".git" }] }
    ];
    for (const body of bad) expect((await create(body as typeof value)).response.status).toBe(400);
    expect(database.changes()).toBe(before);
    expect(messages).toHaveLength(0);
  });

  it("enforces 128KB bodies", async () => {
    const { call, messages, database } = setup();
    const before = database.changes();
    expect((await call("/api/batches", "POST", { ...input(), extra: "x".repeat(131_072) })).status).toBe(413);
    expect(database.changes()).toBe(before);
    expect(messages).toHaveLength(0);
  });

  it("enforces the inclusive submission deadline without a lower date restriction and the judging start gate", async () => {
    const { create, call } = setup();
    for (const submittedAt of ["2026-10-17T08:15:00.000Z", "2026-01-01T00:00:00Z", "2026-10-18T08:14:59.999Z", "2026-10-18T08:15:12.000Z", "2026-10-18T08:15:55.000Z", SUBMISSION_DEADLINE_ISO]) {
      const value = input(1, "production", crypto.randomUUID());
      value.items[0]!.submittedAt = submittedAt;
      expect((await create(value)).response.status).toBe(202);
    }
    const late = input();
    late.items[0]!.submittedAt = "2026-10-18T08:15:59.001Z";
    expect((await create(late)).response.status).toBe(400);
    expect((await create({ ...input(), items: [{ teamName: "missing", repoUrl: "https://github.com/a/b" }] } as ReturnType<typeof input>)).response.status).toBe(400);
    vi.setSystemTime("2026-10-18T08:29:59.999Z");
    expect((await create(input(1, "production", "gate"))).response.status).toBe(403);
    expect((await call("/api/submissions", "POST", { mode: "production", repoUrl: "https://github.com/a/legacy", submittedAt: SUBMISSION_DEADLINE_ISO })).status).toBe(403);
    expect((await create(input(1, "validation"))).response.status).toBe(202);
    vi.setSystemTime(JUDGING_START_ISO);
    expect((await create(input(1, "production", "at-start"))).response.status).toBe(202);
  });

  it("accepts validation low by default and explicit medium or high without timestamps", async () => {
    const { create } = setup();
    for (const effort of [undefined, "medium", "high"] as const) {
      const value = { ...input(1, "validation", effort ?? "default"), ...(effort ? { effort } : {}), items: [{ repoUrl: `https://github.com/a/${effort ?? "default"}`, teamName: "validation" }] };
      const result = await create(value as ReturnType<typeof input>);
      expect(result.response.status).toBe(202);
      expect(result.payload.submissions[0]!.effort).toBe(effort ?? "low");
    }
  });

  it("uses exact-origin checks and allows CLI mutations without authentication", async () => {
    const { call, create, controls, env, database } = setup();
    const value = input();
    for (const origin of ["null", "https://evil.example", "https://judge.example/", "http://judge.example"]) expect((await call("/api/batches", "POST", value, origin)).status).toBe(403);
    expect((await call("/api/batches", "POST", value, "https://judge.example")).status).toBe(202);
    resolver.mockRejectedValueOnce(new Error("temporary transport failure"));
    await processFreezeMessage(controls()[0]!, env);
    expect((await call(`/api/batches/${value.id}/retry`, "POST", { confirm: true }, "https://evil.example")).status).toBe(403);
    expect((await call(`/api/batches/${value.id}/retry`, "POST", { confirm: false })).status).toBe(400);
    expect((await call(`/api/batches/${value.id}/retry`, "POST", { confirm: true, extra: true })).status).toBe(400);
    expect((await call(`/api/batches/${value.id}/retry`, "POST", { confirm: true })).status).toBe(202);
    expect(database.rows()[0]!.dispatch_count).toBe(0);
    expect((await create(input(1, "validation"))).response.status).toBe(202);
  });

  it("atomically enforces mode-specific caps under concurrent admission and duplicate repositories", async () => {
    const { create, database, messages } = setup();
    let admittedBatches = 0;
    for (const mode of ["production", "validation"] as const) {
      const limit = mode === "production" ? PRODUCTION_SUBMISSION_LIMIT : VALIDATION_SUBMISSION_LIMIT;
      for (let offset = 0; offset < limit - 10; offset += 30) {
        expect((await create(input(Math.min(30, limit - 10 - offset), mode, `first-${offset}`))).response.status).toBe(202);
        admittedBatches++;
      }
      const competing = await Promise.all([create(input(10, mode, "second")), create(input(10, mode, "third"))]);
      expect(competing.map((result) => result.response.status).sort()).toEqual([202, 429]);
      admittedBatches++;
      expect((await create(input(1, mode, "overflow"))).response.status).toBe(429);
      expect((await create(input(2, mode, "first-0"))).response.status).toBe(409);
    }
    expect(database.rows()).toHaveLength(PRODUCTION_SUBMISSION_LIMIT + VALIDATION_SUBMISSION_LIMIT);
    expect(messages).toHaveLength(admittedBatches);
    const fresh = setup();
    const duplicates = await Promise.all([fresh.create(input(2)), fresh.create(input(2))]);
    expect(duplicates.map((result) => result.response.status).sort()).toEqual([202, 409]);
    expect(fresh.database.rows()).toHaveLength(2);
  });

  it("accepts thirty new validation submissions after seventy-one existing results without using production capacity", async () => {
    const { create, database, call } = setup();
    expect((await create(input(30, "validation", "previous"))).response.status).toBe(202);
    expect((await create(input(30, "validation", "additional"))).response.status).toBe(202);
    expect((await create(input(11, "validation", "more"))).response.status).toBe(202);
    const next = await create(input(30, "validation", "manual-test"));
    expect(next.response.status).toBe(202);
    expect(next.payload.submissions).toHaveLength(30);
    expect(database.rows().filter((row) => row.mode === "validation")).toHaveLength(101);
    expect(database.rows().filter((row) => row.mode === "production")).toHaveLength(0);
    const account = database.db.prepare("SELECT mode, limit_micro_usd, spent_micro_usd, reserved_micro_usd FROM devday_judge_budget_accounts ORDER BY mode").all();
    expect(account).toEqual([
      { mode: "production", limit_micro_usd: 90_000_000, spent_micro_usd: 0, reserved_micro_usd: 0 },
      { mode: "validation", limit_micro_usd: 40_000_000, spent_micro_usd: 0, reserved_micro_usd: 0 }
    ]);
    const before = database.changes();
    const dashboard = await (await call("/api/dashboard")).json();
    expect(dashboard).toMatchObject({ event: { submissionLimits: { production: 40, validation: 140 } }, counts: { total: 0 }, ranking: [] });
    expect(database.changes()).toBe(before);
  });

  it("raises only the validation allowance while retaining charges, reservations and larger existing limits", () => {
    const { database } = setup();
    database.db.exec("UPDATE devday_judge_budget_accounts SET limit_micro_usd = 20000000, spent_micro_usd = 17000000, reserved_micro_usd = 500000 WHERE mode = 'validation'");
    const beforeProduction = database.db.prepare("SELECT * FROM devday_judge_budget_accounts WHERE mode = 'production'").get();
    const migration = readFileSync(new URL("../migrations/0010_validation_capacity.sql", import.meta.url), "utf8");
    database.db.exec(migration);
    expect(database.db.prepare("SELECT limit_micro_usd, spent_micro_usd, reserved_micro_usd FROM devday_judge_budget_accounts WHERE mode = 'validation'").get()).toEqual({limit_micro_usd: 40000000, spent_micro_usd: 17000000, reserved_micro_usd: 500000});
    expect(database.db.prepare("SELECT * FROM devday_judge_budget_accounts WHERE mode = 'production'").get()).toEqual(beforeProduction);
    const before = database.changes();
    database.db.exec(migration);
    expect(database.changes()).toBe(before);
  });

  it("rolls back the entire admission when a member insert fails", async () => {
    const { create, database, messages } = setup();
    database.db.exec("CREATE TRIGGER reject_member BEFORE INSERT ON devday_judge_submissions WHEN NEW.repo_name = 'repo-1' BEGIN SELECT RAISE(ABORT, 'injected constraint failure'); END");
    await expect(create(input(3))).rejects.toThrow("injected constraint failure");
    expect(database.rows()).toHaveLength(0);
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM devday_judge_batches").get()).toEqual({ n: 0 });
    expect(messages).toHaveLength(0);
  });

  it("returns concurrent identical admission as a replay with only one control dispatch", async () => {
    const { create, database, messages } = setup();
    const value = input(30);
    const results = await Promise.all([create(value), create(value)]);
    expect(results.map((result) => result.response.status)).toEqual([202, 202]);
    expect(database.rows()).toHaveLength(30);
    expect(messages).toHaveLength(1);
  });

  it("keeps a full-capacity dashboard read bounded and write-free", async () => {
    const { create, call, database, env } = setup();
    for (const mode of ["production", "validation"] as const) {
      const limit = mode === "production" ? PRODUCTION_SUBMISSION_LIMIT : VALIDATION_SUBMISSION_LIMIT;
      for (let i = 0; i < limit; i++) await create(input(1, mode, `batch-${i}`));
    }
    const total = PRODUCTION_SUBMISSION_LIMIT + VALIDATION_SUBMISSION_LIMIT;
    const before = database.changes();
    database.queries = 0;
    const response = await call("/api/dashboard");
    expect((await response.json() as { batches: unknown[] }).batches).toHaveLength(total);
    expect(database.queries).toBeLessThanOrEqual(5);
    database.queries = 0;
    expect(await listBatches(env)).toHaveLength(total);
    expect(database.queries).toBeLessThanOrEqual(2);
    expect(database.changes()).toBe(before);
  });
});

describe("submission demo metadata", () => {
  const demoUrl = "https://demo.example/show?view=public#start";
  const invalidUrls = [null, 42, {}, "javascript:alert(1)", "data:text/plain,demo", "file:///tmp/demo", "ftp://demo.example", "//demo.example", "https:/demo.example", "https:///demo.example", "https://", "https://[invalid]", "https://demo.example:99999", "https://user:pass@demo.example", "https://@demo.example", "https://demo.example\\path", "https://demo.example/\npath", "\thttps://demo.example", "https://demo.example/\u007f", "https://demo.example/" + "x".repeat(2048), "https://demo.example/" + "あ".repeat(230)];

  it("persists normalized batch and single URLs and exposes them through every public projection", async () => {
    const { call, database, messages } = setup();
    const value = input();
    const response = await call("/api/batches", "POST", { ...value, items: [{ ...value.items[0], demoUrl: "  HTTPS://DEMO.EXAMPLE:443/show?view=public#start  " }] });
    expect(response.status).toBe(202);
    const payload = await response.json() as Payload;
    const id = payload.submissions[0]!.id;
    expect(payload.submissions[0]!.demoUrl).toBe(demoUrl);
    expect(database.rows()[0]!.demo_url).toBe(demoUrl);
    const canonical = database.db.prepare("SELECT request_json FROM devday_judge_batches WHERE id = ?").get(value.id) as { request_json: string };
    expect(JSON.parse(canonical.request_json).items[0].demoUrl).toBe(demoUrl);
    const writes = database.changes();
    expect((await call("/api/batches", "POST", { ...value, items: [{ ...value.items[0], demoUrl }] })).status).toBe(202);
    expect((await call("/api/batches", "POST", { ...value, items: [{ ...value.items[0], demoUrl: demoUrl + "changed" }] })).status).toBe(409);
    expect(database.changes()).toBe(writes);
    expect(messages).toHaveLength(1);
    const single = await call("/api/submissions", "POST", { mode: "validation", repoUrl: "https://github.com/example/single", teamName: "Single", demoUrl: "HTTP://DEMO.EXAMPLE:80" });
    expect(single.status).toBe(202);
    expect(await single.json()).toMatchObject({ submission: { demoUrl: "http://demo.example/" } });
    expect(database.rows().find((row) => row.repo_name === "single")!.demo_url).toBe("http://demo.example/");
    const result = { summary: "saved", publicReason: "saved", repoAssessment: "scored", pinnedSha: frozen.pinnedSha, criteria: CRITERIA.map((item) => ({ ...item, score: 8, reason: "saved", evidencePaths: [] })), total: 32, attackScore: null };
    database.db.prepare("UPDATE devday_judge_submissions SET result_json = ?, evidence_snapshot_json = ?, callback_token = ? WHERE id = ?").run(JSON.stringify(result), "private-snapshot", "private-token", id);
    const beforeReads = database.changes();
    const prepare = vi.spyOn(database, "prepare");
    for (const path of [`/api/submissions/${id}`, `/api/results/${id}`]) expect(await (await call(path)).json()).toMatchObject({ id, demoUrl });
    expect(await (await call(`/api/batches/${value.id}`)).json()).toMatchObject({ submissions: [{ id, demoUrl }] });
    expect(await (await call("/api/ranking")).json()).toMatchObject({ items: [{ submissionId: id, demoUrl }] });
    expect(await (await call("/api/dashboard")).json()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id, demoUrl })]), ranking: [{ submissionId: id, demoUrl }] });
    expect(await (await call("/api/recent")).json()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id, demoUrl })]) });
    for (const [sql] of prepare.mock.calls.filter(([sql]) => sql.includes("FROM devday_judge_submissions"))) {
      expect(sql).not.toContain("SELECT *");
      expect(sql).not.toContain("evidence_snapshot_json");
      expect(sql).not.toContain("callback_token");
    }
    expect(database.changes()).toBe(beforeReads);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replays the exact legacy canonical format with omitted or blank demo and no writes or sends", async () => {
    const { create, call, database, messages } = setup();
    const value = input();
    const { payload } = await create(value);
    const legacy = JSON.stringify({ mode: "production", effort: "medium", items: [{ teamName: "Team 0", repo: { owner: "example", repo: "repo-0", normalized: "example/repo-0", canonicalUrl: "https://github.com/example/repo-0" }, submittedAt: SUBMISSION_DEADLINE_ISO }] });
    expect(database.db.prepare("SELECT request_json FROM devday_judge_batches").get()).toEqual({ request_json: legacy });
    expect(payload.submissions[0]!.demoUrl).toBeNull();
    const writes = database.changes();
    for (const demo of [undefined, "", "   "]) expect((await call("/api/batches", "POST", { ...value, items: [{ ...value.items[0], ...(demo === undefined ? {} : { demoUrl: demo }) }] })).status).toBe(202);
    expect(database.changes()).toBe(writes);
    expect(messages).toHaveLength(1);
  });

  it("rejects invalid URLs before batch or single admission writes or sends", async () => {
    const { call, database, messages } = setup();
    const value = input();
    const writes = database.changes();
    for (const badUrl of invalidUrls) {
      expect((await call("/api/batches", "POST", { ...value, items: [{ ...value.items[0], demoUrl: badUrl }] })).status, String(badUrl)).toBe(400);
      expect((await call("/api/submissions", "POST", { mode: "validation", ...value.items[0], demoUrl: badUrl })).status, String(badUrl)).toBe(400);
    }
    expect(database.changes()).toBe(writes);
    expect(database.rows()).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });

  it("accepts maximum URL and Japanese name lengths with bounded single and patch bodies", async () => {
    const { call, database } = setup();
    const base = "https://demo.example/";
    const maximum = base + "x".repeat(2048 - base.length);
    const teamName = "あ".repeat(100);
    const response = await call("/api/submissions", "POST", { mode: "validation", repoUrl: "https://github.com/example/maximum", teamName, demoUrl: maximum });
    expect(response.status).toBe(202);
    const { submission } = await response.json() as { submission: PublicSubmissionRecord };
    expect(submission).toMatchObject({ teamName, demoUrl: maximum });
    const path = `/api/submissions/${submission.id}`;
    expect((await call(path, "PATCH", { teamName: "い".repeat(100), demoUrl: maximum })).status).toBe(200);
    const writes = database.changes();
    expect((await call(path, "PATCH", { teamName, demoUrl: base + "x".repeat(2049 - base.length) })).status).toBe(400);
    expect((await call(path, "PATCH", { teamName: "あ".repeat(101) })).status).toBe(400);
    expect((await call(path, "PATCH", { teamName, demoUrl: "x".repeat(16_384) })).status).toBe(413);
    expect((await call("/api/submissions", "POST", { mode: "validation", repoUrl: "https://github.com/example/large", teamName, demoUrl: "x".repeat(16_384) })).status).toBe(413);
    expect(database.changes()).toBe(writes);
  });

  it("sets, preserves and repeatedly clears metadata while paused without touching lifecycle or budget", async () => {
    const { create, call, database, env, messages } = setup();
    const { payload } = await create();
    const id = payload.submissions[0]!.id;
    const path = `/api/submissions/${id}`;
    database.db.prepare("UPDATE devday_judge_submissions SET status = 'processing', callback_token = 'lease', attempts = 1, dispatch_count = 1, pinned_sha = ?, started_at = 'started', frozen_at = 'frozen', scored_at = 'scored', explanation_status = 'processing', explanation_started_at = 'explaining', evidence_snapshot_json = 'private-snapshot', decisions_result_json = 'private-decisions', result_json = '{\"total\":32}', outcome_json = 'private-outcome' WHERE id = ?").run(frozen.pinnedSha, id);
    const original = database.rows()[0]!;
    const budgets = database.db.prepare("SELECT * FROM devday_judge_budget_accounts").all();
    const batches = database.db.prepare("SELECT * FROM devday_judge_batches").all();
    const reservations = database.db.prepare("SELECT * FROM devday_judge_budget_reservations").all();
    const explanationSend = vi.fn();
    env.EXPLANATION_QUEUE = { send: explanationSend } as unknown as Queue<ExplanationQueueMessage>;
    env.JUDGING_ENABLED = "false";
    env.SUBMISSIONS_OPEN = "false";
    vi.setSystemTime("2026-10-19T09:00:00Z");
    const writes = database.changes();
    const prepare = vi.spyOn(database, "prepare");
    const response = await call(path, "PATCH", { teamName: " New name ", demoUrl: " HTTPS://DEMO.EXAMPLE:443/show?view=public#start " });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ submission: { id, teamName: "New name", demoUrl, updatedAt: original.updated_at, startedAt: "started" } });
    expect(database.changes()).toBe(writes + 1);
    expect(database.rows()[0]).toEqual({ ...original, team_name: "New name", demo_url: demoUrl });
    const noChange = database.changes();
    expect((await call(path, "PATCH", { teamName: " New name ", demoUrl: " HTTPS://DEMO.EXAMPLE:443/show?view=public#start " })).status).toBe(200);
    expect((await call(path, "PATCH", { teamName: "New name" })).status).toBe(200);
    expect(database.changes()).toBe(noChange);
    expect((await call(path, "PATCH", { teamName: "Renamed" })).status).toBe(200);
    expect(database.rows()[0]).toEqual({ ...original, team_name: "Renamed", demo_url: demoUrl });
    for (const clear of [null, "", "   "]) {
      expect((await call(path, "PATCH", { teamName: "Renamed", demoUrl: clear })).status).toBe(200);
      const clearedWrites = database.changes();
      expect((await call(path, "PATCH", { teamName: "Renamed", demoUrl: clear })).status).toBe(200);
      expect(database.changes()).toBe(clearedWrites);
    }
    expect(database.changes()).toBe(writes + 3);
    expect(database.rows()[0]).toEqual({ ...original, team_name: "Renamed", demo_url: null });
    expect(database.db.prepare("SELECT * FROM devday_judge_budget_accounts").all()).toEqual(budgets);
    expect(database.db.prepare("SELECT * FROM devday_judge_batches").all()).toEqual(batches);
    expect(database.db.prepare("SELECT * FROM devday_judge_budget_reservations").all()).toEqual(reservations);
    for (const [sql] of prepare.mock.calls) {
      expect(sql).not.toContain("SELECT *");
      expect(sql).not.toContain("RETURNING *");
      expect(sql).not.toContain("evidence_snapshot_json");
      expect(sql).not.toContain("callback_token");
    }
    expect(messages).toHaveLength(1);
    expect(explanationSend).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects cross-origin, invalid or unknown patch fields without changing any state", async () => {
    const { create, call, database, messages } = setup();
    const { payload } = await create();
    const path = `/api/submissions/${payload.submissions[0]!.id}`;
    const original = database.rows();
    const writes = database.changes();
    for (const origin of ["null", "https://evil.example", "http://judge.example", "https://judge.example/"]) expect((await call(path, "PATCH", { teamName: "changed", demoUrl }, origin)).status).toBe(403);
    const badBodies = [null, [], {}, { demoUrl }, { teamName: null }, { teamName: 5 }, { teamName: " " }, { teamName: "a".repeat(101) }, ...invalidUrls.filter((value) => value !== null).map((demoUrl) => ({ teamName: "changed", demoUrl })), ...["repoUrl", "repo", "mode", "effort", "pinnedSha", "result", "status", "attempts", "dispatches", "callbackToken", "updatedAt", "startedAt", "budget", "job"].map((key) => ({ teamName: "changed", demoUrl, [key]: "forbidden" }))];
    for (const body of badBodies) expect((await call(path, "PATCH", body)).status, JSON.stringify(body)).toBe(400);
    expect((await call("/api/submissions/missing", "PATCH", { teamName: "missing", demoUrl })).status).toBe(404);
    expect(database.rows()).toEqual(original);
    expect(database.changes()).toBe(writes);
    expect(messages).toHaveLength(1);
    expect((await call(path, "PATCH", { teamName: "Allowed", demoUrl }, "https://judge.example")).status).toBe(200);
  });

  it("adds only nullable demo metadata while preserving historical submissions, batches and reservations", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const base = new URL("../migrations/", import.meta.url);
      for (const file of readdirSync(base).filter((name) => /^000[1-6]_.+\.sql$/.test(name)).sort()) database.exec(readFileSync(new URL(file, base), "utf8"));
      database.exec("INSERT INTO devday_judge_submissions (id,event_id,repo_url,repo_normalized,repo_owner,repo_name,team_name,mode,effort,status,created_at,updated_at,completed_at,result_json,callback_token) VALUES ('history','devday-20261018','https://github.com/a/b','a/b','a','b','old','production','high','completed','before','before','completed','{\"legacy\":true}','original-token')");
      database.exec("INSERT INTO devday_judge_budget_reservations (id,submission_id,callback_token,mode,kind,model,max_input_tokens,max_output_tokens,reserved_micro_usd,status,created_at) VALUES ('reservation','history','original-token','production','responses','fixture-model',100,100,456,'reserved','before')");
      database.exec("UPDATE devday_judge_budget_accounts SET spent_micro_usd = 123, reserved_micro_usd = 456 WHERE mode = 'production'");
      const previous = database.prepare("SELECT * FROM devday_judge_submissions").get()!;
      const tables = ["devday_judge_budget_accounts", "devday_judge_budget_reservations", "devday_judge_batches"];
      const before = tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all());
      database.exec(readFileSync(new URL("0007_submission_demo.sql", base), "utf8"));
      expect(database.prepare("SELECT * FROM devday_judge_submissions").get()).toEqual({ ...previous, demo_url: null });
      expect(tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { database.close(); }
  });
});

describe("freeze control and bounded recovery", () => {
  it("requires the complete all-repository barrier for one-time recovery and retains batch history", async () => {
    const { create, call, database, controls, env, messages } = setup();
    const created = await create(input(2));
    await processFreezeMessage(controls()[0]!, env);
    const [first, second] = database.rows();
    await claimQueueMessage({ eventId: String(first!.event_id), submissionId: String(first!.id), mode: "production", attempt: 0, dispatch: 1 }, env);
    database.db.prepare("UPDATE devday_judge_submissions SET updated_at = '2026-10-18T08:55:00.000Z' WHERE id = ?").run(first!.id);
    const path = `/api/submissions/${first!.id}/recover`;
    const batch = database.db.prepare("SELECT * FROM devday_judge_batches WHERE id = ?").get(created.payload.batch.id);
    for (const mutation of ["status = 'freezing'", "frozen_at = NULL"]) {
      database.db.prepare(`UPDATE devday_judge_batches SET ${mutation} WHERE id = ?`).run(created.payload.batch.id);
      const before = database.changes();
      expect((await call(path, "POST", { confirm: true })).status).toBe(409);
      expect(database.changes()).toBe(before);
      database.db.prepare("UPDATE devday_judge_batches SET status = 'scoring', frozen_at = ? WHERE id = ?").run(batch!.frozen_at, created.payload.batch.id);
    }
    database.db.prepare("UPDATE devday_judge_submissions SET frozen_resolution_json = NULL WHERE id = ?").run(second!.id);
    const before = database.changes();
    expect((await call(path, "POST", { confirm: true })).status).toBe(409);
    expect(database.changes()).toBe(before);
    database.db.prepare("UPDATE devday_judge_submissions SET frozen_resolution_json = ? WHERE id = ?").run(second!.frozen_resolution_json, second!.id);
    expect((await call(path, "POST", { confirm: true })).status).toBe(202);
    expect(database.db.prepare("SELECT * FROM devday_judge_batches WHERE id = ?").get(created.payload.batch.id)).toEqual(batch);
    expect(messages.at(-1)).toMatchObject({ type: "resume_submission", submissionId: first!.id, attempt: 1, dispatch: 1 });
  });

  it("persists all thirty snapshots and consumes dispatches before the first scoring send within fifty queries", async () => {
    const { create, controls, scoring, env, onSend, database } = setup();
    await create(input(30));
    onSend((message) => {
      if ("type" in message) return;
      expect(resolver).toHaveBeenCalledTimes(30);
      expect(database.rows().every((row) => row.pinned_sha === frozen.pinnedSha && row.frozen_resolution_json && row.dispatch_count === 1)).toBe(true);
      expect(database.db.prepare("SELECT status FROM devday_judge_batches").get()).toEqual({ status: "scoring" });
    });
    database.queries = 0;
    await processFreezeMessage(controls()[0]!, env);
    expect(database.queries).toBeLessThanOrEqual(50);
    expect(scoring()).toHaveLength(30);
    const before = database.changes();
    await processFreezeMessage(controls()[0]!, env);
    expect(database.changes()).toBe(before);
    expect(scoring()).toHaveLength(30);
    expect(resolver).toHaveBeenCalledTimes(30);
  });

  it("claims once on concurrent duplicate deliveries and runs control messages through the cloud consumer", async () => {
    const { create, controls, scoring, env, database } = setup();
    await create(input(3));
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = { messages: [{ body: controls()[0], ack, retry }] } as unknown as MessageBatch<JudgeQueueMessage>;
    await Promise.all([worker.queue(batch, env, {} as ExecutionContext), worker.queue(batch, env, {} as ExecutionContext)]);
    expect(scoring()).toHaveLength(3);
    expect(resolver).toHaveBeenCalledTimes(3);
    const before = database.changes();
    await worker.queue(batch, env, {} as ExecutionContext);
    expect(database.changes()).toBe(before);
    expect(ack).toHaveBeenCalledTimes(3);
    expect(retry).not.toHaveBeenCalled();
  });

  it("retains partial snapshots on transient freeze failures and requires a bounded generation-specific retry", async () => {
    const { create, controls, scoring, call, env, database } = setup();
    const value = input(8);
    resolver.mockImplementation(async (repo) => { if (repo.repo === "repo-1") throw new Error("transport"); return frozen; });
    const { payload } = await create(value);
    await processFreezeMessage(controls()[0]!, env);
    expect(scoring()).toHaveLength(0);
    const saved = database.rows().filter((row) => row.frozen_at);
    expect(saved.length).toBeGreaterThan(0);
    expect(database.rows().every((row) => row.status === "failed" && row.dispatch_count === 0)).toBe(true);
    const incomplete = await call(`/api/submissions/${payload.submissions[0]!.id}/retry`, "POST", { confirm: true });
    expect(incomplete.status).toBe(409);
    expect(await incomplete.json()).toMatchObject({ code: "freeze_incomplete", batchId: value.id, retryUrl: `/api/batches/${value.id}/retry`, retryBody: { confirm: true } });
    const before = database.changes();
    expect((await create(value)).response.status).toBe(202);
    await processFreezeMessage(controls()[0]!, env);
    expect(database.changes()).toBe(before);
    expect((await call(`/api/batches/${value.id}/retry`, "POST", { confirm: true })).status).toBe(202);
    const generation = database.changes();
    await processFreezeMessage(controls()[0]!, env);
    expect(database.changes()).toBe(generation);
    resolver.mockClear().mockResolvedValue({ ...frozen, pinnedSha: "b".repeat(40) });
    await processFreezeMessage(controls()[1]!, env);
    expect(resolver).toHaveBeenCalledTimes(8 - saved.length);
    for (const row of saved) expect(database.rows().find((item) => item.id === row.id)!.pinned_sha).toBe(frozen.pinnedSha);
    expect(scoring()).toHaveLength(8);
    expect((await call(`/api/batches/${value.id}/retry`, "POST", { confirm: true })).status).toBe(409);
  });

  it("consumes each initial ambiguous send and allows only three explicit freeze dispatches", async () => {
    const { create, controls, call, env, database, onSend } = setup();
    onSend(() => { throw new Error("ambiguous send"); });
    const value = input();
    expect((await create(value)).response.status).toBe(503);
    const writes = database.changes();
    await processFreezeMessage(controls()[0]!, env);
    expect(database.changes()).toBe(writes);
    const path = `/api/batches/${value.id}/retry`;
    const concurrent = await Promise.all([call(path, "POST", { confirm: true }), call(path, "POST", { confirm: true })]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([409, 503]);
    expect((await call(path, "POST", { confirm: true })).status).toBe(503);
    const before = database.changes();
    expect((await call(path, "POST", { confirm: true })).status).toBe(409);
    for (const message of controls()) await processFreezeMessage(message, env);
    expect(database.changes()).toBe(before);
    expect(controls().map((message) => message.dispatch)).toEqual([1, 2, 3]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(["queued", "freezing"])("recovers stale %s only after thirty minutes and fences the old owner", async (status) => {
    const { create, controls, call, env, database, scoring } = setup();
    const value = input();
    await create(value);
    if (status === "freezing") database.db.prepare("UPDATE devday_judge_batches SET status = 'freezing', started_at = ?").run(new Date().toISOString());
    const path = `/api/batches/${value.id}/retry`;
    expect((await call(path, "POST", { confirm: true })).status).toBe(409);
    vi.setSystemTime("2026-10-18T09:30:00.001Z");
    expect((await call(path, "POST", { confirm: true })).status).toBe(202);
    const before = database.changes();
    await processFreezeMessage(controls()[0]!, env);
    expect(database.changes()).toBe(before);
    await processFreezeMessage(controls()[1]!, env);
    expect(scoring()).toHaveLength(1);
  });

  it("fences a resolver still running when a stale freeze generation is explicitly recovered", async () => {
    const { create, controls, call, env, database, scoring } = setup();
    const value = input();
    await create(value);
    let release!: (resolution: RepoResolution) => void;
    let started!: () => void;
    const resolving = new Promise<void>((resolve) => { started = resolve; });
    resolver.mockImplementationOnce(() => { started(); return new Promise((resolve) => { release = resolve; }); });
    const old = processFreezeMessage(controls()[0]!, env);
    await resolving;
    vi.setSystemTime("2026-10-18T09:31:00.000Z");
    expect((await call(`/api/batches/${value.id}/retry`, "POST", { confirm: true })).status).toBe(202);
    await processFreezeMessage(controls()[1]!, env);
    const before = database.changes();
    release({ ...frozen, pinnedSha: "b".repeat(40) });
    await old;
    expect(database.changes()).toBe(before);
    expect(database.rows()[0]!.pinned_sha).toBe(frozen.pinnedSha);
    expect(scoring()).toHaveLength(1);
  });

  it("groups thirty ambiguous scoring-send failures without stranded rows or excess D1 queries", async () => {
    const { create, controls, scoring, call, env, database, onSend } = setup();
    const { payload } = await create(input(30));
    onSend((message) => { if (!("type" in message)) throw new Error("send failure"); });
    database.queries = 0;
    await processFreezeMessage(controls()[0]!, env);
    expect(database.queries).toBeLessThanOrEqual(50);
    expect(scoring()).toHaveLength(30);
    expect(database.rows().every((row) => row.status === "failed" && row.dispatch_count === 1 && row.frozen_at)).toBe(true);
    const writes = database.changes();
    for (const message of scoring()) await processScoringMessage(message, env);
    expect(database.changes()).toBe(writes);
    expect((await call(`/api/batches/${payload.batch.id}`)).status).toBe(200);
    onSend(() => undefined);
    const row = payload.submissions[0]!;
    expect((await call(`/api/submissions/${row.id}/retry`, "POST", { confirm: true })).status).toBe(202);
    expect(database.rows().find((item) => item.id === row.id)).toMatchObject({ pinned_sha: frozen.pinnedSha, dispatch_count: 2 });
    expect(resolver).toHaveBeenCalledTimes(30);
  });

  it("keeps accepted jobs and makes only the partial send failures manually retryable", async () => {
    const { create, controls, scoring, call, env, database, onSend } = setup();
    const { payload } = await create(input(6));
    let sends = 0;
    onSend((message) => { if (!("type" in message) && ++sends % 2 === 0) throw new Error("partial send"); });
    await processFreezeMessage(controls()[0]!, env);
    expect(database.rows().filter((row) => row.status === "failed")).toHaveLength(3);
    expect(database.rows().filter((row) => row.status === "queued" && row.dispatch_count === 1)).toHaveLength(3);
    expect(database.rows().some((row) => row.status === "queued" && row.dispatch_count === 0)).toBe(false);
    expect(database.rows().filter((row) => row.status === "failed").every((row) => String(row.failure_message).includes("may already be running"))).toBe(true);
    const state = await (await call(`/api/batches/${payload.batch.id}`)).json() as Payload;
    expect(state.batch).toMatchObject({ status: "scoring", counts: { queued: 3, failed: 3 } });
    const before = database.changes();
    await processFreezeMessage(controls()[0]!, env);
    expect(database.changes()).toBe(before);
    expect(scoring()).toHaveLength(6);
  });

  it.each(["JUDGING_ENABLED", "SUBMISSIONS_OPEN"] as const)("makes %s stop failures visible and blocks new work, retries and reservations", async (flag) => {
    const { create, controls, scoring, call, env, database } = setup();
    const { payload } = await create(input());
    env[flag] = "false";
    await processFreezeMessage(controls()[0]!, env);
    expect(database.rows()[0]!.status).toBe("failed");
    expect((await (await call(`/api/batches/${payload.batch.id}`)).json() as Payload).batch.status).toBe("failed");
    expect(scoring()).toHaveLength(0);
    expect(resolver).not.toHaveBeenCalled();
    expect((await call(`/api/batches/${payload.batch.id}/retry`, "POST", { confirm: true })).status).toBe(410);
    expect((await call(`/api/submissions/${payload.submissions[0]!.id}/retry`, "POST", { confirm: true })).status).toBe(410);
    expect([403, 410]).toContain((await create(input(1, "validation"))).response.status);
    expect((await reserve(new Request("https://internal.example", { method: "POST", body: "{}" }), env)).status).toBe(410);
  });

  it.each(["JUDGING_ENABLED", "SUBMISSIONS_OPEN"] as const)("stops unsent scoring work when %s closes during dispatch and visibly fails an accepted queued job", async (flag) => {
    const { create, controls, scoring, call, env, database, onSend } = setup();
    const { payload } = await create(input(4));
    onSend((message) => { if (!("type" in message)) env[flag] = "false"; });
    await processFreezeMessage(controls()[0]!, env);
    expect(scoring()).toHaveLength(1);
    expect(database.rows().filter((row) => row.status === "failed")).toHaveLength(3);
    expect(database.rows().every((row) => row.dispatch_count === 1 && row.frozen_at)).toBe(true);
    await processScoringMessage(scoring()[0], env);
    expect(database.rows().every((row) => row.status === "failed" && row.attempts === 0)).toBe(true);
    expect((await (await call(`/api/batches/${payload.batch.id}`)).json() as Payload).batch.status).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies the origin policy to public per-submission retry without resetting valid snapshots", async () => {
    const { create, controls, call, env, database, onSend } = setup();
    const { payload } = await create(input());
    onSend((message) => { if (!("type" in message)) throw new Error("scoring delivery failed"); });
    await processFreezeMessage(controls()[0]!, env);
    const path = `/api/submissions/${payload.submissions[0]!.id}/retry`;
    const before = database.changes();
    expect((await call(path, "POST", { confirm: true }, "null")).status).toBe(403);
    expect((await call(path, "POST", { confirm: true }, "https://other.example")).status).toBe(403);
    expect(database.changes()).toBe(before);
    onSend(() => undefined);
    expect((await call(path, "POST", { confirm: true }, "https://judge.example")).status).toBe(202);
    expect(database.rows()[0]!.pinned_sha).toBe(frozen.pinnedSha);
  });

  it.each(["empty_repository", "missing_or_private", "no_default_branch"] as const)("completes frozen %s as zero without a key or any fetch", async (assessment) => {
    const { create, controls, scoring, env, database, call } = setup();
    resolver.mockResolvedValue({ assessment, pinnedSha: null, defaultBranch: null, summary: "No repository evidence" });
    const { payload } = await create(input());
    await processFreezeMessage(controls()[0]!, env);
    await processScoringMessage(scoring()[0], env);
    const result = await (await call(`/api/batches/${payload.batch.id}`)).json() as Payload;
    expect(result.batch.status).toBe("completed");
    expect(result.submissions[0]).toMatchObject({ status: "completed", result: { total: 0, repoAssessment: assessment, pinnedSha: null } });
    expect(fetch).not.toHaveBeenCalled();
    expect(database.db.prepare("SELECT SUM(spent_micro_usd) AS spent, SUM(reserved_micro_usd) AS reserved FROM devday_judge_budget_accounts").get()).toEqual({ spent: 0, reserved: 0 });
  });
});

describe("backend compatibility", () => {
  it("adds recovery audit columns without changing historical attempts, dispatches, fees, reservations or batches", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const base = new URL("../migrations/", import.meta.url);
      for (const file of readdirSync(base).filter((name) => /^000[1-8]_.+\.sql$/.test(name)).sort()) database.exec(readFileSync(new URL(file, base), "utf8"));
      database.exec("INSERT INTO devday_judge_batches (id, event_id, mode, effort, request_json, admission_key, status, created_at, frozen_at, freeze_dispatches) VALUES ('batch', 'devday-20261018', 'production', 'medium', '{}', 'key', 'scoring', 'before', 'frozen', 3)");
      database.exec("INSERT INTO devday_judge_submissions (id, event_id, repo_url, repo_normalized, repo_owner, repo_name, team_name, mode, effort, status, attempts, dispatch_count, created_at, updated_at, started_at, callback_token, pinned_sha, batch_id, frozen_at, frozen_resolution_json) VALUES ('history', 'devday-20261018', 'https://github.com/a/b', 'a/b', 'a', 'b', 'old', 'production', 'high', 'processing', 3, 3, 'before', 'updated', 'started', 'old-token', 'fixed-sha', 'batch', 'frozen', '{}')");
      database.exec("INSERT INTO devday_judge_budget_reservations (id, submission_id, callback_token, mode, kind, model, max_input_tokens, max_output_tokens, reserved_micro_usd, actual_micro_usd, status, created_at) VALUES ('reservation', 'history', 'old-token', 'production', 'decisions', 'gpt-6-luna', 1, 0, 9, 0, 'settled', 'before')");
      database.exec("UPDATE devday_judge_budget_accounts SET spent_micro_usd = 123, reserved_micro_usd = 456 WHERE mode = 'production'");
      const previous = database.prepare("SELECT * FROM devday_judge_submissions").get()!;
      const tables = ["devday_judge_budget_accounts", "devday_judge_budget_reservations", "devday_judge_batches", "devday_judge_evidence_manifests", "devday_judge_evidence_chunks"];
      const before = tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all());
      database.exec(readFileSync(new URL("0009_prepaid_recovery.sql", base), "utf8"));
      expect(database.prepare("SELECT * FROM devday_judge_submissions").get()).toEqual({ ...previous, recovery_dispatch_count: 0, recovery_requested_at: null, recovery_previous_started_at: null, recovery_previous_updated_at: null });
      expect(tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
      for (const count of [-1, 2]) expect(() => database.prepare("UPDATE devday_judge_submissions SET recovery_dispatch_count = ?").run(count)).toThrow();
      expect(() => database.exec("UPDATE devday_judge_submissions SET recovery_dispatch_count = NULL")).toThrow();
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { database.close(); }
  });

  it("runs real Decisions then reasons on a persisted snapshot with no GitHub reads during explanation", async () => {
    const { create, controls, scoring, call, env, database } = setup();
    const prepare = vi.spyOn(database, "prepare");
    const sourceWrites = () => prepare.mock.calls.filter(([sql]) => /^(?:INSERT INTO|UPDATE) devday_judge_evidence_/.test(sql)).length;
    let fixedSourceWrites = 0;
    const demoUrl = "https://demo.example/never-fetch-or-score";
    const explanations: ExplanationQueueMessage[] = [];
    env.EXPLANATION_QUEUE = { send: async (message: ExplanationQueueMessage) => { explanations.push(message); } } as Queue<ExplanationQueueMessage>;
    env.OPENAI_API_KEY_20261018_HACKATHON = "local-fixture-key";
    const source = sourceFixture();
    resolver.mockResolvedValue({ ...frozen, pinnedSha: source.sha });
    let explanationStage = false;
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).not.toContain("demo.example");
      expect(String(init?.body)).not.toContain(demoUrl);
      requests.push(url);
      if (url === "https://api.openai.com/v1/models") return Response.json({ data: [{ id: explanationStage ? "gpt-6.1-sol" : "gpt-6-luna" }] });
      if (url === "https://api.openai.com/v1/responses/input_tokens") return Response.json({ input_tokens: 1000 });
      if (explanationStage) {
        expect(url).toBe("https://api.openai.com/v1/responses");
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "medium" } });
        const evidence = JSON.parse(body.input[1].content);
        expect(evidence.snapshot).toEqual(await loadEvidenceSnapshot(database.rows()[0] as unknown as SubmissionRow, env));
        return Response.json({ model: "gpt-6.1-sol", status: "completed", usage: { input_tokens: 200, output_tokens: 50 },
          output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ ...evidence.fixedScores, summary: "保存した実装を確認しました", publicReason: "固定済みの評価を説明しました", reviewRequired: false,
            criteria: evidence.fixedScores.criteria.map((criterion: Record<string, unknown>) => ({ ...criterion, reason: "main.tsの実装根拠を確認しました", evidencePaths: ["main.ts"] })) }) }] }] });
      }
      if (url.startsWith("https://github.com/")) return source.fetch(url, init);
      expect(url).toBe("https://api.openai.com/v1/decisions");
      expect(JSON.parse(String(init?.body)).model).toBe("gpt-6-luna");
      expect(database.db.prepare("SELECT complete FROM devday_judge_evidence_manifests").get()).toEqual({ complete: 1 });
      expect(database.rows()[0]!.evidence_snapshot_json).toBeNull();
      fixedSourceWrites = sourceWrites();
      expect(fixedSourceWrites).toBeGreaterThan(0);
      return Response.json({ model: "gpt-6-luna", usage: { input_tokens: 100, output_tokens: 0 }, answers: [
        { type: "predicate", name: "prompt_injection", probability: 0.2 },
        ...DECISION_CONDITIONS.map(({ name, level }) => ({ type: "predicate", name, probability: level <= 8 ? 0.95 : 0.05 }))
      ] });
    }));
    const value = input();
    const response = await call("/api/batches", "POST", { ...value, items: value.items.map((item) => ({ ...item, demoUrl })) });
    expect(response.status).toBe(202);
    const payload = await response.json() as Payload;
    await processFreezeMessage(controls()[0]!, env);
    expect(JSON.stringify(resolver.mock.calls)).not.toContain(demoUrl);
    expect(JSON.stringify(controls())).not.toContain(demoUrl);
    expect(JSON.stringify(scoring())).not.toContain(demoUrl);
    await processScoringMessage(scoring()[0], env);
    expect(await (await call("/api/dashboard")).json()).toMatchObject({ scoredCount: 1, counts: { processing: 1 }, ranking: [{ total: 32 }] });
    expect(database.rows()[0]).toMatchObject({ explanation_status: "pending", status: "processing" });
    const snapshot = await loadEvidenceSnapshot(database.rows()[0] as unknown as SubmissionRow, env);
    expect(database.rows()[0]!.evidence_snapshot_json).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain(demoUrl);
    expect(JSON.stringify(explanations)).not.toContain(demoUrl);
    const firstRequests = requests.length;
    explanationStage = true;
    await processExplanationMessage(explanations[0], env);
    expect(requests.slice(firstRequests)).toEqual(["https://api.openai.com/v1/models", "https://api.openai.com/v1/responses/input_tokens", "https://api.openai.com/v1/responses"]);
    expect(database.rows()[0]).toMatchObject({ status: "completed", explanation_status: "completed", evidence_snapshot_json: null });
    expect(await loadEvidenceSnapshot(database.rows()[0] as unknown as SubmissionRow, env)).toEqual(snapshot);
    const result = await (await call(`/api/results/${payload.submissions[0]!.id}`)).json() as PublicSubmissionRecord;
    expect(result.demoUrl).toBe(demoUrl);
    expect(result.result).toMatchObject({ total: 32, pinnedSha: source.sha, eligibility: "eligible", attackProbability: 0.2, usage: { model: "gpt-6-luna", decisionsModel: "gpt-6-luna", explanationModel: "gpt-6.1-sol", fullSource: true, sourceFiles: 1, sourceBytes: 8 } });
    expect(result.result!.usage!.sourceHash).toBe(database.db.prepare("SELECT sha256 FROM devday_judge_evidence_manifests").get()!.sha256);
    expect(database.db.prepare("SELECT kind, status FROM devday_judge_budget_reservations ORDER BY kind").all()).toEqual([{ kind: "decisions", status: "settled" }, { kind: "responses", status: "settled" }]);
    expect(database.db.prepare("SELECT spent_micro_usd, reserved_micro_usd FROM devday_judge_budget_accounts WHERE mode = 'production'").get()).toMatchObject({ spent_micro_usd: 910, reserved_micro_usd: 0 });
    expect(sourceWrites()).toBe(fixedSourceWrites);
  });

  it("accepts an empty Git tree at the frozen scored SHA in direct save and callback without allowing any other authority change", async () => {
    const { create, controls, scoring, call, env, database } = setup();
    env.OPENAI_API_KEY_20261018_HACKATHON = "local-fixture-key";
    const source = sourceFixture(true);
    resolver.mockResolvedValue({ ...frozen, pinnedSha: source.sha });
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "gpt-6-luna" }] });
      return source.fetch(url, init);
    });
    vi.stubGlobal("fetch", fetcher);
    const { payload } = await create(input(2));
    await processFreezeMessage(controls()[0]!, env);
    await processScoringMessage(scoring()[0], env);
    expect(database.rows()[0]).toMatchObject({ pinned_sha: source.sha, status: "completed", explanation_status: "completed", explanation_dispatches: 0 });
    expect(JSON.parse(String(database.rows()[0]!.result_json))).toMatchObject({ pinnedSha: source.sha, repoAssessment: "empty_repository", total: 0 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const job = (await claimQueueMessage(scoring()[1]!, env))!;
    const zero = { summary: "empty", publicReason: "empty", repoAssessment: "empty_repository", pinnedSha: source.sha,
      criteria: CRITERIA.map((item) => ({ key: item.key, label: item.label, score: 0, reason: "empty", evidencePaths: [] })), total: 0, attackScore: null };
    const finalize = (result: unknown) => callback(new Request("https://internal.example", { method: "POST", body: JSON.stringify({ submissionId: job.submissionId, callbackToken: job.callbackToken, outcome: { kind: "completed", result } }) }), env);
    expect((await finalize({ ...zero, repoAssessment: "missing_or_private" })).status).toBe(400);
    expect((await finalize({ ...zero, pinnedSha: "b".repeat(40) })).status).toBe(400);
    expect((await finalize(zero)).status).toBe(200);
    expect(await (await call(`/api/batches/${payload.batch.id}`)).json()).toMatchObject({ batch: { counts: { completed: 2 }, scoredCount: 2 } });
  });

  it("reads legacy high production history with the additive effort fallback", async () => {
    const { create, call, database } = setup();
    const { payload } = await create(input());
    const result = {
      summary: "historical production", publicReason: "reason", repoAssessment: "scored", pinnedSha: frozen.pinnedSha,
      criteria: CRITERIA.map((item) => ({ key: item.key, label: item.label, score: 8, reason: "reason", evidencePaths: [] })), total: 32, attackScore: null,
      usage: { model: "gpt-6.1-sol", effort: "high", decisionsModel: "gpt-6-luna", inputTokens: 100, outputTokens: 10, costUsd: 0.0003, decisionsScores: { technical: 8, ux: 8, impact: 8, idea: 8 }, requestIds: [] }
    };
    expect(validatePublicScoreResult(result).usage!.effort).toBe("high");
    database.db.prepare("UPDATE devday_judge_submissions SET scoring_effort = NULL, status = 'completed', result_json = ? WHERE id = ?").run(JSON.stringify(result), payload.submissions[0]!.id);
    const before = database.changes();
    const response = await call(`/api/submissions/${payload.submissions[0]!.id}`);
    expect(await response.json()).toMatchObject({ effort: "high", result: { usage: { effort: "high" } } });
    expect((await (await call("/api/ranking")).json() as { items: unknown[] }).items).toHaveLength(1);
    expect(database.changes()).toBe(before);
  });
  it("applies 0005 additively without losing legacy high production results or budget state", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const name of ["0001_runtime.sql", "0002_attempts.sql", "0003_scoring_effort.sql", "0004_dispatch_limit.sql"]) database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      database.exec("INSERT INTO devday_judge_submissions (id,event_id,repo_url,repo_normalized,repo_owner,repo_name,team_name,mode,effort,status,created_at,updated_at,result_json) VALUES ('old','devday-20261018','https://github.com/a/b','a/b','a','b','old','production','high','completed','before','before','{\"legacy\":true}')");
      database.exec("UPDATE devday_judge_budget_accounts SET spent_micro_usd = 123, reserved_micro_usd = 456 WHERE mode = 'production'");
      const old = database.prepare("SELECT * FROM devday_judge_submissions").get()!;
      database.exec(readFileSync(new URL("../migrations/0005_batch_intake.sql", import.meta.url), "utf8"));
      expect(database.prepare("SELECT * FROM devday_judge_submissions").get()).toMatchObject({ ...old, scoring_effort: null, batch_id: null });
      expect(database.prepare("SELECT * FROM devday_judge_budget_accounts WHERE mode = 'production'").get()).toMatchObject({ limit_micro_usd: 90_000_000, spent_micro_usd: 123, reserved_micro_usd: 456 });
      expect(() => database.prepare("UPDATE devday_judge_submissions SET effort = 'medium'").run()).toThrow();
      expect(() => database.prepare("UPDATE devday_judge_submissions SET scoring_effort = 'medium'").run()).not.toThrow();
      expect(() => database.prepare("UPDATE devday_judge_submissions SET scoring_effort = 'invalid'").run()).toThrow();
    } finally { database.close(); }
  });

  it("uses queue concurrency eight, batch one and no automatic retry", () => {
    const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    expect(config.queues.producers).toContainEqual({ binding: "EXPLANATION_QUEUE", queue: "devday-judge-explanations-20261018" });
    expect(config.queues.consumers).toHaveLength(2);
    for (const consumer of config.queues.consumers) expect(consumer).toMatchObject({ max_concurrency: 8, max_batch_size: 1, max_retries: 0 });
    expect(config.queues.consumers.map((consumer: { queue: string }) => consumer.queue)).toEqual(["devday-judge-20261018", "devday-judge-explanations-20261018"]);
  });

  it("migrates historical results and outstanding reservations additively with foreign keys enabled", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      for (const name of ["0001_runtime.sql", "0002_attempts.sql", "0003_scoring_effort.sql", "0004_dispatch_limit.sql", "0005_batch_intake.sql"]) database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      database.exec("INSERT INTO devday_judge_submissions (id,event_id,repo_url,repo_normalized,repo_owner,repo_name,team_name,mode,effort,status,created_at,updated_at,completed_at,result_json,callback_token) VALUES ('history','devday-20261018','https://github.com/a/b','a/b','a','b','old','production','high','completed','before','before','completed','{\"legacy\":true}','original-token')");
      database.exec("INSERT INTO devday_judge_budget_reservations (id,submission_id,callback_token,mode,kind,model,max_input_tokens,max_output_tokens,reserved_micro_usd,status,created_at) VALUES ('reservation','history','original-token','production','responses','gpt-6.1-sol',100,100,456,'reserved','before')");
      database.exec("UPDATE devday_judge_budget_accounts SET spent_micro_usd = 123, reserved_micro_usd = 456 WHERE mode = 'production'");
      const previous = database.prepare("SELECT * FROM devday_judge_submissions").get()!;
      const reservation = database.prepare("SELECT * FROM devday_judge_budget_reservations").get()!;
      const account = database.prepare("SELECT * FROM devday_judge_budget_accounts WHERE mode = 'production'").get()!;
      database.exec(readFileSync(new URL("../migrations/0006_two_stage_judging.sql", import.meta.url), "utf8"));
      expect(database.prepare("SELECT * FROM devday_judge_submissions").get()).toMatchObject({ ...previous, explanation_status: "completed", evidence_snapshot_json: null, decisions_result_json: null, scored_at: "completed", explanation_dispatches: 0, explanation_requested_at: null, explanation_started_at: null });
      const beforeEvidence = database.prepare("SELECT * FROM devday_judge_submissions").get()!;
      database.exec(readFileSync(new URL("../migrations/0008_full_source_evidence.sql", import.meta.url), "utf8"));
      expect(database.prepare("SELECT * FROM devday_judge_submissions").get()).toEqual(beforeEvidence);
      expect(database.prepare("SELECT COUNT(*) AS n FROM devday_judge_evidence_manifests").get()).toEqual({ n: 0 });
      expect(database.prepare("SELECT COUNT(*) AS n FROM devday_judge_evidence_chunks").get()).toEqual({ n: 0 });
      expect(database.prepare("SELECT * FROM devday_judge_budget_reservations").get()).toEqual(reservation);
      expect(database.prepare("SELECT * FROM devday_judge_budget_accounts WHERE mode = 'production'").get()).toEqual(account);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => database.exec("DELETE FROM devday_judge_submissions WHERE id = 'history'")).toThrow();
      expect(() => database.exec("UPDATE devday_judge_submissions SET explanation_dispatches = 4")).toThrow();
      expect(() => database.exec("UPDATE devday_judge_submissions SET explanation_status = 'invalid'")).toThrow();
      expect(() => database.exec("UPDATE devday_judge_submissions SET effort = 'medium'")).toThrow();
      expect(() => database.exec("UPDATE devday_judge_submissions SET scoring_effort = 'medium'")).not.toThrow();
    } finally { database.close(); }
  });

  it("settles a reserved old attempt after explicit retry while rejecting stale callbacks and retaining the frozen SHA", async () => {
    const { create, controls, scoring, call, env, database } = setup();
    const { payload } = await create(input());
    await processFreezeMessage(controls()[0]!, env);
    const job = (await claimQueueMessage(scoring()[0]!, env))!;
    const ownership = { submissionId: job.submissionId, callbackToken: job.callbackToken, reservationId: "late-charge" };
    const internal = (body: unknown) => new Request("https://internal.example", { method: "POST", body: JSON.stringify(body) });
    expect((await reserve(internal({ ...ownership, reservation: { kind: "responses", model: "gpt-6.1-sol", maxInputTokens: 100, maxOutputTokens: 100, reservedUsd: 1 } }), env)).status).toBe(201);
    vi.setSystemTime("2026-10-18T09:31:00.000Z");
    expect((await call(`/api/submissions/${job.submissionId}/retry`, "POST", { confirm: true })).status).toBe(202);
    env.SUBMISSIONS_OPEN = "false";
    env.JUDGING_ENABLED = "false";
    const settlement = { ...ownership, usage: { kind: "responses", model: "gpt-6.1-sol", inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.0003 } };
    expect((await settle(internal(settlement), env)).status).toBe(200);
    const before = database.changes();
    expect((await settle(internal(settlement), env)).status).toBe(200);
    expect(database.changes()).toBe(before);
    expect((await callback(internal({ ...ownership, outcome: { kind: "failed", message: "stale" } }), env)).status).toBe(400);
    expect((await callback(internal({ submissionId: job.submissionId, callbackToken: job.callbackToken, outcome: { kind: "failed", message: "stale" } }), env)).status).toBe(403);
    expect(database.rows()[0]!.pinned_sha).toBe(frozen.pinnedSha);
    expect(database.db.prepare("SELECT * FROM devday_judge_budget_accounts WHERE mode = 'production'").get()).toMatchObject({ spent_micro_usd: 300, reserved_micro_usd: 0 });
    expect(payload.submissions[0]!.effort).toBe("medium");
  });
});
