import { MAX_EVIDENCE_FILE_BYTES, MAX_EVIDENCE_FILES, MAX_EVIDENCE_TOTAL_BYTES } from "../shared/constants";
import { buildZeroScoreResult } from "../shared/scoring";
import type { NormalizedRepo, RepoAssessmentKind, RepoEvidenceFile, RepoEvidenceSnapshot, RepoResolution } from "../shared/types";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_PUBLIC_BASE = "https://github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const EVIDENCE_TIMEOUT_MS = 45_000;
const MAX_REFS_BYTES = 256_000;
const MAX_TREE_BYTES = 2_000_000;

export class RetryableGithubError extends Error {}

export async function resolveRepoAuthority(repo: NormalizedRepo, summary: string): Promise<RepoResolution> {
  validateRepoIdentity(repo);
  return withEvidenceDeadline(async (signal) => resolvePublicAuthority(repo, summary, signal));
}

export async function resolveRepoEvidence(repo: NormalizedRepo, summary: string): Promise<RepoEvidenceSnapshot> {
  validateRepoIdentity(repo);
  return withEvidenceDeadline(async (signal) => resolvePublicEvidence(repo, summary, signal));
}

async function resolvePublicAuthority(repo: NormalizedRepo, summary: string, signal: AbortSignal): Promise<RepoResolution & { assessment: RepoEvidenceSnapshot["assessment"] }> {
  const authority = await fetchPublicRefs(repo, signal);
  if (authority?.kind === "found") {
    return { assessment: "scored", pinnedSha: authority.sha, defaultBranch: authority.branch, summary };
  }
  return {
    assessment: !authority ? "missing_or_private" : authority.kind === "empty" ? "empty_repository" : "no_default_branch",
    pinnedSha: null,
    defaultBranch: null,
    summary
  };
}

async function resolvePublicEvidence(repo: NormalizedRepo, summary: string, signal: AbortSignal): Promise<RepoEvidenceSnapshot> {
  const authority = await resolvePublicAuthority(repo, summary, signal);
  if (authority.pinnedSha === null || authority.defaultBranch === null) {
    return { repo, ...authority, files: [] };
  }
  return fetchPinnedEvidence(repo, authority.pinnedSha, authority.defaultBranch, authority.summary, signal);
}

export async function fetchRepoEvidence(repo: NormalizedRepo, pinnedSha: string, defaultBranch: string, summary: string): Promise<RepoEvidenceSnapshot> {
  validateRepoIdentity(repo);
  if (!/^[0-9a-f]{40}$/.test(pinnedSha) || !isValidBranch(defaultBranch)) {
    throw new Error("Invalid pinned repository authority");
  }
  return withEvidenceDeadline(async (signal) => {
    const authority = await fetchPublicRefs(repo, signal);
    if (!authority) {
      return missingSnapshot(repo, summary, "missing_or_private");
    }
    return fetchPinnedEvidence(repo, pinnedSha, defaultBranch, summary, signal);
  });
}

async function fetchPinnedEvidence(repo: NormalizedRepo, pinnedSha: string, defaultBranch: string, summary: string, signal: AbortSignal): Promise<RepoEvidenceSnapshot> {
  const treeResponse = await githubJson<GitHubTreeResponse>(
    `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/git/trees/${pinnedSha}?recursive=1`,
    signal
  );
  if (treeResponse.kind === "missing") {
    throw new Error("Pinned GitHub tree was not found");
  }
  if (treeResponse.data.truncated === true || !Array.isArray(treeResponse.data.tree)) {
    throw new Error("Pinned GitHub tree is truncated or malformed");
  }

  const blobs = treeResponse.data.tree.filter((item) => item.type === "blob");
  if (blobs.length === 0) {
    return {
      repo,
      pinnedSha,
      defaultBranch,
      summary: "ファイルが存在しない空のリポジトリです。",
      assessment: "empty_repository",
      files: []
    };
  }

  const selected = selectEvidenceFiles(blobs);
  const files = await fetchEvidenceFiles(repo, pinnedSha, selected, signal);
  if (files.length === 0) {
    throw new Error("Pinned repository has no readable source evidence");
  }

  return {
    repo,
    pinnedSha,
    defaultBranch,
    summary,
    assessment: "scored",
    files
  };
}

