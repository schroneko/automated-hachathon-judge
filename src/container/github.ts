import { MAX_EVIDENCE_FILES, MAX_EVIDENCE_FILE_BYTES, MAX_EVIDENCE_TOTAL_BYTES, MAX_SNAPSHOT_SERIALIZED_BYTES } from "../shared/constants";
import { buildZeroScoreResult } from "../shared/scoring";
import type { NormalizedRepo, RepoAssessmentKind, RepoEvidenceSnapshot, RepoResolution } from "../shared/types";
import { parseUploadPackResponse, type GitPackObject } from "./git-pack";

const GITHUB_PUBLIC_BASE = "https://github.com";
const EVIDENCE_TIMEOUT_MS = 45_000;
const ACQUISITION_WAIT_TIMEOUT_MS = 120_000;
const ACQUISITION_POLL_MS = 50;
const MAX_REFS_BYTES = 256_000;
const MAX_WIRE_BYTES = 16 * 1024 * 1024;
const BLOB_BATCH_SIZE = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const provenance = "固定コミットのGit追跡ソース全文を評価。";
type EvidenceSignal = AbortSignal & { evidenceDeadline: number };
let nextAcquisitionTicket = 0;
let acquisitionOwner = 0;
let acquisitionDeadline = 0;
const acquisitionQueue = new Map<number, number>();

export class RetryableGithubError extends Error {}

export async function resolveRepoAuthority(repo: NormalizedRepo, summary: string): Promise<RepoResolution> {
  validateRepoIdentity(repo);
  return withEvidenceDeadline(async (signal) => authorityResolution(await fetchPublicRefs(repo, signal), summary));
}

export async function resolveRepoEvidence(repo: NormalizedRepo, summary: string): Promise<RepoEvidenceSnapshot> {
  validateRepoIdentity(repo);
  return withAcquisition(async (signal) => {
    const refs = await fetchPublicRefs(repo, signal);
    const authority = authorityResolution(refs, summary);
    if (authority.pinnedSha === null || authority.defaultBranch === null) return checkedSnapshot({ repo, ...authority, files: [] });
    requireCapabilities(refs);
    return fetchPinnedEvidence(repo, authority.pinnedSha, authority.defaultBranch, summary, signal);
  });
}

export async function fetchRepoEvidence(repo: NormalizedRepo, pinnedSha: string, defaultBranch: string, summary: string): Promise<RepoEvidenceSnapshot> {
  validateRepoIdentity(repo);
  if (!/^[0-9a-f]{40}$/.test(pinnedSha) || !isValidBranch(defaultBranch)) throw new Error("Invalid pinned repository authority");
  return withAcquisition(async (signal) => {
    const refs = await fetchPublicRefs(repo, signal);
    if (!refs) return checkedSnapshot({ repo, ...authorityResolution(null, summary), files: [] });
    requireCapabilities(refs);
    return fetchPinnedEvidence(repo, pinnedSha, defaultBranch, summary, signal);
  });
}

function authorityResolution(refs: PublicRefs | null, summary: string): RepoResolution & { assessment: RepoEvidenceSnapshot["assessment"] } {
  if (refs?.kind === "found") return { assessment: "scored", pinnedSha: refs.sha, defaultBranch: refs.branch, summary };
  return {
    assessment: !refs ? "missing_or_private" : refs.kind === "empty" ? "empty_repository" : "no_default_branch",
    pinnedSha: null, defaultBranch: null, summary
  };
}

function requireCapabilities(refs: PublicRefs | null): void {
  if (!refs || ["filter", "shallow", "ofs-delta", "no-progress"].some((capability) => !refs.capabilities.includes(capability))) {
    throw new Error("GitHub public refs does not support required partial-clone capabilities");
  }
}

