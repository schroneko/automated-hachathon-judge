import { MAX_EVIDENCE_FILE_BYTES, MAX_EVIDENCE_FILES, MAX_EVIDENCE_TOTAL_BYTES } from "../shared/constants";
import { buildZeroScoreResult } from "../shared/scoring";
import type { NormalizedRepo, RepoAssessmentKind, RepoEvidenceFile, RepoEvidenceSnapshot } from "../shared/types";

const GITHUB_API_BASE = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";

export class RetryableGithubError extends Error {}

export async function fetchRepoEvidence(repo: NormalizedRepo, pinnedSha: string, defaultBranch: string, summary: string): Promise<RepoEvidenceSnapshot> {
  const treeResponse = await githubJson<GitHubTreeResponse>(
    `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/git/trees/${pinnedSha}?recursive=1`
  );
  if (treeResponse.kind === "missing") {
    throw new Error("Pinned GitHub tree was not found");
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
  const files = await fetchEvidenceFiles(repo, pinnedSha, selected);

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
  files: GitHubTreeEntry[]
): Promise<RepoEvidenceFile[]> {
  const results: RepoEvidenceFile[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (totalBytes >= MAX_EVIDENCE_TOTAL_BYTES) {
      break;
    }
    const response = await fetch(`${RAW_BASE}/${repo.owner}/${repo.repo}/${sha}/${file.path}`, {
      headers: githubHeaders()
    });
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
    const text = await response.text();
    const clipped = text.slice(0, MAX_EVIDENCE_FILE_BYTES);
    const bytes = new TextEncoder().encode(clipped).length;
    if (bytes === 0) {
      continue;
    }
    totalBytes += bytes;
    results.push({
      path: file.path,
      size: bytes,
      content: clipped,
      truncated: text.length > clipped.length
    });
  }

  return results;
}

function selectEvidenceFiles(entries: GitHubTreeEntry[]): GitHubTreeEntry[] {
  return [...entries]
    .filter((entry) => (entry.size ?? 0) <= MAX_EVIDENCE_FILE_BYTES * 4)
    .sort((left, right) => scorePath(right.path) - scorePath(left.path))
    .slice(0, MAX_EVIDENCE_FILES);
}

function scorePath(path: string): number {
  const lower = path.toLowerCase();
  let score = 0;
  if (lower === "readme.md" || lower.endsWith("/readme.md")) score += 100;
  if (lower.endsWith("package.json")) score += 90;
  if (lower.includes("wrangler")) score += 80;
  if (lower.includes("vite.config")) score += 75;
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".js") || lower.endsWith(".jsx")) score += 60;
  if (lower.endsWith(".html") || lower.endsWith(".css") || lower.endsWith(".scss")) score += 55;
  if (lower.includes("src/")) score += 45;
  if (lower.includes("app/")) score += 40;
  if (lower.includes("pages/")) score += 35;
  if (lower.includes("components/")) score += 30;
  if (lower.includes("public/")) score += 20;
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".svg")) score -= 30;
  if (lower.includes("node_modules/")) score -= 1000;
  return score;
}

async function githubJson<T>(url: string): Promise<{ kind: "ok"; data: T } | { kind: "missing" }> {
  const response = await fetch(url, { headers: githubHeaders() });
  if (response.status === 404 || response.status === 409) {
    return { kind: "missing" };
  }
  if (isRetryableStatus(response.status)) {
    throw new RetryableGithubError(`GitHub API failed with status ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`GitHub API failed with status ${response.status}`);
  }
  return {
    kind: "ok",
    data: (await response.json()) as T
  };
}

function githubHeaders(): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "hackathon-nukoevi-app"
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

function isProbablyText(contentType: string, path: string): boolean {
  const lower = contentType.toLowerCase();
  if (lower.startsWith("text/")) return true;
  if (lower.includes("json") || lower.includes("javascript") || lower.includes("xml")) return true;
  return /\.(md|txt|ts|tsx|js|jsx|json|css|scss|html|toml|yaml|yml|svg)$/i.test(path);
}

interface GitHubTreeResponse {
  tree: GitHubTreeEntry[];
}

interface GitHubTreeEntry {
  path: string;
  type: string;
  size?: number;
}
