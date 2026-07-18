import type { NormalizedRepo, RepoResolution } from "../shared/types";

const API = "https://api.github.com";

export async function resolveRepoAtSubmission(repo: NormalizedRepo): Promise<RepoResolution> {
  try {
    return await retryTransient(() => resolveOnce(repo));
  } catch {
    return {
      assessment: "unjudgeable",
      pinnedSha: null,
      defaultBranch: null,
      summary: "GitHub から提出時点の状態を取得できませんでした。"
    };
  }
}

async function resolveOnce(repo: NormalizedRepo): Promise<RepoResolution> {
  const response = await fetch(`${API}/repos/${repo.owner}/${repo.repo}`, { headers: headers() });
  if (response.status === 404) {
    return resolution("missing_or_private", null, null, "公開リポジトリが見つからないか、非公開です。");
  }
  if (isTransient(response.status)) throw new Error(`GitHub ${response.status}`);
  if (!response.ok) return resolution("unjudgeable", null, null, "GitHub からリポジトリ情報を取得できませんでした。");

  const data = await response.json() as { default_branch: string | null; description: string | null; size: number };
  const branch = data.default_branch?.trim() || null;
  if (!branch) {
    return data.size === 0
      ? resolution("empty_repository", null, null, "空のリポジトリです。")
      : resolution("no_default_branch", null, null, "デフォルトブランチがありません。");
  }

  const branchResponse = await fetch(`${API}/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(branch)}`, { headers: headers() });
  if (branchResponse.status === 404 || branchResponse.status === 409) {
    return data.size === 0
      ? resolution("empty_repository", null, branch, "コミットがない空のリポジトリです。")
      : resolution("no_default_branch", null, branch, "デフォルトブランチを解決できませんでした。");
  }
  if (isTransient(branchResponse.status)) throw new Error(`GitHub ${branchResponse.status}`);
  if (!branchResponse.ok) return resolution("unjudgeable", null, branch, "GitHub から提出時点の状態を取得できませんでした。");

  const branchData = await branchResponse.json() as { commit: { sha: string } };
  return resolution("scored", branchData.commit.sha, branch, data.description?.trim() || `${repo.normalized} の提出時点スナップショット`);
}

async function retryTransient<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    return operation();
  }
}

function resolution(assessment: RepoResolution["assessment"], pinnedSha: string | null, defaultBranch: string | null, summary: string): RepoResolution {
  return { assessment, pinnedSha, defaultBranch, summary };
}

function headers(): HeadersInit {
  return { accept: "application/vnd.github+json", "user-agent": "hackathon-nukoevi-app" };
}

function isTransient(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}