async function fetchPinnedEvidence(repo: NormalizedRepo, pinnedSha: string, defaultBranch: string, summary: string, signal: EvidenceSignal): Promise<RepoEvidenceSnapshot> {
  const initial = await uploadPack(repo, [pinnedSha], true, signal);
  checkDeadline(signal);
  const { candidates, entryCount } = enumerateSource(initial, pinnedSha, signal);
  initial.clear();
  if (candidates.length > MAX_EVIDENCE_FILES) throw new Error("GitHub evidence exceeds candidate file capacity");
  const snapshot: RepoEvidenceSnapshot = {
    repo, pinnedSha, defaultBranch, summary: `${summary} ${provenance}`, assessment: "scored", files: [], fullSource: true
  };
  if (entryCount === 0) {
    snapshot.assessment = "empty_repository";
    snapshot.summary = `ファイルが存在しない空のリポジトリです。 ${provenance}`;
    return checkedSnapshot(snapshot);
  }
  const pathsByOid = new Map<string, string[]>();
  for (const candidate of candidates) {
    const paths = pathsByOid.get(candidate.oid) ?? [];
    paths.push(candidate.path);
    pathsByOid.set(candidate.oid, paths);
  }
  const wants = [...pathsByOid.keys()];
  let totalBytes = 0;
  for (let offset = 0; offset < wants.length; offset += BLOB_BATCH_SIZE) {
    checkDeadline(signal);
    const batch = wants.slice(offset, offset + BLOB_BATCH_SIZE);
    const objects = await uploadPack(repo, batch, false, signal);
    checkDeadline(signal);
    if (objects.size !== batch.length || [...objects].some(([oid, object]) => !batch.includes(oid) || object.oid !== oid || object.type !== "blob")) {
      throw new Error("GitHub upload-pack returned unexpected blob objects");
    }
    for (const oid of batch) {
      checkDeadline(signal);
      const blob = objects.get(oid);
      if (!blob || blob.type !== "blob" || blob.oid !== oid) throw new Error("GitHub upload-pack omitted a requested blob");
      const paths = pathsByOid.get(oid)!;
      if (blob.data.includes(0)) continue;
      let content: string;
      try {
        content = decoder.decode(blob.data);
      } catch {
        continue;
      }
      if (blob.data.byteLength > MAX_EVIDENCE_FILE_BYTES) throw new Error("GitHub evidence file exceeds byte capacity");
      if (snapshot.files.length + paths.length > MAX_EVIDENCE_FILES) throw new Error("GitHub evidence exceeds file capacity");
      totalBytes += blob.data.byteLength * paths.length;
      if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) throw new Error("GitHub evidence exceeds total byte capacity");
      for (const path of paths) snapshot.files.push({ path, content, size: blob.data.byteLength, truncated: false });
    }
    objects.clear();
  }
  if (snapshot.files.length === 0) throw new Error("Pinned repository has no readable source evidence");
  snapshot.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  checkDeadline(signal);
  const result = checkedSnapshot(snapshot);
  checkDeadline(signal);
  return result;
}

function checkedSnapshot(snapshot: RepoEvidenceSnapshot): RepoEvidenceSnapshot {
  let bytes = encoder.encode(JSON.stringify({ ...snapshot, files: [] })).byteLength;
  const check = () => {
    if (bytes > MAX_SNAPSHOT_SERIALIZED_BYTES) throw new Error("GitHub evidence snapshot exceeds serialized byte capacity");
  };
  check();
  for (const [index, file] of snapshot.files.entries()) {
    bytes += encoder.encode(JSON.stringify({ ...file, content: "" })).byteLength + (index ? 1 : 0);
    check();
    for (let offset = 0; offset < file.content.length; offset++) {
      const code = file.content.charCodeAt(offset);
      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) bytes += 2;
      else if (code < 32) bytes += 6;
      else if (code < 128) bytes++;
      else if (code < 2048) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && file.content.charCodeAt(offset + 1) >= 0xdc00 && file.content.charCodeAt(offset + 1) <= 0xdfff) {
        bytes += 4;
        offset++;
      } else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
      check();
    }
  }
  return snapshot;
}