export function zeroResultForAssessment(snapshot: RepoEvidenceSnapshot) {
  const reasons: Record<Exclude<RepoAssessmentKind, "scored" | "retryable_failure">, string> = {
    empty_repository: "空のリポジトリのため評価材料がありません。",
    missing_or_private: "公開リポジトリが見つからないか、非公開のため評価できません。",
    no_default_branch: "デフォルトブランチを解決できず評価材料を固定できませんでした。",
    unjudgeable: "ジャッジ不能です。"
  };
  const assessment = snapshot.assessment === "scored" ? "unjudgeable" : snapshot.assessment;
  return buildZeroScoreResult({
    summary: snapshot.summary,
    publicReason: reasons[assessment],
    repoAssessment: assessment,
    pinnedSha: snapshot.pinnedSha
  });
}

async function fetchEvidenceFiles(
  repo: NormalizedRepo,
  sha: string,
  files: GitHubTreeEntry[],
  signal: AbortSignal
): Promise<RepoEvidenceFile[]> {
  const results: RepoEvidenceFile[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (totalBytes >= MAX_EVIDENCE_TOTAL_BYTES) {
      break;
    }
    const url = `${RAW_BASE}/${repo.owner}/${repo.repo}/${sha}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url, {
      headers: { "user-agent": "automated-hachathon-judge" },
      redirect: "manual",
      signal
    });
    assertCanonicalResponse(response, url, "GitHub raw");
    if (!response.ok) {
      if (isRetryableStatus(response.status)) {
        throw new RetryableGithubError(`GitHub raw fetch failed with status ${response.status}`);
      }
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!isProbablyText(contentType, file.path)) {
      continue;
    }
    const limit = Math.min(MAX_EVIDENCE_FILE_BYTES, MAX_EVIDENCE_TOTAL_BYTES - totalBytes);
    const content = await readBoundedText(response, limit, signal);
    if (!content) {
      continue;
    }
    const { text: clipped, bytes, truncated } = content;
    if (bytes === 0) {
      continue;
    }
    totalBytes += bytes;
    results.push({
      path: file.path,
      size: bytes,
      content: clipped,
      truncated: truncated || (file.size !== undefined && file.size > bytes)
    });
  }

  return results;
}

function selectEvidenceFiles(entries: GitHubTreeEntry[]): GitHubTreeEntry[] {
  return [...entries]
    .filter((entry) => isEvidencePath(entry.path))
    .sort((left, right) => scorePath(right.path) - scorePath(left.path) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .slice(0, MAX_EVIDENCE_FILES);
}

function scorePath(path: string): number {
  const lower = path.toLowerCase();
  let score = 0;
  if (/^readme(?:\.[a-z0-9_-]+)?\.md$/.test(lower)) score += 1000;
  else if (/\/readme(?:\.[a-z0-9_-]+)?\.md$/.test(lower)) score += 500;
  if (/(^|\/)(package\.json|cargo\.toml|go\.mod|gemfile|composer\.json|pyproject\.toml|requirements\.txt|pom\.xml|build\.gradle(?:\.kts)?)$/.test(lower)) score += 400;
  if (lower.includes("wrangler")) score += 350;
  if (lower.includes("vite.config")) score += 300;
  if (/\.(ts|tsx|js|jsx|py|rs|go|java|cs|rb|kt|kts|swift|c|h|cc|cpp|hpp|vue|svelte|php)$/.test(lower)) score += 60;
  if (/\.(html|css|scss)$/.test(lower)) score += 55;
  if (lower.includes("src/")) score += 45;
  if (lower.includes("app/")) score += 40;
  if (lower.includes("pages/")) score += 35;
  if (lower.includes("components/")) score += 30;
  if (lower.includes("public/")) score += 20;
  return score;
}

function isEvidencePath(path: string): boolean {
  const lower = path.toLowerCase();
  if (/(^|\/)(node_modules|vendor|dist|build|target|coverage|\.git|\.next|\.nuxt|generated|__generated__)(\/|$)/.test(lower)) return false;
  if (/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|cargo\.lock|go\.sum|gemfile\.lock|composer\.lock)$/.test(lower)) return false;
  if (/(^|\/)[^/]*(?:\.generated\.|\.min\.(?:js|css)$)/.test(lower)) return false;
  if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|wasm|exe|dll|so|dylib|woff2?|ttf|otf|mp[34]|mov|bin|lock)$/.test(lower)) return false;
  return /(^|\/)readme(?:\.[a-z0-9_-]+)?\.md$|(^|\/)(package\.json|cargo\.toml|go\.mod|gemfile|composer\.json|pyproject\.toml|requirements\.txt|pom\.xml|build\.gradle(?:\.kts)?|wrangler\.(?:toml|jsonc?))$|\.(md|txt|ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|toml|yaml|yml|xml|py|rs|go|java|cs|rb|kt|kts|swift|c|h|cc|cpp|hpp|vue|svelte|php)$/.test(lower);
}

async function readBoundedText(response: Response, limit: number, signal: AbortSignal): Promise<{ text: string; bytes: number; truncated: boolean } | null> {
  if (!response.body || limit <= 0) return null;
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  let exceeded = false;
  try {
    while (length <= limit) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      const remaining = limit + 1 - length;
      const chunk = part.value.subarray(0, remaining);
      chunks.push(chunk);
      length += chunk.byteLength;
      if (part.value.byteLength > remaining || length > limit) {
        exceeded = true;
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(length, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  if (bytes.includes(0)) return null;
  let end = bytes.length;
  while (end > 0) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
      return text ? { text, bytes: end, truncated: exceeded || end < length } : null;
    } catch {
      end -= 1;
      if (bytes.length - end > 3) return null;
    }
  }
  return null;
}

type PublicRefs = { kind: "found"; branch: string; sha: string } | { kind: "empty" } | { kind: "no_default_branch" };

async function fetchPublicRefs(repo: NormalizedRepo, signal: AbortSignal): Promise<PublicRefs | null> {
  const url = `${GITHUB_PUBLIC_BASE}/${repo.owner}/${repo.repo}.git/info/refs?service=git-upload-pack`;
  const response = await fetch(url, { redirect: "manual", signal });
  assertCanonicalResponse(response, url, "GitHub public refs");
  if (response.status === 401 || response.status === 403 || response.status === 404) return null;
  if (response.status === 429 || response.status >= 500) {
    throw new RetryableGithubError(rateLimitMessage("GitHub public refs", response));
  }
  if (!response.ok) throw new Error(`GitHub public refs failed with status ${response.status}`);
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-git-upload-pack-advertisement") {
    throw new Error("GitHub public refs returned an unexpected content type");
  }
  return parsePublicRefs(await readBoundedBytes(response, MAX_REFS_BYTES, signal, "GitHub public refs"));
}

function parsePublicRefs(bytes: Uint8Array): PublicRefs {
  let offset = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
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
  if (packet() !== "# service=git-upload-pack\n" || packet() !== null) {
    throw new Error("GitHub public refs has an invalid service advertisement");
  }
  const first = packet();
  if (first === null || first === undefined) throw new Error("GitHub public refs has no HEAD advertisement");
  const match = /^([0-9a-f]{40}) (HEAD|capabilities\^\{\})\0([^\n\0]+)\n$/.exec(first);
  const headSha = match?.[1];
  const headName = match?.[2];
  const capabilityText = match?.[3];
  if (!headSha || !headName || !capabilityText) throw new Error("GitHub public refs has an invalid HEAD advertisement");
  const capabilities = capabilityText.split(" ");
  if (capabilities.some((value) => !value)) throw new Error("GitHub public refs has invalid capabilities");
  const refs = new Map<string, string>();
  while (true) {
    const entry = packet();
    if (entry === null) break;
    const ref = /^([0-9a-f]{40}) ([^\n\0 ]+)\n$/.exec(entry);
    const refSha = ref?.[1];
    const refName = ref?.[2];
    if (!refSha || !refName || refs.has(refName)) throw new Error("GitHub public refs has an invalid ref advertisement");
    refs.set(refName, refSha);
  }
  if (offset !== bytes.length) throw new Error("GitHub public refs has trailing garbage");
  if (headName === "capabilities^{}") {
    if (headSha !== "0".repeat(40) || refs.size !== 0) throw new Error("GitHub public refs has an invalid empty repository advertisement");
    return { kind: "empty" };
  }
  if (headSha === "0".repeat(40)) throw new Error("GitHub public refs has an invalid HEAD SHA");
  const symrefs = capabilities.filter((value) => value.startsWith("symref=HEAD:"));
  if (symrefs.length === 0) return { kind: "no_default_branch" };
  const symref = symrefs[0];
  if (!symref || symrefs.length !== 1 || !symref.startsWith("symref=HEAD:refs/heads/")) {
    throw new Error("GitHub public refs has an invalid HEAD symref");
  }
  const branch = symref.slice("symref=HEAD:refs/heads/".length);
  if (!isValidBranch(branch)) throw new Error("GitHub public refs has an invalid HEAD symref");
  if (refs.get(`refs/heads/${branch}`) !== headSha) {
    throw new Error("GitHub public refs HEAD SHA does not match its default branch ref");
  }
  return { kind: "found", branch, sha: headSha };
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
    || repo.canonicalUrl !== `https://github.com/${repo.owner}/${repo.repo}`) {
    throw new Error("Invalid canonical repository identity");
  }
}

