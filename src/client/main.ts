import "./style.css";
import { CRITERIA } from "../shared/constants";

type SubmissionRecord = {
  id: string;
  repoUrl: string;
  repo: {
    normalized: string;
  };
  status: "queued" | "processing" | "completed" | "failed";
  result: {
    summary: string;
    publicReason: string;
    pinnedSha: string | null;
    nukoScore?: number | null;
    total: number;
    criteria: Array<{
      key: string;
      label: string;
      score: number;
      reason: string;
      evidencePaths: string[];
    }>;
  } | null;
  failureMessage: string | null;
  completedAt: string | null;
};

type RankingResponse = {
  items: Array<{
    submissionId: string;
    repo: string;
    repoUrl: string;
    pinnedSha: string | null;
    total: number;
    summary: string;
    nukoScore: number | null;
    ranked: boolean;
    criteria: Array<{
      label: string;
      score: number;
    }>;
  }>;
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found");
}

app.innerHTML = `
  <main class="page">
    <section class="hero">
      <div>
        <p class="eyebrow">Automated Hackathon Judge</p>
        <h1>ハッカソン自動ジャッジツール</h1>
        <p class="lede">公開 GitHub リポジトリ URL を 1 つ送ると、提出時点の内容を 4 観点で 0〜10 点ずつジャッジするよ。</p>
      </div>
      <form id="submission-form" class="panel form-panel">
        <label class="field">
          <span>GitHub リポジトリ URL</span>
          <input id="repo-url" name="repoUrl" type="url" placeholder="https://github.com/owner/repo" required />
        </label>
        <button id="submit-button" type="submit">ジャッジを開始</button>
        <p id="form-message" class="message"></p>
      </form>
    </section>
    <section class="grid">
      <article class="panel">
        <h2>採点基準</h2>
        <div id="criteria-list" class="criteria-list"></div>
      </article>
      <article class="panel">
        <h2>ジャッジ状態</h2>
        <div id="active-submission" class="empty-state">まだジャッジは始まっていないよ。</div>
      </article>
    </section>
    <section class="ranking-section">
      <article class="panel">
        <div class="section-head">
          <h2>ランキング</h2>
          <button id="refresh-ranking" type="button" class="ghost">更新</button>
        </div>
        <div id="ranking" class="list"></div>
      </article>
    </section>
  </main>
`;

const criteriaList = document.querySelector<HTMLDivElement>("#criteria-list")!;
const activeSubmission = document.querySelector<HTMLDivElement>("#active-submission")!;
const rankingRoot = document.querySelector<HTMLDivElement>("#ranking")!;
const form = document.querySelector<HTMLFormElement>("#submission-form")!;
const formMessage = document.querySelector<HTMLParagraphElement>("#form-message")!;
const submitButton = document.querySelector<HTMLButtonElement>("#submit-button")!;
const repoUrlInput = document.querySelector<HTMLInputElement>("#repo-url")!;
const refreshRankingButton = document.querySelector<HTMLButtonElement>("#refresh-ranking")!;

let activeSubmissionId: string | null = null;
let pollTimer: number | null = null;

criteriaList.innerHTML = `
  <p class="anchor">0 は証拠なし、1〜2 は初期段階、3〜4 は大きな不足あり、5〜6 は基準到達、7〜8 は明確に強い、9〜10 はハッカソンとして突出。</p>
  ${CRITERIA.map(
    (criterion, index) => `
      <section class="criterion">
        <div class="criterion-head">
          <span class="criterion-index">${index + 1}</span>
          <h3>${criterion.label}</h3>
        </div>
        <p>${criterion.focus}</p>
      </section>
    `
  ).join("")}
`;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const repoUrl = repoUrlInput.value.trim();
  if (!repoUrl) {
    formMessage.textContent = "GitHub URL を入れてね。";
    return;
  }

  setSubmitting(true);
  try {
    const response = await fetch("/api/submissions", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ repoUrl })
    });
    const body = await response.json();
    if (!response.ok) {
      formMessage.textContent = body.message || body.error || "投稿に失敗したの。";
      return;
    }
    const submission = body.submission as SubmissionRecord;
    activeSubmissionId = submission.id;
    formMessage.textContent = "ジャッジキューに入れたよ。";
    renderSubmission(submission);
    startPolling();
    await refreshAll();
  } catch {
    formMessage.textContent = "通信に失敗したの。少し待ってからもう一度試してね。";
  } finally {
    setSubmitting(false);
  }
});

refreshRankingButton.addEventListener("click", () => void loadRanking());

void refreshAll();