async function uploadPack(repo: NormalizedRepo, wants: string[], filtered: boolean, signal: EvidenceSignal): Promise<Map<string, GitPackObject>> {
  const packets = wants.map((oid, index) => packet(`want ${oid}${index === 0 ? ` no-progress ofs-delta${filtered ? " filter" : ""}` : ""}\n`));
  if (filtered) packets.push(packet("deepen 1\n"), packet("filter blob:none\n"));
  packets.push(encoder.encode("0000"), packet("done\n"));
  const body = new Uint8Array(packets.reduce((length, bytes) => length + bytes.length, 0));
  let offset = 0;
  for (const bytes of packets) {
    body.set(bytes, offset);
    offset += bytes.length;
  }
  const url = `${GITHUB_PUBLIC_BASE}/${repo.owner}/${repo.repo}.git/git-upload-pack`;
  const response = await publicRequest(url, signal, {
    method: "POST", headers: { "content-type": "application/x-git-upload-pack-request", accept: "application/x-git-upload-pack-result" }, body
  });
  try {
    assertCanonicalResponse(response, url, "GitHub upload-pack");
    if (isRetryableStatus(response.status)) throw new RetryableGithubError(`GitHub upload-pack failed with status ${response.status}`);
    if (response.status !== 200) throw new Error(`Pinned GitHub upload-pack failed with status ${response.status}`);
    assertMime(response, "application/x-git-upload-pack-result", "GitHub upload-pack");
    const bytes = await readBoundedBytes(response, MAX_WIRE_BYTES, signal, "GitHub upload-pack");
    checkDeadline(signal);
    const objects = parseUploadPackResponse(bytes, signal);
    checkDeadline(signal);
    return objects;
  } finally {
    cancelBody(response);
  }
}

function packet(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const header = encoder.encode((bytes.length + 4).toString(16).padStart(4, "0"));
  const result = new Uint8Array(bytes.length + 4);
  result.set(header);
  result.set(bytes, 4);
  return result;
}

function enumerateSource(objects: Map<string, GitPackObject>, pinnedSha: string, signal: EvidenceSignal): { candidates: { path: string; oid: string }[]; entryCount: number } {
  const commit = objects.get(pinnedSha);
  if (commit?.type !== "commit" || commit.oid !== pinnedSha) throw new Error("GitHub upload-pack omitted the requested pinned commit");
  const root = /^tree ([0-9a-f]{40})\n$/.exec(String.fromCharCode(...commit.data.subarray(0, 46)))?.[1];
  if (!root) throw new Error("Pinned Git commit has an invalid root tree");
  const candidates: { path: string; oid: string }[] = [];
  const reachable = new Set<string>([pinnedSha]);
  const stack = new Set<string>();
  const paths = new Set<string>();
  let entryCount = 0;
  let pathBytes = 0;
  const walk = (oid: string, prefix: string, depth: number) => {
    checkDeadline(signal);
    if (depth > 64 || stack.has(oid)) throw new Error("Git tree exceeds depth capacity or has a cycle");
    const tree = objects.get(oid);
    if (tree?.type !== "tree" || tree.oid !== oid) throw new Error("GitHub upload-pack omitted a referenced tree");
    reachable.add(oid);
    stack.add(oid);
    let offset = 0;
    while (offset < tree.data.length) {
      checkDeadline(signal);
      if (++entryCount > 50_000) throw new Error("Git tree exceeds entry capacity");
      const space = tree.data.indexOf(32, offset);
      const nul = tree.data.indexOf(0, space + 1);
      if (space <= offset || space - offset > 6 || nul <= space || nul + 21 > tree.data.length) throw new Error("Git tree has a malformed entry");
      if (nul - space - 1 > 1024) throw new Error("Git tree path exceeds byte capacity");
      const mode = String.fromCharCode(...tree.data.subarray(offset, space));
      let name: string;
      try {
        name = decoder.decode(tree.data.subarray(space + 1, nul));
      } catch {
        throw new Error("Git tree has an invalid UTF-8 path");
      }
      if (!name || name === "." || name === ".." || /[\\/:\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(name)
        || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error("Git tree has an unsafe path");
      const path = prefix ? `${prefix}/${name}` : name;
      const pathLength = encoder.encode(path).byteLength;
      if (pathLength > 1024) throw new Error("Git tree path exceeds byte capacity");
      pathBytes += pathLength;
      if (pathBytes > 8 * 1024 * 1024) throw new Error("Git tree metadata exceeds byte capacity");
      if (paths.has(path)) throw new Error("Git tree has a duplicate path");
      paths.add(path);
      const childOid = Array.from(tree.data.subarray(nul + 1, nul + 21), (byte) => byte.toString(16).padStart(2, "0")).join("");
      offset = nul + 21;
      if (mode === "40000") walk(childOid, path, depth + 1);
      else if (mode === "100644" || mode === "100755") {
        if (isEvidencePath(path)) candidates.push({ path, oid: childOid });
      } else if (mode !== "120000" && mode !== "160000") throw new Error("Git tree has an unsupported mode");
    }
    stack.delete(oid);
  };
  walk(root, "", 0);
  if ([...objects].some(([oid, object]) => !reachable.has(oid) || (oid !== pinnedSha && object.type !== "tree"))) {
    throw new Error("Filtered Git pack contains blobs or unreachable objects");
  }
  return { candidates, entryCount };
}

function isEvidencePath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts[parts.length - 1]!;
  if (parts.slice(0, -1).some((part) => /^(?:node_modules|vendor|\.venv|venv|site-packages|dist|build|target|coverage|\.git|\.next|\.nuxt|generated|__generated__|cache|\.cache|__pycache__|\.ssh|\.aws|\.azure)$/.test(part))) return false;
  if (/^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|cargo\.lock|go\.sum|gemfile\.lock|composer\.lock|poetry\.lock|pipfile\.lock|uv\.lock|pdm\.lock|packages\.lock\.json|flake\.lock|mix\.lock|pubspec\.lock|gradle\.lockfile|.*\.lock)$/.test(name)) return false;
  if (/^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|_netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/.test(name)) return false;
  if (/^(?:.*credentials?(?:[._-].*)?|.*private[._-]?key(?:\..*)?|service[._-]?account(?:[._-].*)?|\.?secrets?(?:\..*)?)$/.test(name)
    && !/\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|rb|kt|kts|swift|c|h|cc|cpp|hpp|vue|svelte|php|sh|bash|zsh|fish|ps1|sql)$/.test(name)) return false;
  if (/\.(?:js|mjs|cjs|jsx|ts|tsx|css)\.map$/.test(name)) return false;
  if (/\.(?:svgz?|png|apng|jpe?g|jxl|gif|webp|avif|bmp|tiff?|ico|icns|cur|heic|heif|psd|tga|dds|ktx2?|exr|hdr|pdf|woff2?|ttf|ttc|otf|eot|sfnt|mp[234]|m4[av]|aac|ogg|oga|ogv|opus|flac|wav|aiff?|midi?|mov|avi|mkv|webm|mpeg|mpg|flv|wmv|3gp|3g2|gltf|glb|obj|mtl|stl|fbx|blend|dae|ply|3ds|usda?|usdc|usdz|onnx|safetensors|gguf|ggml|ckpt|tflite|zip|gz|tgz|bz2|xz|zst|7z|rar|tar|jar|war|wasm|exe|dll|so|dylib|bin|o|a|lib|class|pyc|pyo|db|sqlite3?|p12|pfx|pem|key|crt|cer|der|jks|keystore)$/.test(name)) return false;
  return true;
}