async function githubJson<T>(url: string, signal: AbortSignal): Promise<{ kind: "ok"; data: T } | { kind: "missing" }> {
  const response = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "automated-hachathon-judge" }, redirect: "manual", signal });
  assertCanonicalResponse(response, url, "GitHub API");
  if (response.status === 403 || response.status === 429 || response.status >= 500 || (!response.ok && response.headers.get("x-ratelimit-remaining") === "0")) {
    throw new RetryableGithubError(rateLimitMessage("GitHub API", response));
  }
  if (response.status === 404 || response.status === 409) {
    return { kind: "missing" };
  }
  if (!response.ok) {
    throw new Error(`GitHub API failed with status ${response.status}`);
  }
  return {
    kind: "ok",
    data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBytes(response, MAX_TREE_BYTES, signal, "GitHub tree"))) as T
  };
}

function assertCanonicalResponse(response: Response, url: string, source: string): void {
  if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) {
    throw new Error(`${source} redirected from canonical repository`);
  }
}

function rateLimitMessage(source: string, response: Response): string {
  const retryAfter = response.headers.get("retry-after");
  const reset = response.headers.get("x-ratelimit-reset");
  return `${source} failed with status ${response.status}${retryAfter ? `; retry-after=${retryAfter}` : ""}${reset ? `; x-ratelimit-reset=${reset}` : ""}`;
}

