import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { resolveRepoEvidence } from "../src/container/github";
import { acquireJudgingMemory } from "../src/shared/judging-memory";
import type { NormalizedRepo, RepoEvidenceSnapshot } from "../src/shared/types";
import { prepareFullSourceSnapshot } from "../src/shared/validation";
import { loadEvidenceSnapshot } from "../src/worker/evidence-store";

const README = "# Offline concurrency fixture\n\nTwo tracked files, with complete source.\n";
const MAIN = "export function answer(): number {\n  return 42;\n}\n";
const REFS_URL = "https://github.com/fixture/workerd-concurrency.git/info/refs?service=git-upload-pack";
const UPLOAD_URL = "https://github.com/fixture/workerd-concurrency.git/git-upload-pack";
const HOLD_MS = 250;
const PHASE_MS = 25;
let smallArrivals = 0;
let smallAdmissions = 0;
let waitArrivals = 0;
let waitAdmissions = 0;
let holderState = 0;
let refsReads = 0;
let filteredReads = 0;
let blobReads = 0;
let deniedFetches = 0;

type GitObject = { oid: string; type: "commit" | "tree" | "blob"; data: Buffer };

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error("Fixture contract failed");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function repository(): NormalizedRepo {
  return { owner: "fixture", repo: "workerd-concurrency", normalized: "fixture/workerd-concurrency", canonicalUrl: "https://github.com/fixture/workerd-concurrency" };
}

function object(type: GitObject["type"], value: string | Uint8Array): GitObject {
  const data = Buffer.from(value);
  const oid = createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");
  return { oid, type, data };
}

function tree(entries: { mode: string; name: string; oid: string }[]): GitObject {
  return object("tree", Buffer.concat(entries.map(({ mode, name, oid }) => Buffer.concat([
    Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")
  ]))));
}

function gitFixture() {
  const readme = object("blob", README);
  const main = object("blob", MAIN);
  const source = tree([{ mode: "100644", name: "main.ts", oid: main.oid }]);
  const root = tree([{ mode: "100644", name: "README.md", oid: readme.oid }, { mode: "40000", name: "src", oid: source.oid }]);
  const commit = object("commit", `tree ${root.oid}\nauthor Fixture <fixture@example.test> 1 +0000\ncommitter Fixture <fixture@example.test> 1 +0000\n\nOffline fixture\n`);
  return { commit, trees: [root, source], blobs: [readme, main] };
}

function packet(value: string): string {
  return (Buffer.byteLength(value) + 4).toString(16).padStart(4, "0") + value;
}

function pack(objects: GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const entries = objects.map(({ type, data }) => {
    let remaining = Math.floor(data.length / 16);
    const bytes = [({ commit: 1, tree: 2, blob: 3 }[type] << 4) | (data.length & 15) | (remaining ? 128 : 0)];
    while (remaining) {
      const byte = remaining & 127;
      remaining = Math.floor(remaining / 128);
      bytes.push(byte | (remaining ? 128 : 0));
    }
    return Buffer.concat([Buffer.from(bytes), deflateSync(data)]);
  });
  const bytes = Buffer.concat([header, ...entries]);
  return Buffer.concat([bytes, createHash("sha1").update(bytes).digest()]);
}

function requestPackets(body: RequestInit["body"]): string[] {
  assert(body instanceof Uint8Array);
  const bytes = Buffer.from(body);
  const packets: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString("ascii");
    assert(/^[0-9a-f]{4}$/.test(header));
    const length = Number.parseInt(header, 16);
    offset += 4;
    if (length === 0) packets.push("FLUSH");
    else {
      assert(length >= 4 && offset + length - 4 <= bytes.length);
      packets.push(bytes.subarray(offset, offset + length - 4).toString("utf8"));
      offset += length - 4;
    }
  }
  assert(offset === bytes.length);
  return packets;
}

