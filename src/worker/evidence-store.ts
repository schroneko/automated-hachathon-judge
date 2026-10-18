import { EVENT_ID, MAX_EVIDENCE_FILE_BYTES, MAX_EVIDENCE_FILES, MAX_EVIDENCE_TOTAL_BYTES, MAX_SNAPSHOT_SERIALIZED_BYTES } from "../shared/constants";
import type { RepoEvidenceSnapshot } from "../shared/types";
import { prepareFullSourceSnapshot } from "../shared/validation";
import type { SubmissionRow } from "./api";

const CHUNK_BYTES = 512 * 1024;
const MAX_CHUNKS = 8;
const generation = "submission_id = ? AND event_id = ? AND attempt = ? AND callback_token = ?";
const lease = "EXISTS (SELECT 1 FROM devday_judge_submissions WHERE id = ? AND event_id = ? AND attempts = ? AND callback_token = ? AND status = 'processing' AND result_json IS NULL AND pinned_sha IS ?)";
let restorationTail = Promise.resolve();

interface Manifest {
  submission_id: string;
  event_id: string;
  attempt: number;
  callback_token: string;
  pinned_sha: string | null;
  sha256: string;
  byte_count: number;
  chunk_count: number;
  complete: number;
}

export function validateSnapshot(snapshot: RepoEvidenceSnapshot, row: SubmissionRow, legacy = false): string {
  if (!snapshot || snapshot.repo?.normalized !== row.repo_normalized || snapshot.repo.owner !== row.repo_owner
    || snapshot.repo.repo !== row.repo_name || snapshot.repo.canonicalUrl !== row.repo_url
    || snapshot.pinnedSha !== row.pinned_sha || snapshot.defaultBranch !== row.default_branch
    || typeof snapshot.summary !== "string" || snapshot.summary.length > 4000
    || !Array.isArray(snapshot.files) || snapshot.files.length > MAX_EVIDENCE_FILES
    || !["scored", "empty_repository", "missing_or_private", "no_default_branch"].includes(snapshot.assessment)
    || (snapshot.defaultBranch !== null && (typeof snapshot.defaultBranch !== "string" || snapshot.defaultBranch.length > 255))) throw new Error("Invalid evidence snapshot");
  const fullSource = snapshot.fullSource;
  if (fullSource !== undefined && (typeof fullSource !== "boolean" || (!legacy && !fullSource))) throw new Error("Invalid full source evidence");
  const encoder = new TextEncoder();
  let bytes = 0;
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== "string" || !file.path || file.path.length > 1024 || paths.has(file.path)
      || typeof file.content !== "string" || !Number.isSafeInteger(file.size) || file.size < 0
      || typeof file.truncated !== "boolean" || (!legacy && file.truncated)) throw new Error("Invalid evidence file");
    paths.add(file.path);
    const size = encoder.encode(file.content).byteLength;
    if (size > MAX_EVIDENCE_FILE_BYTES || file.size !== size) throw new Error("Invalid evidence file size");
    bytes += size;
  }
  if (bytes > MAX_EVIDENCE_TOTAL_BYTES || (snapshot.assessment !== "scored" && snapshot.files.length > 0)) throw new Error("Evidence snapshot exceeds limits");
  const serialized = JSON.stringify({ repo: { owner: snapshot.repo.owner, repo: snapshot.repo.repo, normalized: snapshot.repo.normalized, canonicalUrl: snapshot.repo.canonicalUrl }, pinnedSha: snapshot.pinnedSha, defaultBranch: snapshot.defaultBranch, summary: snapshot.summary, assessment: snapshot.assessment, ...(fullSource === undefined ? {} : { fullSource }), files: snapshot.files.map(({ path, size, content, truncated }) => ({ path, size, content, truncated })) });
  if (encoder.encode(serialized).byteLength > MAX_SNAPSHOT_SERIALIZED_BYTES) throw new Error("Evidence snapshot exceeds limits");
  return serialized;
}

function identity(row: SubmissionRow): [string, string, number, string] {
  if (row.event_id !== EVENT_ID || !row.callback_token || !Number.isSafeInteger(row.attempts) || row.attempts < 1 || row.attempts > 3) throw new Error("Invalid evidence generation");
  return [row.id, row.event_id, row.attempts, row.callback_token];
}