export function zeroResultForAssessment(snapshot: RepoEvidenceSnapshot) {
  const reasons: Record<Exclude<RepoAssessmentKind, "scored" | "retryable_failure">, string> = {
    empty_repository: "空のリポジトリのため評価材料がありません。",
    missing_or_private: "公開リポジトリが見つからないか、非公開のため評価できません。",
    no_default_branch: "デフォルトブランチを解決できず評価材料を固定できませんでした。",
    unjudgeable: "ジャッジ不能です。"
  };
  const assessment = snapshot.assessment === "scored" ? "unjudgeable" : snapshot.assessment;
  return buildZeroScoreResult({ summary: snapshot.summary, publicReason: reasons[assessment], repoAssessment: assessment, pinnedSha: snapshot.pinnedSha });
}

type PublicRefs = ({ kind: "found"; branch: string; sha: string } | { kind: "empty" } | { kind: "no_default_branch" }) & { capabilities: string[] };

async function fetchPublicRefs(repo: NormalizedRepo, signal: EvidenceSignal): Promise<PublicRefs | null> {
  const url = `${GITHUB_PUBLIC_BASE}/${repo.owner}/${repo.repo}.git/info/refs?service=git-upload-pack`;
  const response = await publicRequest(url, signal, { method: "GET", headers: { accept: "application/x-git-upload-pack-advertisement" } });
  try {
    assertCanonicalResponse(response, url, "GitHub public refs");
    if ([401, 403, 404].includes(response.status)) return null;
    if (isRetryableStatus(response.status)) throw new RetryableGithubError(`GitHub public refs failed with status ${response.status}`);
    if (response.status !== 200) throw new Error(`GitHub public refs failed with status ${response.status}`);
    assertMime(response, "application/x-git-upload-pack-advertisement", "GitHub public refs");
    const bytes = await readBoundedBytes(response, MAX_REFS_BYTES, signal, "GitHub public refs");
    checkDeadline(signal);
    return parsePublicRefs(bytes);
  } finally {
    cancelBody(response);
  }
}

