import "./style.css";
import type {
  PublicSubmissionRecord as Submission,
  RankingEntry as Rank,
  SubmissionMode as Mode,
  SubmissionStatus as Status,
} from "../shared/types";
import { CRITERIA } from "../shared/constants";
import { RUBRIC_VERSION, rubricLevels } from "../shared/rubric";
type Effort = "low" | "high";
type Dashboard = {
  event: {
    id: string;
    name: string;
    date: string;
    targetTeams: number;
    finalistCount: number;
  };
  open: boolean;
  counts: Record<Status, number> & { total: number };
  budget: {
    limitUsd: number;
    spentUsd: number;
    reservedUsd: number;
    remainingUsd: number;
  };
  items: Submission[];
  ranking: Rank[];
  cutoff: { score: number | null; tied: boolean; tiedCount: number };
  runner: { online: boolean; lastSeenAt: string | null };
};
type Draft = {
  line: string;
  teamName: string;
  repoUrl: string;
  key: string;
  state: "ready" | "duplicate" | "invalid";
  message: string;
};
type RowResult = { line: string; state: "success" | "failed"; message: string };

const axes = CRITERIA;
const rubricMarkup = axes
  .map(
    (axis, index) =>
      `<section class="rubric-axis"><h3>${String(index + 1).padStart(2, "0")} ${esc(axis.label)}</h3><p class="rubric-focus">${esc(axis.focus)}</p><dl>${rubricLevels(axis.key)
        .map(
          ({ score, description }) =>
            `<div><dt>${esc(score)}点</dt><dd>${esc(description)}</dd></div>`,
        )
        .join("")}</dl></section>`,
  )
  .join("");
const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("App root not found");
root.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <span class="brand">OPENAI DEVDAY <span>2026</span></span>
      <span>COMMUNITY HACKATHON · TOKYO</span>
    </header>
    <section class="hero">
      <div>
        <p class="overline">2026.10.18 / TOKYO / PRELIMINARY</p>
        <h1>予選審査<span class="mark">.</span></h1>
        <p class="event-name">OpenAI DevDay 2026 Community Hackathon Tokyo</p>
        <p class="hero-copy">公開 GitHub ソースをもとに、約30チームから決勝進出10チームを選出します。</p>
      </div>
      <div class="hero-facts">
        <div><span>審査対象</span><strong>約30<small> チーム</small></strong></div>
        <div><span>決勝枠</span><strong>10<small> チーム</small></strong></div>
        <div><span>評価</span><strong>4<small> 観点 / 40点</small></strong></div>
      </div>
    </section>
    <p class="source-note">公開ソースを評価。実機の操作性やデモの完成度は主催者が確認。</p>
    <details class="rubric">
      <summary>4つの評価観点を見る<span>各10点 / 合計40点</span></summary>
      <div class="rubric-intro">
        <p>ルーブリック ${esc(RUBRIC_VERSION)}</p>
        <p>4観点を独立して採点します。全条件を根拠で確認できる最も高い段階を採用し、8点には6点、10点には8点の全条件が必要です。合計40点です。</p>
        <p>攻撃評価は独立した指標で、40点満点の総合点には含まれません。</p>
      </div>
      <div class="rubric-grid">
        ${rubricMarkup}
      </div>
    </details>
    <p id="live" role="status" aria-live="polite" class="live">審査状況を読み込んでいます。</p>
    <section class="overview" aria-labelledby="overview-title">
      <div class="section-head">
        <div><p class="kicker">OVERVIEW</p><h2 id="overview-title">審査状況</h2></div>
        <div class="refresh">
          <span id="updated"></span>
          <button id="refresh" class="subtle" type="button">手動更新</button>
          <label><input id="auto" type="checkbox"> 自動更新</label>
        </div>
      </div>
      <div id="stats" class="stats"><p class="empty">読み込み中です。</p></div>
      <div id="progress"></div>
    </section>
    <details class="organizer">
      <summary>主催者メニュー</summary>
      <div class="organizer-body">
        <div class="section-head">
          <div><h2>提出管理</h2><p>トークンはこのタブを閉じると破棄されます。</p></div>
          <p id="runner"></p>
        </div>
        <div class="connect">
          <label class="field">
            <span>主催者トークン</span>
            <input id="token" type="password" autocomplete="off" placeholder="トークンを入力">
          </label>
          <button id="connect" type="button" class="dark">接続</button>
          <button id="disconnect" type="button" class="subtle" hidden>切断</button>
        </div>
        <p id="token-state" role="status" class="note"></p>
        <div id="budget" class="budget"></div>
        <fieldset id="controls">
          <legend class="sr-only">審査キューへの登録</legend>
          <div class="section-head">
            <div><h3>審査キューへの追加</h3><p>登録するとクラウド審査へ自動で追加されます。タブを閉じてもサーバー上の実行は継続します。</p></div>
            <label class="field">
              <span>登録先</span>
              <select id="mode"><option value="production">本番審査</option><option value="validation">検証</option></select>
            </label>
          </div>
          <div class="submission-options">
            <label id="effort-field" class="field" hidden>
              <span>検証の推論強度</span>
              <select id="effort"><option value="low">low（軽量）</option><option value="high">high（本番と同じ）</option></select>
            </label>
            <p id="mode-note" class="note">本番審査のみ決勝候補に含まれ、推論強度は high 固定です。</p>
          </div>
          <form id="single" class="single">
            <label class="field"><span>チーム名</span><input id="team" maxlength="100" placeholder="チーム名（任意）"></label>
            <label class="field"><span>GitHub リポジトリ</span><input id="repo" type="url" required placeholder="https://github.com/owner/repo"></label>
            <button type="submit" class="dark">審査キューに追加</button>
          </form>
          <p id="single-result" role="status" class="note"></p>
          <div class="batch">
            <label class="field">
              <span>まとめて追加</span>
              <textarea id="batch" rows="5" placeholder="チーム名, https://github.com/owner/repo&#10;https://github.com/owner/other-repo"></textarea>
            </label>
            <p class="note">1行に1チーム、最大30行。URLだけでも登録できます。</p>
            <div id="preview"></div>
            <button id="batch-submit" type="button" class="dark">有効な行を審査キューに追加</button>
            <div id="batch-results" role="status" aria-live="polite"></div>
          </div>
        </fieldset>
      </div>
    </details>
    <section class="results" aria-labelledby="results-title">
      <div class="section-head">
        <div><p class="kicker">RESULTS</p><h2 id="results-title">審査結果</h2></div>
        <p id="cutoff"></p>
      </div>
      <div class="toolbar">
        <div class="tabs" role="tablist" aria-label="審査モード">
          <button id="tab-production" role="tab" aria-selected="true" aria-controls="panel" type="button">本番審査 <span id="production-count"></span></button>
          <button id="tab-validation" role="tab" aria-selected="false" aria-controls="panel" type="button">検証 <span id="validation-count"></span></button>
        </div>
        <div class="tools">
          <label><span class="sr-only">チーム名またはリポジトリを検索</span><input id="search" type="search" placeholder="チーム・リポジトリを検索"></label>
          <button id="csv" class="subtle" type="button">CSV</button>
          <button id="json" class="subtle" type="button">JSON</button>
        </div>
      </div>
      <div id="panel" role="tabpanel" aria-labelledby="tab-production">
        <div class="result-layout">
          <div id="list" class="list"><p class="empty">読み込み中です。</p></div>
          <aside id="detail" class="detail" aria-label="選択した提出の詳細"><p class="empty">提出を選ぶと詳細を表示します。</p></aside>
        </div>
      </div>
    </section>
    <footer>OPENAI DEVDAY 2026 COMMUNITY HACKATHON TOKYO <span>PRELIMINARY REVIEW</span></footer>
  </main>