function canonicalResponse(body: string | Uint8Array, mime: string, url: string): Response {
  const response = new Response(typeof body === "string" ? body : Uint8Array.from(body).buffer, { headers: { "content-type": mime } });
  Object.defineProperty(response, "url", { value: url });
  Object.defineProperty(response, "redirected", { value: false });
  return response;
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  if (url !== REFS_URL && url !== UPLOAD_URL) {
    deniedFetches++;
    throw new Error("Fixture denies external network");
  }
  assert(init?.redirect === "manual" && init.credentials === "omit" && init.signal instanceof AbortSignal);
  const headers = new Headers(init.headers);
  const data = gitFixture();
  if (url === REFS_URL) {
    assert(init.method === "GET" && headers.get("accept") === "application/x-git-upload-pack-advertisement");
    refsReads++;
    await wait(PHASE_MS);
    const sha = data.commit.oid;
    const body = packet("# service=git-upload-pack\n") + "0000"
      + packet(`${sha} HEAD\0filter shallow ofs-delta no-progress symref=HEAD:refs/heads/main\n`)
      + packet(`${sha} refs/heads/main\n`) + "0000";
    return canonicalResponse(body, "application/x-git-upload-pack-advertisement", url);
  }
  assert(init.method === "POST" && headers.get("content-type") === "application/x-git-upload-pack-request"
    && headers.get("accept") === "application/x-git-upload-pack-result");
  const packets = requestPackets(init.body);
  const filtered = packets.includes("filter blob:none\n");
  const wants = packets.filter((line) => line.startsWith("want ")).map((line) => line.slice(5, 45));
  assert(packets.at(-1) === "done\n" && packets.at(-2) === "FLUSH");
  let objects: GitObject[];
  if (filtered) {
    assert(wants.length === 1 && wants[0] === data.commit.oid && packets.includes("deepen 1\n"));
    filteredReads++;
    objects = [data.commit, ...data.trees];
  } else {
    assert(wants.length === 2 && new Set(wants).size === 2 && wants.every((oid) => data.blobs.some((blob) => blob.oid === oid)));
    blobReads++;
    objects = wants.map((oid) => data.blobs.find((blob) => blob.oid === oid)!);
  }
  await wait(PHASE_MS);
  return canonicalResponse(Buffer.concat([Buffer.from(packet("NAK\n")), pack(objects)]), "application/x-git-upload-pack-result", url);
}) as typeof fetch;

function validateContents(snapshot: RepoEvidenceSnapshot | null): asserts snapshot is RepoEvidenceSnapshot {
  assert(snapshot?.fullSource === true && snapshot.assessment === "scored" && snapshot.files.length === 2);
  assert(snapshot.pinnedSha === gitFixture().commit.oid && snapshot.defaultBranch === "main");
  for (const [path, content] of [["README.md", README], ["src/main.ts", MAIN]] as const) {
    const file = snapshot.files.find((candidate) => candidate.path === path);
    assert(file !== undefined && file.content === content && file.size === Buffer.byteLength(content) && file.truncated === false);
  }
}

async function restoreFixture(): Promise<{ files: number; fullSource: true; chunkReads: number; chunks: number }> {
  const repo = repository();
  const snapshot: RepoEvidenceSnapshot = {
    repo, pinnedSha: gitFixture().commit.oid, defaultBranch: "main", summary: "Offline workerd restoration fixture",
    assessment: "scored", fullSource: true,
    files: [{ path: "README.md", content: README, size: Buffer.byteLength(README), truncated: false },
      { path: "src/main.ts", content: MAIN, size: Buffer.byteLength(MAIN), truncated: false }]
  };
  const prepared = await prepareFullSourceSnapshot(snapshot);
  const bytes = Buffer.from(prepared.serialized);
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert(hash === prepared.metadata.sourceHash && bytes.length < 512 * 1024);
  const row = {
    id: "offline-workerd-fixture", event_id: "devday-20261018", attempts: 1, callback_token: "offline-fixture-generation",
    pinned_sha: snapshot.pinnedSha, default_branch: "main", repo_normalized: repo.normalized,
    repo_owner: repo.owner, repo_name: repo.repo, repo_url: repo.canonicalUrl
  };
  const key = [row.id, row.event_id, row.attempts, row.callback_token];
  const manifest = {
    submission_id: row.id, event_id: row.event_id, attempt: 1, callback_token: row.callback_token,
    pinned_sha: row.pinned_sha, sha256: hash, byte_count: bytes.length, chunk_count: 1, complete: 1
  };
  let chunkReads = 0;
  const env = { JUDGE_DB: { prepare(query: string) {
    return { bind(...values: unknown[]) {
      return { async first() {
        await wait(PHASE_MS);
        if (query.startsWith("SELECT submission_id, event_id, attempt, callback_token, pinned_sha, sha256, byte_count, chunk_count, complete FROM devday_judge_evidence_manifests")) {
          assert(values.length === 2 && values[0] === row.id && values[1] === row.event_id);
          return { ...manifest };
        }
        assert(key.every((value, index) => values[index] === value));
        if (query.startsWith("SELECT COUNT(*) AS chunk_count, SUM(length(content)) AS byte_count FROM devday_judge_evidence_chunks")) {
          assert(values.length === 4);
          return { chunk_count: 1, byte_count: bytes.length };
        }
        assert(query.startsWith("SELECT chunk_index, content FROM devday_judge_evidence_chunks") && values.length === 5 && values[4] === 0);
        chunkReads++;
        return { chunk_index: 0, content: Array.from(bytes) };
      } };
    } };
  } } };
  const restored = await loadEvidenceSnapshot(row as never, env as never);
  validateContents(restored);
  assert((await prepareFullSourceSnapshot(restored)).serialized === prepared.serialized && chunkReads === 1);
  return { files: restored.files.length, fullSource: true, chunkReads, chunks: 1 };
}