function setSubmitting(isSubmitting: boolean) {
  submitButton.disabled = isSubmitting;
  repoUrlInput.disabled = isSubmitting;
}

async function refreshAll() {
  await loadRanking();
}

async function loadRanking() {
  const response = await fetch("/api/ranking");
  const data = (await response.json()) as RankingResponse;
  if (data.items.length === 0) {
    rankingRoot.innerHTML = `<div class="empty-state">まだ完了したジャッジがないよ。</div>`;
    return;
  }
  rankingRoot.innerHTML = data.items
    .map((item, index, items) => {
      const rank = item.ranked
        ? items.slice(0, index).filter((candidate) => candidate.ranked && candidate.total > item.total).length + 1
        : null;
      return `
        <article class="list-item${item.ranked ? "" : " is-unranked"}">
          <div class="rank-line">
            <span class="badge${item.ranked ? "" : " badge-muted"}">${rank === null ? "ランク外" : `#${rank}`}</span>
            <a href="${escapeHtml(item.repoUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.repo)}</a>
            <strong>${item.total}/40</strong>
          </div>
          <p>${escapeHtml(item.summary)}</p>
          <div class="score-row">
            ${item.nukoScore !== null && item.nukoScore >= 80 ? `<span class="nuko-score">ぬこスコア ${item.nukoScore}点</span>` : ""}
            ${item.criteria.map((criterion) => `<span>${escapeHtml(criterion.label)} ${criterion.score}</span>`).join("")}
          </div>
        </article>
      `;
    })
    .join("");
}

function startPolling() {
  if (!activeSubmissionId) {
    return;
  }
  if (pollTimer) {
    window.clearInterval(pollTimer);
  }
  void pollSubmission();
  pollTimer = window.setInterval(() => {
    void pollSubmission();
  }, 4000);
}

async function pollSubmission() {
  if (!activeSubmissionId) {
    return;
  }
  const response = await fetch(`/api/submissions/${encodeURIComponent(activeSubmissionId)}`);
  if (!response.ok) {
    return;
  }
  const submission = (await response.json()) as SubmissionRecord;
  renderSubmission(submission);
  if (submission.status === "completed" || submission.status === "failed") {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    await refreshAll();
  }
}

function renderSubmission(submission: SubmissionRecord) {
  if (submission.status === "queued" || submission.status === "processing") {
    activeSubmission.innerHTML = `
      <div class="active-card">
        <p class="meta">${escapeHtml(submission.repo.normalized)}</p>
        <h3>${submission.status === "queued" ? "ジャッジ待ち" : "ジャッジ中"}</h3>
        <p>現在の状態: ${escapeHtml(statusLabel(submission.status))}</p>
      </div>
    `;
    return;
  }

  if (submission.status === "failed") {
    activeSubmission.innerHTML = `
      <div class="active-card">
        <p class="meta">${escapeHtml(submission.repo.normalized)}</p>
        <h3>ジャッジ不能</h3>
        <p>${escapeHtml(submission.failureMessage ?? "ジャッジに失敗したの。")}</p>
      </div>
    `;
    return;
  }

  const result = submission.result;
  if (!result) {
    activeSubmission.innerHTML = `<div class="empty-state">結果を表示できなかったの。</div>`;
    return;
  }

  activeSubmission.innerHTML = `
    <div class="active-card">
      <div class="rank-line">
        <p class="meta">${escapeHtml(submission.repo.normalized)}</p>
        <strong>${result.total}/40</strong>
      </div>
      <h3>${escapeHtml(result.summary)}</h3>
      <p>${escapeHtml(result.publicReason)}</p>
      ${result.nukoScore !== null && result.nukoScore !== undefined && result.nukoScore >= 80 ? `<p><span class="nuko-score">ぬこスコア ${result.nukoScore}点</span></p>` : ""}
      <div class="criterion-results">
        ${result.criteria
          .map(
            (criterion) => `
              <section class="criterion-result">
                <div class="rank-line">
                  <span>${escapeHtml(criterion.label)}</span>
                  <strong>${criterion.score}</strong>
                </div>
                <p>${escapeHtml(criterion.reason)}</p>
                <p class="meta">${escapeHtml(criterion.evidencePaths.join(" / ") || "証拠パスなし")}</p>
              </section>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function statusLabel(status: string) {
  switch (status) {
    case "queued":
      return "待機中";
    case "processing":
      return "ジャッジ中";
    case "completed":
      return "完了";
    case "failed":
      return "ジャッジ不能";
    default:
      return status;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;"
  })[character] ?? character);
}