`;

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let data: Dashboard | null = null;
let mode: Mode = "production";
let selected: string | null = null;
let token = sessionStorage.getItem("organizerToken") || "";
let posting = false;
let refreshing = false;
let automatic = false;
let timer: number | null = null;
let rowResults: RowResult[] = [];
let retryReviewId: string | null = null;
let retryRequestedEffort: "high" | null = null;
let retryFeedback: { id: string; message: string; failed: boolean } | null =
  null;

el<HTMLInputElement>("token").value = token;
el<HTMLInputElement>("token").addEventListener("input", organizer);
el<HTMLButtonElement>("connect").addEventListener("click", () => {
  token = el<HTMLInputElement>("token").value.trim();
  if (token) sessionStorage.setItem("organizerToken", token);
  organizer();
  renderResults();
});
el<HTMLButtonElement>("disconnect").addEventListener("click", () => {
  token = "";
  sessionStorage.removeItem("organizerToken");
  el<HTMLInputElement>("token").value = "";
  retryReviewId = null;
  retryRequestedEffort = null;
  retryFeedback = null;
  organizer();
  renderResults();
});
el<HTMLButtonElement>("refresh").addEventListener(
  "click",
  () => void refresh(),
);
el<HTMLInputElement>("auto").addEventListener("change", (event) => {
  automatic = (event.currentTarget as HTMLInputElement).checked;
  schedule();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && (!data || automatic || active())) void refresh();
  else schedule();
});
for (const value of ["production", "validation"] as const) {
  const tab = el<HTMLButtonElement>(`tab-${value}`);
  tab.addEventListener("click", () => {
    mode = value;
    selected = null;
    renderResults();
  });
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    mode =
      event.key === "Home"
        ? "production"
        : event.key === "End"
          ? "validation"
          : value === "production"
            ? "validation"
            : "production";
    selected = null;
    renderResults();
    el<HTMLButtonElement>(`tab-${mode}`).focus();
  });
}
el<HTMLInputElement>("search").addEventListener("input", renderResults);
el<HTMLSelectElement>("mode").addEventListener("change", () => {
  updateSubmissionOptions();
  rowResults = [];
  preview();
});
el<HTMLSelectElement>("effort").addEventListener("change", () => {
  rowResults = [];
  updateSubmissionOptions();
  preview();
});
el<HTMLTextAreaElement>("batch").addEventListener("input", () => {
  rowResults = [];
  preview();
});
el<HTMLFormElement>("single").addEventListener(
  "submit",
  (event) => void submitSingle(event),
);
el<HTMLButtonElement>("batch-submit").addEventListener(
  "click",
  () => void submitBatch(),
);
el<HTMLButtonElement>("csv").addEventListener("click", () => exportData("csv"));
el<HTMLButtonElement>("json").addEventListener("click", () =>
  exportData("json"),
);
organizer();
updateSubmissionOptions();
void refresh();

function selectedSubmissionOptions(): { mode: Mode; effort: Effort } {
  const selectedMode = el<HTMLSelectElement>("mode").value as Mode;
  return {
    mode: selectedMode,
    effort:
      selectedMode === "production"
        ? "high"
        : (el<HTMLSelectElement>("effort").value as Effort),
  };
}
function updateSubmissionOptions(): void {
  const selection = selectedSubmissionOptions();
  el<HTMLElement>("effort-field").hidden = selection.mode === "production";
  el<HTMLElement>("mode-note").textContent =
    selection.mode === "production"
      ? "本番審査のみ決勝候補に含まれ、推論強度は high 固定です。"
      : `検証結果は決勝候補に含まれません。推論強度は ${selection.effort} です。`;
}

function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] || char,
  );
}
function status(value: Status): string {
  return {
    queued: "待機中",
    processing: "審査中",
    completed: "完了",
    failed: "失敗",
  }[value];
}
function needsOrganizerReview(item: Submission): boolean {
  const timestamp =
    item.status === "processing"
      ? item.startedAt
      : item.status === "queued"
        ? item.updatedAt
        : null;
  if (!timestamp) return false;
  const parsedAt = Date.parse(timestamp);
  return Number.isFinite(parsedAt) && Date.now() - parsedAt > 30 * 60 * 1000;
}
function statusLabel(item: Submission): string {
  return needsOrganizerReview(item) ? "主催者確認" : status(item.status);
}
function money(value: number): string {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : "--";
}
function date(value: string | null): string {
  if (!value) return "--";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "--"
    : new Intl.DateTimeFormat("ja-JP", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(parsed);
}
function repo(value: string): { url: string; key: string } | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null;
    const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/*$/.exec(
      url.pathname,
    );
    if (!match || match[2] === "." || match[2] === "..") return null;
    return {
      url: `https://github.com/${match[1]}/${match[2]}`,
      key: `${match[1]}/${match[2]}`.toLowerCase(),
    };
  } catch {
    return null;
  }
}
function source(url: string, sha: string | null, path: string): string | null {
  const base = repo(url);
  const parts = path.split("/");
  if (
    !base ||
    !sha ||
    !/^[a-fA-F0-9]{40}$/.test(sha) ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\x00-\x1f\x7f\\]/.test(part) ||
        /%2f|%5c|%2e/i.test(part),
    )
  )
    return null;
  return `${base.url}/blob/${sha}/${parts.map(encodeURIComponent).join("/")}`;
}
function attack(value: number | null | undefined): string {
  return typeof value === "number" && value >= 80
    ? `<span class="attack">攻撃 ${esc(value)}点</span>`
    : "";
}
function active(): boolean {
  return !!data?.items.some(
    (item) => item.status === "queued" || item.status === "processing",
  );
}
function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (!document.hidden && (automatic || active()))
    timer = window.setTimeout(() => void refresh(), 5000);
}
function isDashboard(value: unknown): value is Dashboard {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<Dashboard>;
  return (
    typeof snapshot.open === "boolean" &&
    !!snapshot.event &&
    typeof snapshot.event.name === "string" &&
    Number.isFinite(snapshot.event.targetTeams) &&
    Number.isFinite(snapshot.event.finalistCount) &&
    !!snapshot.budget &&
    [
      snapshot.budget.limitUsd,
      snapshot.budget.spentUsd,
      snapshot.budget.reservedUsd,
      snapshot.budget.remainingUsd,
    ].every(Number.isFinite) &&
    !!snapshot.runner &&
    typeof snapshot.runner.online === "boolean" &&
    !!snapshot.cutoff &&
    typeof snapshot.cutoff.tied === "boolean" &&
    Array.isArray(snapshot.items) &&
    snapshot.items.every(
      (item) =>
        !!item &&
        typeof item.id === "string" &&
        typeof item.teamName === "string" &&
        typeof item.repoUrl === "string" &&
        typeof item.repo?.normalized === "string" &&
        typeof item.createdAt === "string" &&
        ["production", "validation"].includes(item.mode) &&
        ["queued", "processing", "completed", "failed"].includes(item.status) &&
        (item.result === null ||
          (!!item.result &&
            Array.isArray(item.result.criteria) &&
            item.result.criteria.every(
              (criterion) =>
                typeof criterion.key === "string" &&
                Number.isFinite(criterion.score) &&
                Array.isArray(criterion.evidencePaths) &&
                criterion.evidencePaths.every(
                  (path) => typeof path === "string",
                ),
            ))),
    ) &&
    Array.isArray(snapshot.ranking) &&
    snapshot.ranking.every(
      (rank) =>
        !!rank &&
        typeof rank.submissionId === "string" &&
        Number.isFinite(rank.rank) &&
        Number.isFinite(rank.total),
    )
  );
}
async function refresh(): Promise<void> {
  if (refreshing || document.hidden) return;
  refreshing = true;
  el<HTMLButtonElement>("refresh").disabled = true;
  el<HTMLElement>("live").textContent = data
    ? "更新中です。"
    : "審査状況を読み込んでいます。";
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    let body: unknown;
    try {
      const response = await fetch("/api/dashboard", {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } finally {
      clearTimeout(timeout);
    }
    if (!isDashboard(body)) throw new Error("応答形式が正しくありません。");
    data = body;
    el<HTMLElement>("live").textContent = "最新の審査状況を表示しています。";
    el<HTMLElement>("updated").textContent =
      `最終更新 ${new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date())}`;
    render();
  } catch (error) {
    el<HTMLElement>("live").textContent =
      `${data ? "前回取得した結果を表示中です。" : "結果を取得できませんでした。"} 手動更新で再試行できます。${error instanceof Error ? ` ${error.message}` : ""}`;
  } finally {
    refreshing = false;
    el<HTMLButtonElement>("refresh").disabled = false;
    schedule();
  }
}
function render(): void {
  stats();
  organizer();
  preview();
  renderResults();
}
function stats(): void {
  if (!data) return;
  const items = data.items.filter((item) => item.mode === "production");
  const count = (value: Status) =>
    items.filter((item) => item.status === value).length;
  const done = count("completed"),
    total = items.length;
  el<HTMLElement>("stats").innerHTML =
    `<div><span>本番登録</span><strong>${total}<small> / ${data.event.targetTeams}</small></strong></div><div><span>審査完了</span><strong>${done}</strong></div><div><span>待機・審査中</span><strong>${count("queued") + count("processing")}</strong></div><div><span>失敗</span><strong>${count("failed")}</strong></div>`;
  el<HTMLElement>("progress").innerHTML =
    `<div class="progress-label"><span>審査進捗</span><span>${total ? Math.round((done / total) * 100) : 0}%</span></div><progress max="${Math.max(total, 1)}" value="${done}">${done} / ${total}</progress><p>${done} / ${total} 件の審査が完了</p>`;
}
function organizer(): void {
  const connected = !!token;
  el<HTMLButtonElement>("connect").hidden = connected;
  el<HTMLButtonElement>("connect").disabled =
    !el<HTMLInputElement>("token").value.trim();
  el<HTMLButtonElement>("disconnect").hidden = !connected;
  el<HTMLButtonElement>("disconnect").disabled = posting;
  el<HTMLInputElement>("token").hidden = connected;
  el<HTMLElement>("token-state").textContent = connected
    ? "トークンをこのタブに保持中。認証は登録時に確認されます。"
    : "登録操作には主催者トークンが必要です。";
  el<HTMLFieldSetElement>("controls").disabled =
    !connected || posting || data?.open === false;
  if (data) {
    const budget = data.budget;
    el<HTMLElement>("budget").innerHTML =
      `<div><span>使用済み</span><strong>${money(budget.spentUsd)}</strong></div><div><span>予約済み</span><strong>${money(budget.reservedUsd)}</strong></div><div><span>残額</span><strong>${money(budget.remainingUsd)}</strong></div><div><span>上限</span><strong>${money(budget.limitUsd)}</strong></div><p>概算 USD</p>`;
    el<HTMLElement>("runner").textContent = data.runner.online
      ? "クラウド自動審査: 有効"
      : "クラウド自動審査: 停止中（再開待ち）";
    if (!data.open)
      el<HTMLElement>("token-state").textContent +=
        " 現在、登録受付は停止しています。";
  }
}
function entries(): Array<{ item: Submission; position: number | null }> {
  if (!data) return [];
  const all = data.items.filter((item) => item.mode === mode);
  const ranks = data.ranking
    .filter((rank) => rank.mode === mode && rank.rank > 0)
    .sort(
      (a, b) =>
        b.total - a.total ||
        (a.completedAt || "").localeCompare(b.completedAt || ""),
    );
  const ranked = ranks.flatMap((rank) => {
    const item = all.find((value) => value.id === rank.submissionId);
    return item
      ? [{ item, position: mode === "production" ? rank.rank : null }]
      : [];
  });
  const used = new Set(ranked.map((value) => value.item.id));
  const rest = all
    .filter((item) => !used.has(item.id))
    .sort(
      (a, b) =>
        (a.status === "completed" ? 0 : 1) -
          (b.status === "completed" ? 0 : 1) ||
        b.createdAt.localeCompare(a.createdAt),
    )
    .map((item) => ({ item, position: null }));
  return [...ranked, ...rest];
}
function renderResults(): void {
  if (!data) return;
  const all = entries();
  const query = el<HTMLInputElement>("search").value.trim().toLocaleLowerCase();
  const visible = all.filter(({ item }) =>
    `${item.teamName} ${item.repo.normalized} ${item.repoUrl}`
      .toLocaleLowerCase()
      .includes(query),
  );
  el<HTMLElement>("production-count").textContent = String(
    data.items.filter((item) => item.mode === "production").length,
  );
  el<HTMLElement>("validation-count").textContent = String(
    data.items.filter((item) => item.mode === "validation").length,
  );
  for (const value of ["production", "validation"] as const) {
    const tab = el<HTMLButtonElement>(`tab-${value}`);
    tab.setAttribute("aria-selected", String(value === mode));
    tab.tabIndex = value === mode ? 0 : -1;
  }
  el<HTMLElement>("panel").setAttribute("aria-labelledby", `tab-${mode}`);
  const production = data.items.filter((item) => item.mode === "production");
  const provisional =
    production.filter((item) => item.status === "completed").length <
      data.event.targetTeams ||
    production.some(
      (item) => item.status === "queued" || item.status === "processing",
    );
  el<HTMLElement>("cutoff").textContent =
    mode === "validation"
      ? "検証結果は決勝選考に含まれません。"
      : data.cutoff.tied
        ? `通過ラインで${data.cutoff.tiedCount}チームが同点: 主催者確認`
        : data.cutoff.score === null
          ? "通過ラインは未確定です。"
          : `通過ライン ${data.cutoff.score}点${provisional ? " · 暫定" : ""}`;
  el<HTMLButtonElement>("csv").disabled = !all.length;
  el<HTMLButtonElement>("json").disabled = !all.length;
  el<HTMLButtonElement>("csv").title = "表示中の区分を全件出力します";
  el<HTMLButtonElement>("json").title = "表示中の区分を全件出力します";
  if (!all.length || !visible.length) {
    el<HTMLElement>("list").innerHTML =
      `<p class="empty">${all.length ? "検索に一致する提出はありません。" : mode === "production" ? "本番審査の提出はまだありません。" : "検証の提出はまだありません。"}</p>`;
    el<HTMLElement>("detail").innerHTML =
      `<p class="empty">提出を選ぶと詳細を表示します。</p>`;
    return;
  }
  if (!selected || !visible.some((value) => value.item.id === selected))
    selected = visible[0]!.item.id;
  el<HTMLElement>("list").innerHTML =
    `<div class="list-heading"><h3>${mode === "production" ? (provisional ? "暫定トップ10・審査一覧" : "トップ10・審査一覧") : "検証一覧"}</h3><span>${visible.length} 件</span></div><div class="table-head"><span>順位 / チーム・リポジトリ</span>${axes.map((axis) => `<span>${esc(axis.label)}</span>`).join("")}<span>合計</span><span>状態</span></div>` +
    visible
      .map(({ item, position }, index) => {
        const atCutoff =
          mode === "production" &&
          position !== null &&
          item.result?.total === data!.cutoff.score &&
          visible[index + 1]?.item.result?.total !== data!.cutoff.score;
        const scores = axes
          .map(
            (axis) =>
              `<span class="axis-score"><span class="axis-label">${esc(axis.label)}</span>${esc(item.result?.criteria.find((value) => value.key === axis.key)?.score ?? "--")}</span>`,
          )
          .join("");
        return `<button type="button" class="result-row${selected === item.id ? " selected" : ""}${atCutoff ? " cutoff-row" : ""}" data-id="${esc(item.id)}" aria-pressed="${selected === item.id}" aria-controls="detail"><span class="row-primary"><span class="rank">${position === null ? "--" : String(position).padStart(2, "0")}</span><span class="team-block"><strong>${esc(item.teamName || item.repo.normalized)}</strong><small>${esc(item.repo.normalized)}</small></span></span>${scores}<span class="total">${item.result ? `${esc(item.result.total)}<small>/40</small>` : "--"}${attack(item.result?.attackScore)}</span><span class="status ${item.status}">${statusLabel(item)}</span></button>`;
      })
      .join("");
  el<HTMLElement>("list")
    .querySelectorAll<HTMLButtonElement>("[data-id]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        selected = button.dataset.id || null;
        retryReviewId = null;
        retryRequestedEffort = null;
        renderResults();
        const panel = el<HTMLElement>("detail");
        panel.tabIndex = -1;
        panel.focus({ preventScroll: true });
        if (window.matchMedia("(max-width: 950px)").matches)
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
      }),
    );
  const chosen = visible.find((value) => value.item.id === selected);
  if (chosen) detail(chosen.item, chosen.position, provisional);
}
function detail(
  item: Submission,
  position: number | null,
  provisional: boolean,
): void {
  const result = item.result;
  const qualification =
    mode === "production" &&
    position !== null &&
    position <= data!.event.finalistCount
      ? data!.cutoff.tied && data!.cutoff.score === result?.total
        ? "通過ラインで同点: 主催者確認"
        : provisional
          ? "暫定トップ10"
          : "上位10件"
      : "";
  const safe = repo(item.repoUrl);
  const pinned =
    safe && result?.pinnedSha && /^[a-fA-F0-9]{40}$/.test(result.pinnedSha)
      ? `${safe.url}/tree/${result.pinnedSha}`
      : null;
  const assessments: Record<string, string> = {
    scored: "採点済み",
    empty_repository: "空のリポジトリ",
    missing_or_private: "未公開または見つからないリポジトリ",
    no_default_branch: "既定ブランチなし",
    retryable_failure: "再試行が必要",
    unjudgeable: "評価対象外",
  };
  el<HTMLElement>("detail").innerHTML =
    `<div class="detail-head"><p class="kicker">SUBMISSION DETAIL</p><span class="status ${item.status}">${statusLabel(item)}</span></div><h3>${esc(item.teamName || item.repo.normalized)}</h3><p class="detail-repo">${safe ? `<a href="${esc(safe.url)}" target="_blank" rel="noopener noreferrer">${esc(item.repo.normalized)}</a>` : esc(item.repo.normalized)}</p>${qualification ? `<p class="qualification">${qualification}</p>` : ""}<dl class="metadata"><div><dt>審査区分</dt><dd>${item.mode === "production" ? "本番審査" : "検証"}</dd></div><div><dt>推論強度</dt><dd>${esc(recordedEffort(item) || "--")}</dd></div><div><dt>登録</dt><dd>${date(item.createdAt)}</dd></div><div><dt>完了</dt><dd>${date(item.completedAt)}</dd></div><div><dt>評価した版</dt><dd class="sha">${pinned ? `<a href="${esc(pinned)}" target="_blank" rel="noopener noreferrer">${esc(result!.pinnedSha!.slice(0, 12))}</a>` : "--"}</dd></div></dl>${
      result
        ? `<div class="detail-total"><span>総合点</span><strong>${esc(result.total)}<small> / 40</small></strong></div>${attack(result.attackScore)}${typeof result.attackScore === "number" && result.attackScore >= 80 ? `<p class="note">攻撃評価は独立した指標で、40点満点の総合点には含まれません。</p>` : ""}<h4>評価概要</h4><p>${esc(result.summary)}</p><h4>公開コメント</h4><p>${esc(result.publicReason)}</p><p class="note">${esc(assessments[result.repoAssessment] || "リポジトリの評価結果")}</p><div class="criteria">${axes
            .map((axis) => {
              const criterion = result.criteria.find(
                (value) => value.key === axis.key,
              );
              return `<section><div class="criterion-head"><h5>${esc(axis.label)}</h5><strong>${criterion ? esc(criterion.score) : "--"}<small> / 10</small></strong></div><p>${esc(criterion?.reason || "評価理由はありません。")}</p><div class="evidence"><span>根拠ファイル</span>${
                criterion?.evidencePaths.length
                  ? `<ul>${criterion.evidencePaths
                      .map((path) => {
                        const url = source(
                          item.repoUrl,
                          result.pinnedSha,
                          path,
                        );
                        return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(path)}</a>` : esc(path)}</li>`;
                      })
                      .join("")}</ul>`
                  : "<p>記載なし</p>"
              }</div></section>`;
            })
            .join("")}</div>`
        : needsOrganizerReview(item)
          ? `<div class="pending" role="status"><h4>主催者確認</h4><p>${item.status === "queued" ? "クラウド実行待ちのまま30分以上経過しています。原因はまだ確定していません。自動で再審査しません。" : "クラウド審査中のまま30分以上経過しています。原因はまだ確定していません。自動で再審査しません。"}</p></div>`
          : `<div class="pending"><h4>${item.status === "failed" ? "審査できませんでした" : item.status === "processing" ? "クラウド審査中です" : "クラウド実行待ちです"}</h4><p>${esc(item.failureMessage || (item.status === "queued" ? "クラウド審査キューに登録済みです。タブを閉じてもサーバー上の実行は継続します。" : "結果が届くまでお待ちください。"))}</p></div>`
    }`;
  renderRetryControls(item);
}
function retryAttempts(item: Submission): number {
  return "attempts" in item && typeof item.attempts === "number"
    ? item.attempts
    : 0;
}
function retryDispatches(item: Submission): number {
  return "dispatches" in item && typeof item.dispatches === "number"
    ? item.dispatches
    : retryAttempts(item);
}
function retryLimitMessage(item: Submission): string {
  if (retryDispatches(item) >= 3) return "登録・再送の上限（3回）に達しています。";
  if (retryAttempts(item) >= 3) return "審査実行の上限（3回）に達しています。";
  return "";
}
function canRetry(item: Submission): boolean {
  return (
    (item.status === "failed" || needsOrganizerReview(item)) &&
    retryAttempts(item) < 3 &&
    retryDispatches(item) < 3
  );
}
function recordedEffort(item: Submission): Effort | null {
  return "effort" in item && (item.effort === "low" || item.effort === "high")
    ? item.effort
    : item.result?.usage?.effort || null;
}
function isCompletedLowValidation(item: Submission): boolean {
  return item.mode === "validation" && item.status === "completed" && recordedEffort(item) === "low";
}
function canHighRecheck(item: Submission): boolean {
  return isCompletedLowValidation(item) && retryAttempts(item) < 3 && retryDispatches(item) < 3;
}
function renderRetryControls(item: Submission): void {
  if (!token) return;
  const highRecheck = isCompletedLowValidation(item);
  const eligible = canRetry(item) || canHighRecheck(item);
  const limitMessage = retryLimitMessage(item);
  const feedback = retryFeedback?.id === item.id ? retryFeedback : null;
  if (
    !eligible &&
    !feedback &&
    item.status !== "failed" &&
    !needsOrganizerReview(item) &&
    !highRecheck
  )
    return;
  const section = document.createElement("section");
  section.className = "retry-controls";
  section.innerHTML = `<h4>${highRecheck ? "highでの再検証" : "主催者による再審査"}</h4>${feedback ? `<p role="${feedback.failed ? "alert" : "status"}">${esc(feedback.message)}</p>` : ""}${eligible ? (retryReviewId === item.id ? `<p>${retryRequestedEffort === "high" ? "推論強度をlowからhighへ上げて、同じリポジトリを再検証します。" : "新しいクラウド審査をキューへ追加します。"}未確定の費用予約は保持され、追加のAPI費用が発生します。</p><div class="retry-actions"><button id="retry-confirm" type="button" class="dark"${posting ? " disabled" : ""}>${posting ? "登録中です" : retryRequestedEffort === "high" ? "費用を確認してhighで再検証" : "費用を確認して再審査"}</button><button id="retry-cancel" type="button" class="subtle"${posting ? " disabled" : ""}>キャンセル</button></div>` : `<p>審査実行 ${retryAttempts(item)} / 3回、登録・再送 ${retryDispatches(item)} / 3回。各最大3回です。</p><button id="retry-prepare" type="button" class="dark"${posting ? " disabled" : ""}>${highRecheck ? "highで再検証を準備" : "再審査を準備"}</button>`) : limitMessage && (item.status === "failed" || needsOrganizerReview(item) || highRecheck) ? `<p>${esc(limitMessage)}</p>` : ""}`;
  el<HTMLElement>("detail").append(section);
  section
    .querySelector<HTMLButtonElement>("#retry-prepare")
    ?.addEventListener("click", () => {
      if (posting || !token || !(canRetry(item) || canHighRecheck(item))) return;
      retryReviewId = item.id;
      retryRequestedEffort = canHighRecheck(item) ? "high" : null;
      renderResults();
      el<HTMLButtonElement>("retry-confirm").focus({ preventScroll: true });
    });
  section
    .querySelector<HTMLButtonElement>("#retry-cancel")
    ?.addEventListener("click", () => {
      retryReviewId = null;
      retryRequestedEffort = null;
      renderResults();
      el<HTMLButtonElement>("retry-prepare").focus({ preventScroll: true });
    });
  section
    .querySelector<HTMLButtonElement>("#retry-confirm")
    ?.addEventListener("click", () => void retrySubmission(item.id));
}
async function retrySubmission(id: string): Promise<void> {
  const current = data?.items.find((item) => item.id === id);
  const highRecheck = retryRequestedEffort === "high";
  if (
    !token ||
    posting ||
    retryReviewId !== id ||
    !current ||
    !(highRecheck ? canHighRecheck(current) : canRetry(current))
  )
    return;
  posting = true;
  retryFeedback = null;
  organizer();
  preview();
  renderResults();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(
      `/api/submissions/${encodeURIComponent(id)}/retry`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ confirm: true, ...(highRecheck ? { effort: "high" } : {}) }),
        signal: controller.signal,
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      submission?: Submission;
      message?: string;
    };
    if (!response.ok)
      throw new Error(body.message || `HTTP ${response.status}`);
    if (
      !body.submission ||
      body.submission.id !== id ||
      body.submission.status !== "queued"
    )
      throw new Error(
        "登録結果を確認できませんでした。手動更新で状態を確認してください。",
      );
    if (data)
      data.items = data.items.map((item) =>
        item.id === id ? body.submission! : item,
      );
    retryFeedback = {
      id,
      message: "再審査をクラウド審査キューに追加しました。タブを閉じてもサーバー上の実行は継続します。",
      failed: false,
    };
    retryReviewId = null;
    retryRequestedEffort = null;
    schedule();
  } catch (error) {
    retryFeedback = {
      id,
      message:
        error instanceof Error ? error.message : "再審査の登録に失敗しました。",
      failed: true,
    };
    retryReviewId = null;
    retryRequestedEffort = null;
  } finally {
    window.clearTimeout(timeout);
    posting = false;
    organizer();
    preview();
    renderResults();
    void refresh();
  }
}
function draft(line: string): Draft {
  const comma = line.indexOf(",");
  const teamName = comma < 0 ? "" : line.slice(0, comma).trim();
  const input = comma < 0 ? line.trim() : line.slice(comma + 1).trim();
  const parsed = repo(input);
  return !parsed || (comma >= 0 && !teamName)
    ? {
        line,
        teamName,
        repoUrl: input,
        key: "",
        state: "invalid",
        message: "GitHub URL またはチーム名を確認してください。",
      }
    : {
        line,
        teamName,
        repoUrl: parsed.url,
        key: parsed.key,
        state: "ready",
        message: "追加可能",
      };
}
function drafts(): Draft[] {
  const lines = el<HTMLTextAreaElement>("batch")
    .value.split(/\r?\n/)
    .filter((line) => line.trim());
  const seen = new Set<string>();
  const existing = new Set(
    (data?.items || [])
      .filter((item) => item.mode === el<HTMLSelectElement>("mode").value)
      .map((item) => repo(item.repoUrl)?.key),
  );
  return lines.map((line, index) => {
    const item = draft(line);
    if (index >= 30)
      return {
        ...item,
        state: "invalid",
        message: "一度に追加できるのは30行までです。",
      };
    if (
      item.state === "ready" &&
      (seen.has(item.key) || existing.has(item.key))
    )
      return {
        ...item,
        state: "duplicate",
        message: "同じ区分に登録済み、または入力内で重複しています。",
      };
    if (item.state === "ready") seen.add(item.key);
    return item;
  });
}
function preview(): void {
  const items = drafts();
  const selection = selectedSubmissionOptions();
  el<HTMLElement>("preview").innerHTML = items.length
    ? `<p>${items.filter((item) => item.state === "ready").length} 件追加可能 / ${items.filter((item) => item.state === "duplicate").length} 件重複 / ${items.filter((item) => item.state === "invalid").length} 件要確認 <span class="preview-effort">推論強度 ${esc(selection.effort)}</span></p><ol>${items.map((item) => `<li><span class="preview-${item.state}">${item.state === "ready" ? "追加可能" : item.state === "duplicate" ? "重複" : "要確認"}</span><span>${esc(item.line)}</span><small>${esc(item.message)}</small></li>`).join("")}</ol>`
    : "";
  el<HTMLButtonElement>("batch-submit").disabled =
    !token ||
    posting ||
    data?.open === false ||
    !items.some((item) => item.state === "ready");
  el<HTMLElement>("batch-results").innerHTML = rowResults.length
    ? `<ol>${rowResults.map((item) => `<li class="${item.state}">${esc(item.line)}: ${esc(item.message)}</li>`).join("")}</ol>`
    : "";
}
async function post(
  repoUrl: string,
  teamName: string,
  selectedMode: Mode,
  selectedEffort: Effort,
): Promise<Submission> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch("/api/submissions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        repoUrl,
        teamName: teamName || undefined,
        mode: selectedMode,
        effort: selectedEffort,
      }),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        body && typeof body === "object" && "message" in body
          ? String(body.message)
          : `HTTP ${response.status}`,
      );
    if (!body || typeof body !== "object" || !("submission" in body))
      throw new Error("登録結果を確認できませんでした。");
    return (body as { submission: Submission }).submission;
  } finally {
    clearTimeout(timeout);
  }
}
function addLocal(item: Submission): void {
  if (data && !data.items.some((value) => value.id === item.id))
    data.items = [...data.items, item];
  render();
  schedule();
}
async function submitSingle(event: Event): Promise<void> {
  event.preventDefault();
  if (!token || posting || data?.open === false) return;
  const selection = selectedSubmissionOptions();
  const input = el<HTMLInputElement>("repo"),
    team = el<HTMLInputElement>("team").value.trim(),
    parsed = repo(input.value),
    output = el<HTMLElement>("single-result");
  if (!parsed) {
    output.textContent = "GitHub のリポジトリ URL を確認してください。";
    return;
  }
  if (
    data?.items.some(
      (item) =>
        item.mode === selection.mode &&
        repo(item.repoUrl)?.key === parsed.key,
    )
  ) {
    output.textContent = "同じ区分に登録済みです。";
    return;
  }
  posting = true;
  organizer();
  preview();
  output.textContent = "登録中です。";
  try {
    const item = await post(parsed.url, team, selection.mode, selection.effort);
    addLocal(item);
    input.value = "";
    el<HTMLInputElement>("team").value = "";
    output.textContent =
      "審査キューに追加しました。審査完了は結果一覧で確認できます。";
    void refresh();
  } catch (error) {
    output.textContent =
      error instanceof Error ? error.message : "登録に失敗しました。";
  } finally {
    posting = false;
    organizer();
    preview();
  }
}
async function submitBatch(): Promise<void> {
  if (!token || posting || data?.open === false) return;
  const initial = drafts();
  const pending = initial.filter((item) => item.state === "ready");
  if (!pending.length) return;
  const selection = selectedSubmissionOptions();
  posting = true;
  rowResults = [];
  organizer();
  preview();
  const retained = initial
    .filter((item) => item.state === "invalid")
    .map((item) => item.line);
  for (const item of pending) {
    try {
      addLocal(
        await post(
          item.repoUrl,
          item.teamName,
          selection.mode,
          selection.effort,
        ),
      );
      rowResults.push({
        line: item.line,
        state: "success",
        message: "キューに追加しました。",
      });
    } catch (error) {
      retained.push(item.line);
      rowResults.push({
        line: item.line,
        state: "failed",
        message:
          error instanceof Error ? error.message : "登録に失敗しました。",
      });
    }
    preview();
  }
  el<HTMLTextAreaElement>("batch").value = retained.join("\n");
  posting = false;
  organizer();
  preview();
  void refresh();
}
function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return `"${(/^[\s]*[=+\-@\t\r\n]/.test(text) ? "'" : "") + text.replace(/"/g, '""')}"`;
}
function exportData(format: "csv" | "json"): void {
  const rows = entries().map(({ item, position }) => ({
    rank: position ?? "",
    teamName: item.teamName,
    repo: item.repo.normalized,
    repoUrl: repo(item.repoUrl)?.url || "",
    status: status(item.status),
    total: item.result?.total ?? "",
    technical:
      item.result?.criteria.find((value) => value.key === "technical")?.score ??
      "",
    ux: item.result?.criteria.find((value) => value.key === "ux")?.score ?? "",
    impact:
      item.result?.criteria.find((value) => value.key === "impact")?.score ??
      "",
    idea:
      item.result?.criteria.find((value) => value.key === "idea")?.score ?? "",
    attackScore:
      typeof item.result?.attackScore === "number" &&
      item.result.attackScore >= 80
        ? item.result.attackScore
        : "",
    summary: item.result?.summary ?? "",
    publicReason: item.result?.publicReason ?? "",
    pinnedSha: item.result?.pinnedSha ?? "",
    failureMessage: item.failureMessage ?? "",
  }));
  if (!rows.length) return;
  const content =
    format === "json"
      ? JSON.stringify(rows, null, 2)
      : [
          Object.keys(rows[0]!).map(csvCell).join(","),
          ...rows.map((row) => Object.values(row).map(csvCell).join(",")),
        ].join("\r\n");
  const blob = new Blob([format === "csv" ? "\ufeff" + content : content], {
    type:
      format === "csv"
        ? "text/csv;charset=utf-8"
        : "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `devday-2026-${mode}-results.${format}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