function parsePublicRefs(bytes: Uint8Array): PublicRefs {
  let offset = 0;
  const packet = (): string | null => {
    if (offset + 4 > bytes.length) throw new Error("GitHub public refs has a truncated packet length");
    const header = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error("GitHub public refs has an invalid packet length");
    const length = Number.parseInt(header, 16);
    offset += 4;
    if (length === 0) return null;
    if (length < 4 || offset + length - 4 > bytes.length) throw new Error("GitHub public refs has a truncated packet");
    let value: string;
    try {
      value = decoder.decode(bytes.subarray(offset, offset + length - 4));
    } catch {
      throw new Error("GitHub public refs has invalid UTF-8");
    }
    offset += length - 4;
    return value;
  };
  if (packet() !== "# service=git-upload-pack\n" || packet() !== null) throw new Error("GitHub public refs has an invalid service advertisement");
  const first = packet();
  const match = first === null ? null : /^([0-9a-f]{40}) (HEAD|capabilities\^\{\})\0([^\n\0]+)\n$/.exec(first);
  const headSha = match?.[1];
  const headName = match?.[2];
  const capabilityText = match?.[3];
  if (!headSha || !headName || !capabilityText) throw new Error("GitHub public refs has an invalid HEAD advertisement");
  const capabilities = capabilityText.split(" ");
  if (capabilities.some((value) => !value || !/^[\x21-\x7e]+$/.test(value)) || new Set(capabilities).size !== capabilities.length) throw new Error("GitHub public refs has invalid capabilities");
  const refs = new Map<string, string>();
  while (true) {
    const entry = packet();
    if (entry === null) break;
    const ref = /^([0-9a-f]{40}) ([^\n\0 ]+)\n$/.exec(entry);
    const refSha = ref?.[1];
    const refName = ref?.[2];
    if (!refSha || !refName || refs.has(refName) || refSha === "0".repeat(40) || !validAdvertisedRef(refName)) throw new Error("GitHub public refs has an invalid ref advertisement");
    refs.set(refName, refSha);
  }
  if (offset !== bytes.length) throw new Error("GitHub public refs has trailing garbage");
  if (headName === "capabilities^{}") {
    if (headSha !== "0".repeat(40) || refs.size !== 0) throw new Error("GitHub public refs has an invalid empty repository advertisement");
    return { kind: "empty", capabilities };
  }
  if (headSha === "0".repeat(40)) throw new Error("GitHub public refs has an invalid HEAD SHA");
  const symrefs = capabilities.filter((value) => value.startsWith("symref=HEAD:"));
  if (symrefs.length === 0) return { kind: "no_default_branch", capabilities };
  const symref = symrefs[0];
  if (!symref || symrefs.length !== 1 || !symref.startsWith("symref=HEAD:refs/heads/")) throw new Error("GitHub public refs has an invalid HEAD symref");
  const branch = symref.slice("symref=HEAD:refs/heads/".length);
  if (!isValidBranch(branch)) throw new Error("GitHub public refs has an invalid HEAD symref");
  if (refs.get(`refs/heads/${branch}`) !== headSha) throw new Error("GitHub public refs HEAD SHA does not match its default branch ref");
  return { kind: "found", branch, sha: headSha, capabilities };
}

function validAdvertisedRef(ref: string): boolean {
  const name = ref.endsWith("^{}") ? ref.slice(0, -3) : ref;
  return name.startsWith("refs/") && isValidBranch(name);
}