export default {
  async fetch(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname.slice(1);
    const started = Date.now();
    const metadata = () => ({ route, durationMs: Date.now() - started });
    if (request.method !== "GET") return Response.json({ ok: false, error: "method_not_allowed", ...metadata() }, { status: 405 });
    try {
      if (route === "health") return Response.json({
        ok: true, ready: true, offline: true, runtime: "workerd", concurrency: 8, holdMs: HOLD_MS, phaseMs: PHASE_MS,
        expectedFiles: 2, refsReads, filteredReads, blobReads, deniedFetches, ...metadata()
      });
      if (route === "holder-ready") return Response.json({ ok: true, holderStarted: holderState > 0, holderActive: holderState === 1, holderFinished: holderState === 2, ...metadata() });
      if (route === "source") {
        const snapshot = await resolveRepoEvidence(repository(), "Offline workerd acquisition fixture");
        validateContents(snapshot);
        return Response.json({ ok: true, offline: true, files: snapshot.files.length, fullSource: true, ...metadata() });
      }
      if (route === "restore") return Response.json({ ok: true, ...await restoreFixture(), ...metadata() });
      if (route !== "small" && route !== "wait" && route !== "holder") {
        return Response.json({ ok: false, error: "unknown_route", ...metadata() }, { status: 404 });
      }
      if (route === "holder" && holderState !== 0) return Response.json({ ok: false, error: "holder_already_started", ...metadata() }, { status: 409 });
      const arrivalOrder = route === "small" ? ++smallArrivals : route === "wait" ? ++waitArrivals : 1;
      const memory = await acquireJudgingMemory();
      try {
        const admissionOrder = route === "small" ? ++smallAdmissions : route === "wait" ? ++waitAdmissions : 1;
        const acquiredAt = Date.now();
        const admittedMs = acquiredAt - started;
        if (route === "small") memory.reduceForSnapshot(1000);
        if (route === "holder") holderState = 1;
        const holdMs = route === "holder" ? 125_000 : HOLD_MS;
        await wait(holdMs);
        return Response.json({ ok: true, arrivalOrder, admissionOrder, admittedMs, acquiredAt, completedAt: Date.now(), holdMs, initialReservationMiB: 64,
          ...(route === "small" ? { snapshotBytes: 1000 } : {}), ...metadata() });
      } finally {
        memory.release();
        if (route === "holder") holderState = 2;
      }
    } catch (error) {
      if ((route === "small" || route === "wait" || route === "holder") && error instanceof Error && error.message === "Judging memory acquisition timed out") {
        return Response.json({ ok: false, error: "memory_acquisition_timeout", timeoutMs: 120_000, ...metadata() }, { status: 408 });
      }
      return Response.json({ ok: false, error: "fixture_failure", ...metadata() }, { status: 500 });
    }
  }
};
