import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { EVENT_ID, MAX_EVIDENCE_FILES, MAX_EVIDENCE_TOTAL_BYTES, MAX_SNAPSHOT_SERIALIZED_BYTES } from "../src/shared/constants";
import type { RepoEvidenceSnapshot } from "../src/shared/types";
import type { SubmissionRow } from "../src/worker/api";
import { hasStoredEvidenceSnapshot, loadEvidenceSnapshot, persistEvidenceSnapshot, requireStoredEvidenceSnapshot, validateSnapshot } from "../src/worker/evidence-store";

class EvidenceD1 {
  readonly db = new DatabaseSync(":memory:");
  private pending: Promise<unknown> = Promise.resolve();

  constructor() {
    const base = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(base).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) this.db.exec(readFileSync(new URL(file, base), "utf8"));
    this.db.prepare("INSERT INTO devday_judge_submissions (id, event_id, repo_url, repo_normalized, repo_owner, repo_name, team_name, mode, status, callback_token, attempts, dispatch_count, created_at, updated_at, pinned_sha, default_branch) VALUES ('submission', ?, 'https://github.com/example/source', 'example/source', 'example', 'source', 'Team', 'production', 'processing', 'lease', 1, 1, 'created', 'updated', ?, 'main')").run(EVENT_ID, "a".repeat(40));
  }

  prepare(sql: string) {
    const db = this.db;
    return { bind(...values: unknown[]) {
      return {
        async first<T>() { return (db.prepare(sql).get(...values as []) ?? null) as T | null; },
        async all<T>() { return { results: db.prepare(sql).all(...values as []) as T[] }; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...values as []).changes) } }; }
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

  row() { return this.db.prepare("SELECT * FROM devday_judge_submissions").get() as unknown as SubmissionRow; }
  changes() { return Number(this.db.prepare("SELECT total_changes() AS n").get()!.n); }
  manifest() { return this.db.prepare("SELECT * FROM devday_judge_evidence_manifests").get()!; }
}

function setup(content = "export const value = '完全な証拠';") {
  const database = new EvidenceD1();
  const env = { JUDGE_DB: database } as unknown as Env;
  const row = database.row();
  const snapshot: RepoEvidenceSnapshot = {
    fullSource: true,
    repo: { owner: row.repo_owner, repo: row.repo_name, normalized: row.repo_normalized, canonicalUrl: row.repo_url },
    pinnedSha: row.pinned_sha, defaultBranch: row.default_branch, summary: "full source", assessment: "scored",
    files: [{ path: "src/main.ts", content, size: new TextEncoder().encode(content).byteLength, truncated: false }]
  };
  return { database, env, row, snapshot };
}