function isValidBranch(branch: string): boolean {
  return typeof branch === "string" && branch.length > 0 && branch !== "@" && !branch.startsWith("/") && !branch.endsWith("/")
    && !branch.endsWith(".") && !branch.includes("..") && !branch.includes("//") && !branch.includes("@{")
    && !/[\x00-\x20\x7f~^:?*[\\]/.test(branch)
    && branch.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

function validateRepoIdentity(repo: NormalizedRepo): void {
  if (!repo || !/^[A-Za-z0-9_.-]+$/.test(repo.owner) || !/^[A-Za-z0-9_.-]+$/.test(repo.repo)
    || repo.owner === "." || repo.owner === ".." || repo.repo === "." || repo.repo === ".."
    || repo.normalized !== `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`
    || repo.canonicalUrl !== `https://github.com/${repo.owner}/${repo.repo}`) throw new Error("Invalid canonical repository identity");
}

function assertCanonicalResponse(response: Response, url: string, source: string): void {
  if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) throw new Error(`${source} redirected from canonical repository`);
}

function assertMime(response: Response, mime: string, source: string): void {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== mime) throw new Error(`${source} returned an unexpected content type`);
}

function cancelBody(response: Response): void {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
}

async function publicRequest(url: string, signal: EvidenceSignal, init: RequestInit): Promise<Response> {
  checkDeadline(signal);
  const request = fetch(url, { ...init, redirect: "manual", credentials: "omit", signal });
  void request.then((response) => { if (signal.aborted) cancelBody(response); }, () => undefined);
  const response = await abortable(request, signal);
  checkDeadline(signal);
  return response;
}

async function readBoundedBytes(response: Response, limit: number, signal: EvidenceSignal, source: string): Promise<Uint8Array> {
  const statedLength = response.headers.get("content-length");
  if (statedLength !== null && (!/^\d+$/.test(statedLength) || !Number.isSafeInteger(Number(statedLength)))) throw new Error(`${source} has an invalid content length`);
  if (statedLength !== null && Number(statedLength) > limit) throw new Error(`${source} exceeds ${limit} bytes`);
  if (!response.body) throw new Error(`${source} has no response body`);
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      checkDeadline(signal);
      const part = await abortable(reader.read(), signal);
      checkDeadline(signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new Error(`${source} exceeds ${limit} bytes`);
      chunks.push(part.value);
    }
    if (statedLength !== null && Number(statedLength) !== length) throw new Error(`${source} content length does not match its body`);
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function abortable<T>(operation: Promise<T>, signal: EvidenceSignal): Promise<T> {
  checkDeadline(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new RetryableGithubError("GitHub evidence collection timed out"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function checkDeadline(signal: EvidenceSignal): void {
  if (signal.aborted || Date.now() >= signal.evidenceDeadline) throw new RetryableGithubError("GitHub evidence collection timed out");
}

async function withEvidenceDeadline<T>(operation: (signal: EvidenceSignal) => Promise<T>, deadline = Date.now() + EVIDENCE_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const signal = Object.assign(controller.signal, { evidenceDeadline: deadline });
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  try {
    checkDeadline(signal);
    const result = await abortable(operation(signal), signal);
    checkDeadline(signal);
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new RetryableGithubError("GitHub evidence collection timed out");
    if (error instanceof TypeError) throw new RetryableGithubError("GitHub evidence collection request failed");
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function withAcquisition<T>(operation: (signal: EvidenceSignal) => Promise<T>): Promise<T> {
  const { ticket, deadline } = await acquire();
  try {
    return await withEvidenceDeadline(operation, deadline);
  } finally {
    if (acquisitionOwner === ticket) {
      acquisitionOwner = 0;
      acquisitionDeadline = 0;
    }
  }
}

async function acquire(): Promise<{ ticket: number; deadline: number }> {
  const ticket = ++nextAcquisitionTicket;
  const waitDeadline = Date.now() + ACQUISITION_WAIT_TIMEOUT_MS;
  acquisitionQueue.set(ticket, waitDeadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      const now = Date.now();
      for (const [queued, deadline] of acquisitionQueue) {
        if (now >= deadline) acquisitionQueue.delete(queued);
      }
      if (now >= waitDeadline) throw new RetryableGithubError("GitHub source acquisition admission timed out");
      if (acquisitionOwner !== 0 && now >= acquisitionDeadline) {
        acquisitionOwner = 0;
        acquisitionDeadline = 0;
      }
      if (acquisitionOwner === 0 && acquisitionQueue.keys().next().value === ticket) {
        acquisitionQueue.delete(ticket);
        acquisitionOwner = ticket;
        acquisitionDeadline = now + EVIDENCE_TIMEOUT_MS;
        return { ticket, deadline: acquisitionDeadline };
      }
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(ACQUISITION_POLL_MS, waitDeadline - now));
      });
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    acquisitionQueue.delete(ticket);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}