async function readBoundedBytes(response: Response, limit: number, signal: AbortSignal, source: string): Promise<Uint8Array> {
  const statedLength = response.headers.get("content-length");
  if (statedLength && /^\d+$/.test(statedLength) && Number(statedLength) > limit) throw new Error(`${source} exceeds ${limit} bytes`);
  if (!response.body) throw new Error(`${source} has no response body`);
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new Error(`${source} exceeds ${limit} bytes`);
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function withEvidenceDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let rejectTimeout: (error: Error) => void = () => undefined;
  const expired = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(new RetryableGithubError("GitHub evidence collection timed out"));
  }, EVIDENCE_TIMEOUT_MS);
  try {
    return await Promise.race([operation(controller.signal), expired]);
  } catch (error) {
    if (controller.signal.aborted) throw new RetryableGithubError("GitHub evidence collection timed out");
    if (error instanceof TypeError) throw new RetryableGithubError("GitHub evidence collection request failed");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function missingSnapshot(
  repo: NormalizedRepo,
  summary: string,
  assessment: "empty_repository" | "missing_or_private" | "no_default_branch"
): RepoEvidenceSnapshot {
  return {
    repo,
    pinnedSha: null,
    defaultBranch: null,
    summary,
    assessment,
    files: []
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

function isProbablyText(contentType: string, path: string): boolean {
  const lower = contentType.toLowerCase();
  if (lower.startsWith("text/")) return true;
  if (lower.includes("json") || lower.includes("javascript") || lower.includes("xml")) return true;
  return isEvidencePath(path);
}

interface GitHubTreeResponse {
  tree: GitHubTreeEntry[];
  truncated?: boolean;
}

interface GitHubTreeEntry {
  path: string;
  type: string;
  size?: number;
}