async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function manifestFor(row: SubmissionRow, env: Env): Promise<Manifest | null> {
  identity(row);
  return env.JUDGE_DB.prepare("SELECT submission_id, event_id, attempt, callback_token, pinned_sha, sha256, byte_count, chunk_count, complete FROM devday_judge_evidence_manifests WHERE submission_id = ? AND event_id = ?").bind(row.id, row.event_id).first<Manifest>();
}

async function readStored(row: SubmissionRow, manifest: Manifest, env: Env): Promise<RepoEvidenceSnapshot> {
  let release!: () => void;
  const previous = restorationTail;
  restorationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await restoreStored(row, manifest, env); } finally { release(); }
}

async function restoreStored(row: SubmissionRow, manifest: Manifest, env: Env): Promise<RepoEvidenceSnapshot> {
  const current = identity(row);
  const key = [manifest.submission_id, manifest.event_id, manifest.attempt, manifest.callback_token];
  if (manifest.submission_id !== current[0] || manifest.event_id !== current[1]
    || !Number.isSafeInteger(manifest.attempt) || manifest.attempt < 1 || manifest.attempt > 3 || !manifest.callback_token
    || manifest.pinned_sha !== row.pinned_sha || manifest.complete !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || !Number.isSafeInteger(manifest.byte_count) || manifest.byte_count < 1 || manifest.byte_count > MAX_SNAPSHOT_SERIALIZED_BYTES
    || !Number.isSafeInteger(manifest.chunk_count) || manifest.chunk_count < 1 || manifest.chunk_count > MAX_CHUNKS
    || manifest.chunk_count !== Math.ceil(manifest.byte_count / CHUNK_BYTES)) throw new Error("Invalid evidence manifest");
  const extent = await env.JUDGE_DB.prepare(`SELECT COUNT(*) AS chunk_count, SUM(length(content)) AS byte_count FROM devday_judge_evidence_chunks WHERE ${generation}`).bind(...key).first<{ chunk_count: number; byte_count: number | null }>();
  if (extent?.chunk_count !== manifest.chunk_count || extent.byte_count !== manifest.byte_count) throw new Error("Missing evidence chunks or invalid byte count");
  const bytes = new Uint8Array(manifest.byte_count);
  let offset = 0;
  for (let index = 0; index < manifest.chunk_count; index++) {
    const chunk = await env.JUDGE_DB.prepare(`SELECT chunk_index, content FROM devday_judge_evidence_chunks WHERE ${generation} AND chunk_index = ?`).bind(...key, index).first<{ chunk_index: number; content: ArrayBuffer | Uint8Array | number[] }>();
    if (!chunk || chunk.chunk_index !== index || !(chunk.content instanceof ArrayBuffer || chunk.content instanceof Uint8Array || Array.isArray(chunk.content))) throw new Error("Invalid evidence chunk order");
    if (Array.isArray(chunk.content) && chunk.content.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error("Invalid evidence chunk bytes");
    const content = chunk.content instanceof Uint8Array ? chunk.content : new Uint8Array(chunk.content);
    const expected = Math.min(CHUNK_BYTES, bytes.byteLength - offset);
    if (content.byteLength !== expected || content.byteLength < 1) throw new Error("Invalid evidence chunk size");
    bytes.set(content, offset);
    offset += content.byteLength;
  }
  if (offset !== manifest.byte_count || await digest(bytes) !== manifest.sha256) throw new Error("Evidence hash or byte count mismatch");
  const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as RepoEvidenceSnapshot;
  validateSnapshot(snapshot, row);
  const prepared = await prepareFullSourceSnapshot(snapshot);
  if (prepared.metadata.sourceHash !== manifest.sha256 || new TextEncoder().encode(prepared.serialized).byteLength !== manifest.byte_count) throw new Error("Noncanonical evidence snapshot");
  return snapshot;
}

export async function loadEvidenceSnapshot(row: SubmissionRow, env: Env): Promise<RepoEvidenceSnapshot | null> {
  if (row.event_id !== EVENT_ID) throw new Error("Invalid evidence event");
  const manifest = row.callback_token && row.attempts > 0 ? await manifestFor(row, env) : null;
  if (manifest) return readStored(row, manifest, env);
  if (!row.evidence_snapshot_json) return null;
  const snapshot = { ...JSON.parse(row.evidence_snapshot_json) } as RepoEvidenceSnapshot;
  delete snapshot.fullSource;
  validateSnapshot(snapshot, row, true);
  return snapshot;
}

export async function hasStoredEvidenceSnapshot(row: SubmissionRow, env: Env): Promise<boolean> {
  if (!row.callback_token) return false;
  try {
    const snapshot = await loadEvidenceSnapshot(row, env);
    return snapshot?.fullSource === true;
  } catch { return false; }
}

export async function requireStoredEvidenceSnapshot(snapshot: RepoEvidenceSnapshot, row: SubmissionRow, env: Env): Promise<void> {
  validateSnapshot(snapshot, row);
  const bytes = new TextEncoder().encode((await prepareFullSourceSnapshot(snapshot)).serialized);
  const manifest = await manifestFor(row, env);
  if (!manifest || manifest.sha256 !== await digest(bytes) || manifest.byte_count !== bytes.byteLength) throw new Error("Evidence snapshot was not saved before scoring");
  await readStored(row, manifest, env);
}

export async function persistEvidenceSnapshot(snapshot: RepoEvidenceSnapshot, row: SubmissionRow, env: Env): Promise<void> {
  const key = identity(row);
  validateSnapshot(snapshot, row);
  const bytes = new TextEncoder().encode((await prepareFullSourceSnapshot(snapshot)).serialized);
  const hash = await digest(bytes);
  const active = await env.JUDGE_DB.prepare(`SELECT id FROM devday_judge_submissions WHERE id = ? AND event_id = ? AND attempts = ? AND callback_token = ? AND status = 'processing' AND result_json IS NULL AND pinned_sha IS ?`).bind(...key, row.pinned_sha).first();
  if (!active) throw new Error("Stale evidence lease");
  const existing = await manifestFor(row, env);
  if (existing) {
    if (existing.sha256 !== hash || existing.byte_count !== bytes.byteLength) throw new Error("Evidence snapshot conflict");
    await readStored(row, existing, env);
    return;
  }
  const count = Math.ceil(bytes.byteLength / CHUNK_BYTES);
  if (count < 1 || count > MAX_CHUNKS) throw new Error("Evidence snapshot exceeds limits");
  const statements = [env.JUDGE_DB.prepare(`INSERT INTO devday_judge_evidence_manifests (submission_id, event_id, attempt, callback_token, pinned_sha, sha256, byte_count, chunk_count, complete) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0 WHERE ${lease} ON CONFLICT DO NOTHING`).bind(...key, row.pinned_sha, hash, bytes.byteLength, count, ...key, row.pinned_sha)];
  for (let index = 0; index < count; index++) {
    const content = bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
    statements.push(env.JUDGE_DB.prepare(`INSERT INTO devday_judge_evidence_chunks (submission_id, event_id, attempt, callback_token, chunk_index, content) SELECT ?, ?, ?, ?, ?, ? WHERE ${lease} AND EXISTS (SELECT 1 FROM devday_judge_evidence_manifests WHERE ${generation} AND sha256 = ? AND complete = 0) ON CONFLICT DO NOTHING`).bind(...key, index, content, ...key, row.pinned_sha, ...key, hash));
  }
  statements.push(env.JUDGE_DB.prepare(`UPDATE devday_judge_evidence_manifests SET complete = 1 WHERE ${generation} AND sha256 = ? AND complete = 0 AND ${lease} AND (SELECT COUNT(*) FROM devday_judge_evidence_chunks WHERE ${generation}) = chunk_count AND (SELECT SUM(length(content)) FROM devday_judge_evidence_chunks WHERE ${generation}) = byte_count`).bind(...key, hash, ...key, row.pinned_sha, ...key, ...key));
  await env.JUDGE_DB.batch(statements);
  await requireStoredEvidenceSnapshot(snapshot, row, env);
}