describe("full source evidence store", () => {
  it("stores over 2MiB without inline source, splits raw UTF8 bytes and reconstructs losslessly", async () => {
    const { database, env, row, snapshot } = setup("あ漢𠮷".repeat(230_000));
    await persistEvidenceSnapshot(snapshot, row, env);
    expect(database.row().evidence_snapshot_json).toBeNull();
    expect(database.manifest()).toMatchObject({ submission_id: row.id, event_id: EVENT_ID, attempt: 1, callback_token: "lease", pinned_sha: row.pinned_sha, byte_count: new TextEncoder().encode(validateSnapshot(snapshot, row)).byteLength, chunk_count: 5, complete: 1 });
    const chunks = database.db.prepare("SELECT chunk_index, content, length(content) AS n FROM devday_judge_evidence_chunks ORDER BY chunk_index").all();
    expect(chunks.every((chunk) => Number(chunk.n) <= 512 * 1024)).toBe(true);
    expect(chunks.slice(0, -1).every((chunk) => Number(chunk.n) === 512 * 1024)).toBe(true);
    expect(chunks.some((chunk) => { try { new TextDecoder("utf-8", { fatal: true }).decode(chunk.content as Uint8Array); return false; } catch { return true; } })).toBe(true);
    expect(await loadEvidenceSnapshot(row, env)).toEqual(snapshot);
    await requireStoredEvidenceSnapshot(snapshot, row, env);
  });

  it("reuses the same generation and hash with zero writes, including concurrent duplicate saves", async () => {
    const { database, env, row, snapshot } = setup();
    await Promise.all([persistEvidenceSnapshot(snapshot, row, env), persistEvidenceSnapshot(snapshot, row, env)]);
    const before = database.changes();
    await persistEvidenceSnapshot(structuredClone(snapshot), row, env);
    await persistEvidenceSnapshot({ files: snapshot.files, assessment: snapshot.assessment, summary: snapshot.summary, defaultBranch: snapshot.defaultBranch, pinnedSha: snapshot.pinnedSha, repo: snapshot.repo, fullSource: true }, row, env);
    expect(database.changes()).toBe(before);
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM devday_judge_evidence_manifests").get()!.n).toBe(1);
    await expect(persistEvidenceSnapshot({ ...snapshot, summary: "changed" }, row, env)).rejects.toThrow("conflict");
    expect(database.changes()).toBe(before);
  });

  it.each(["array", "buffer"])("accepts the %s BLOB representation returned by D1", async (format) => {
    const { database, env, row, snapshot } = setup("漢𠮷".repeat(90_000));
    await persistEvidenceSnapshot(snapshot, row, env);
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      const query = prepare(sql);
      if (!sql.startsWith("SELECT chunk_index")) return query;
      return { bind(...values) {
        const statement = query.bind(...values);
        return { ...statement, async first<T>() {
          const chunk = await statement.first<{ chunk_index: number; content: Uint8Array }>();
          return (chunk ? { ...chunk, content: format === "array" ? Array.from(chunk.content) : chunk.content.slice().buffer } : null) as T | null;
        } };
      } };
    });
    expect(await loadEvidenceSnapshot(row, env)).toEqual(snapshot);
  });

  it("uses all eight bounded chunks for a large escaped full snapshot", async () => {
    const { database, env, row, snapshot } = setup("\u0001".repeat(650_000));
    await persistEvidenceSnapshot(snapshot, row, env);
    expect(database.manifest()).toMatchObject({ chunk_count: 8, complete: 1 });
    expect(Number(database.manifest().byte_count)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(await loadEvidenceSnapshot(row, env)).toEqual(snapshot);
  });

  it("restores eight full packs with one bounded D1 BLOB read at a time", async () => {
    const { database, env, row, snapshot } = setup("\u0001".repeat(650_000));
    await persistEvidenceSnapshot(snapshot, row, env);
    const prepare = database.prepare.bind(database);
    let active = 0;
    let peak = 0;
    let reads = 0;
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      const query = prepare(sql);
      if (!sql.startsWith("SELECT chunk_index")) return query;
      return { bind(...values) {
        const statement = query.bind(...values);
        return { ...statement,
          async all<T>(): Promise<{ results: T[] }> { throw new Error("BLOB bulk reads are forbidden"); },
          async first<T>() {
            active++;
            peak = Math.max(peak, active);
            reads++;
            try {
              const chunk = await statement.first<{ chunk_index: number; content: Uint8Array }>();
              if (!chunk) return null;
              expect(chunk.content.byteLength).toBeLessThanOrEqual(512 * 1024);
              await Promise.resolve();
              return { ...chunk, content: Array.from(chunk.content) } as T;
            } finally { active--; }
          }
        };
      } };
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => loadEvidenceSnapshot(row, env)));
    expect(results.every((value) => value?.files[0]!.content === snapshot.files[0]!.content)).toBe(true);
    expect(reads).toBe(64);
    expect(peak).toBe(1);
  });

  it.each(["status", "token", "attempt", "result", "sha"])("rejects stale %s leases before writes", async (field) => {
    const { database, env, row, snapshot } = setup();
    const updates: Record<string, string> = { status: "status = 'failed'", token: "callback_token = 'new-lease'", attempt: "attempts = 2", result: "result_json = '{}'", sha: "pinned_sha = 'changed'" };
    database.db.exec(`UPDATE devday_judge_submissions SET ${updates[field]}`);
    const before = database.changes();
    await expect(persistEvidenceSnapshot(snapshot, row, env)).rejects.toThrow("Stale evidence lease");
    expect(database.changes()).toBe(before);
  });

  it("rechecks the CAS in the batch after a lease changes between reads and writes", async () => {
    const { database, env, row, snapshot } = setup();
    const batch = database.batch.bind(database);
    vi.spyOn(database, "batch").mockImplementation(async (statements) => {
      database.db.exec("UPDATE devday_judge_submissions SET attempts = 2, callback_token = 'next'");
      return batch(statements);
    });
    await expect(persistEvidenceSnapshot(snapshot, row, env)).rejects.toThrow("not saved before scoring");
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM devday_judge_evidence_manifests").get()!.n).toBe(0);
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM devday_judge_evidence_chunks").get()!.n).toBe(0);
  });

  it("reuses immutable evidence across retry generations and rejects stale consumers or different snapshots", async () => {
    const { database, env, row, snapshot } = setup();
    await persistEvidenceSnapshot(snapshot, row, env);
    database.db.exec("UPDATE devday_judge_submissions SET attempts = 2, callback_token = 'next'");
    const next = database.row();
    const before = database.changes();
    await persistEvidenceSnapshot(snapshot, next, env);
    expect(database.changes()).toBe(before);
    await expect(persistEvidenceSnapshot({ ...snapshot, summary: "new generation" }, next, env)).rejects.toThrow("conflict");
    await expect(persistEvidenceSnapshot(snapshot, row, env)).rejects.toThrow("Stale evidence lease");
    expect(database.changes()).toBe(before);
    expect(await loadEvidenceSnapshot(next, env)).toEqual(snapshot);
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM devday_judge_evidence_manifests").get()!.n).toBe(1);
  });

  it.each(["missing", "order", "corrupt", "hash", "bytes", "count", "complete", "oversize"])("rejects %s evidence without repairing or writing it", async (damage) => {
    const { database, env, row, snapshot } = setup("a".repeat(600_000));
    await persistEvidenceSnapshot(snapshot, row, env);
    if (damage === "missing") database.db.exec("DELETE FROM devday_judge_evidence_chunks WHERE chunk_index = 1");
    if (damage === "order") database.db.exec("UPDATE devday_judge_evidence_chunks SET chunk_index = 2 WHERE chunk_index = 1");
    if (damage === "corrupt") database.db.exec("UPDATE devday_judge_evidence_chunks SET content = zeroblob(length(content)) WHERE chunk_index = 0");
    if (damage === "hash") database.db.exec("UPDATE devday_judge_evidence_manifests SET sha256 = '0000000000000000000000000000000000000000000000000000000000000000'");
    if (damage === "bytes") database.db.exec("UPDATE devday_judge_evidence_manifests SET byte_count = byte_count - 1");
    if (damage === "count") database.db.exec("UPDATE devday_judge_evidence_manifests SET chunk_count = chunk_count + 1");
    if (damage === "complete") database.db.exec("UPDATE devday_judge_evidence_manifests SET complete = 0");
    if (damage === "oversize") {
      database.db.exec("PRAGMA ignore_check_constraints = ON");
      database.db.exec("UPDATE devday_judge_evidence_chunks SET content = zeroblob(524289) WHERE chunk_index = 0");
    }
    const before = database.changes();
    await expect(loadEvidenceSnapshot(row, env)).rejects.toThrow();
    expect(await hasStoredEvidenceSnapshot(row, env)).toBe(false);
    expect(database.changes()).toBe(before);
  });

  it("rejects out-of-order D1 results even when all chunk indices exist", async () => {
    const { database, env, row, snapshot } = setup("a".repeat(600_000));
    await persistEvidenceSnapshot(snapshot, row, env);
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      const query = prepare(sql);
      if (!sql.startsWith("SELECT chunk_index")) return query;
      return { bind(...values) {
        const statement = query.bind(...values);
        return { ...statement, async first<T>() {
          const result = await statement.first<{ chunk_index: number; content: Uint8Array }>();
          return (result ? { ...result, chunk_index: result.chunk_index + 1 } : null) as T | null;
        } };
      } };
    });
    await expect(loadEvidenceSnapshot(row, env)).rejects.toThrow("order");
  });

  it("fatally rejects malformed UTF8 even if an attacker updates its hash", async () => {
    const { database, env, row, snapshot } = setup();
    await persistEvidenceSnapshot(snapshot, row, env);
    const bytes = new Uint8Array([0xc3, 0x28]);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    database.db.prepare("UPDATE devday_judge_evidence_chunks SET content = ?").run(bytes);
    database.db.prepare("UPDATE devday_judge_evidence_manifests SET sha256 = ?, byte_count = 2").run(hash);
    await expect(loadEvidenceSnapshot(row, env)).rejects.toThrow();
  });

  it("rolls back manifest and all chunks together on a write failure", async () => {
    const { database, env, row, snapshot } = setup("a".repeat(600_000));
    database.db.exec("CREATE TRIGGER reject_chunk BEFORE INSERT ON devday_judge_evidence_chunks WHEN NEW.chunk_index = 1 BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
    await expect(persistEvidenceSnapshot(snapshot, row, env)).rejects.toThrow("injected write failure");
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM devday_judge_evidence_manifests").get()!.n).toBe(0);
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM devday_judge_evidence_chunks").get()!.n).toBe(0);
    expect(database.row().result_json).toBeNull();
  });

  it("requires the exact saved snapshot before accepting paid results", async () => {
    const { env, row, snapshot } = setup();
    await expect(requireStoredEvidenceSnapshot(snapshot, row, env)).rejects.toThrow("not saved before scoring");
    await persistEvidenceSnapshot(snapshot, row, env);
    await expect(requireStoredEvidenceSnapshot({ ...snapshot, summary: "different" }, row, env)).rejects.toThrow("not saved before scoring");
  });

  it("reads legacy inline evidence without claiming full source or writing a migration", async () => {
    const { database, env, row, snapshot } = setup();
    const legacy = { ...snapshot, fullSource: true, files: snapshot.files.map((file) => ({ ...file, truncated: true })) };
    database.db.prepare("UPDATE devday_judge_submissions SET evidence_snapshot_json = ?").run(JSON.stringify(legacy));
    const before = database.changes();
    const { fullSource: _, ...unmarked } = legacy;
    expect(await loadEvidenceSnapshot(database.row(), env)).toEqual(unmarked);
    expect(await hasStoredEvidenceSnapshot(database.row(), env)).toBe(false);
    await expect(requireStoredEvidenceSnapshot(snapshot, database.row(), env)).rejects.toThrow("not saved before scoring");
    expect(database.changes()).toBe(before);
    expect(await loadEvidenceSnapshot(row, env)).toBeNull();
  });

  it("keeps pre-lease historical inline snapshots readable without claiming full source", async () => {
    const { database, env, snapshot } = setup();
    database.db.prepare("UPDATE devday_judge_submissions SET evidence_snapshot_json = ?, callback_token = NULL, attempts = 0").run(JSON.stringify(snapshot));
    const before = database.changes();
    const { fullSource: _, ...unmarked } = snapshot;
    expect(await loadEvidenceSnapshot(database.row(), env)).toEqual(unmarked);
    expect(database.changes()).toBe(before);
  });

  it("enforces the full source capacities and rejects truncation before any write", async () => {
    const { database, env, row, snapshot } = setup("a".repeat(MAX_EVIDENCE_TOTAL_BYTES));
    expect(MAX_EVIDENCE_FILES).toBe(2000);
    expect(MAX_EVIDENCE_TOTAL_BYTES).toBe(3 * 1024 * 1024);
    expect(MAX_SNAPSHOT_SERIALIZED_BYTES).toBe(4 * 1024 * 1024);
    await persistEvidenceSnapshot(snapshot, row, env);
    expect(await loadEvidenceSnapshot(row, env)).toEqual(snapshot);
    const invalid = [
      { ...snapshot, files: [{ ...snapshot.files[0]!, truncated: true }] },
      { ...snapshot, files: [{ ...snapshot.files[0]!, content: "a".repeat(MAX_EVIDENCE_TOTAL_BYTES + 1), size: MAX_EVIDENCE_TOTAL_BYTES + 1 }] },
      { ...snapshot, files: Array.from({ length: 2001 }, (_, index) => ({ path: `src/${index}.ts`, content: "a", size: 1, truncated: false })) },
      { ...snapshot, files: [{ path: "src/main.ts", content: "\u0001".repeat(800_000), size: 800_000, truncated: false }] }
    ];
    const before = database.changes();
    for (const value of invalid) await expect(persistEvidenceSnapshot(value, row, env)).rejects.toThrow();
    expect(database.changes()).toBe(before);
  });
});
