import "./style.css";
import { capturePresentation, demoPresentation, selectPresentation, rankLabel, revealState, acceptsAdvance, type PresentationSnapshot, type RevealState } from "./presentation";
import { createPresentationAudio } from "./presentation-audio";
import type {
  PublicSubmissionRecord,
  PublicBatchRecord,
  RankingEntry as Rank,
  SubmissionMode as Mode,
  SubmissionStatus as Status,
} from "../shared/types";
import { importSourceSignature, restorePendingImport, normalizeRepository, normalizeDemoUrl, formatTimestampJst, type ImportResult } from "./submission-import";
import { CRITERIA, EVENT_NAME, JUDGING_START_ISO } from "../shared/constants";
import { DEVDAY_REFERENCE_VERSION } from "../shared/devday-reference";
import { RUBRIC_VERSION, rubricLevels } from "../shared/rubric";
import { CONDITION_PROBABILITY_THRESHOLD, DECISION_CONDITIONS, SOURCE_EVIDENCE } from "../shared/decision-conditions";
type Effort = "low" | "medium" | "high";
type ExplanationState = "pending" | "processing" | "completed" | "failed";
type Submission = PublicSubmissionRecord;
type Batch = PublicBatchRecord;
type Dashboard = {
  batches?: Batch[];
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
      <span class="brand"><svg class="brand-symbol" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="m12 0 3.5 8.5L24 12l-8.5 3.5L12 24l-3.5-8.5L0 12l8.5-3.5Z" fill="currentColor"/></svg> ${esc(EVENT_NAME)}</span>
      <span class="topbar-tag">COMMUNITY HACKATHON · TOKYO</span>
    </header>
    <section class="hero">
      <div class="hero-content">
        <p class="overline"><span class="signal-dot" aria-hidden="true"></span> 予選ジャッジ / 2026.10.18 / TOKYO</p>
        <h1>すごい作品、<br><span>次のステージへ。</span></h1>
        <p class="event-name">${esc(EVENT_NAME)}</p>
        <p class="hero-copy">公開 GitHub ソースをもとに、約30チームから原則上位10チームを選出します。10位と同点のチームは全員通過します。</p>
        <div class="hero-links"><a class="hero-link primary" href="#results-title">審査結果を見る <svg aria-hidden="true" focusable="false" viewBox="0 0 18 18"><path d="M4 14 14 4M4 4h10v10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></a><a class="hero-link secondary" href="#overview-title">進行状況 <svg aria-hidden="true" focusable="false" viewBox="0 0 18 18"><path d="M9 3v12m-5-5 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></a></div>
      </div>
      <div class="hero-art">
        <p class="character-bubble">アイデアの光るところ、<br>じっくり見つけるね。</p>
        <figure class="character-portrait">
          <img class="character-image" src="/images/nukoevi-original.jpg" width="886" height="886" alt="茶色の巻き髪と猫耳、オレンジ色のエビのニット帽、琥珀色の瞳のぬこエビ">
          <figcaption class="character-caption"><span>ぬこエビ</span><span>JUDGE COMPANION</span></figcaption>
        </figure>
      </div>
      <div class="hero-facts">
        <div><span>審査対象</span><strong>約30<small> チーム</small></strong></div>
        <div><span>決勝枠 / 同点全員通過</span><strong>10<small> チーム目安</small></strong></div>
        <div><span>評価</span><strong>4<small> 観点 / 40点</small></strong></div>
      </div>
    </section>
    <p class="source-note">公開ソースを評価します。実機操作や外部デモの動作は自動評価の対象外です。</p>
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
    <details class="rubric">
      <summary>審査の仕組み</summary>
      <div class="rubric-intro">
        <p>固定ルーブリック ${esc(RUBRIC_VERSION)} に沿って点数を先に確定し、別のモデルが根拠に基づく理由を書きます。</p>
      </div>
      <div class="rubric-grid">
        <section class="rubric-axis">
          <h3>01 固定した全対象ソース</h3>
          <p class="rubric-focus">最初に GitHub のコミットを固定します。</p>
          <p>生成物、依存ライブラリ・ロックファイル、SVG を含む画像・メディア・バイナリを除外し、残る対象テキスト・ソース全件を採点と理由生成の両方に渡します。個々のファイルを黙って切り詰めません。</p>
          <p>設定されたソース容量・コンテキスト上限を超えた場合は、部分採点せず停止して確認対象にします。</p>
          <p>使いやすさもソースから推定します。リポジトリやテストは実行せず、審査中の Web 検索、実機・ブラウザや外部デモの操作は行いません。</p>
        </section>
        <section class="rubric-axis">
          <h3>02 新機能と製品のつながり</h3>
          <p class="rubric-focus">主催者が確認した有限の DevDay 2026 機能一覧と照合します。参照版: ${esc(DEVDAY_REFERENCE_VERSION)}</p>
          <p><a href="https://openai.com/index/devday-2026-recap/" target="_blank" rel="noreferrer noopener">公式発表</a>と<a href="https://learn.chatgpt.com/docs/whats-new/devday-2026" target="_blank" rel="noreferrer noopener">DevDay の案内</a>に基づく一覧です。全発表の完全な網羅は保証せず、掲載外の機能を自動で認定しません。</p>
          <p>例: GPT-6.1 Sol、Decisions API、Responses multi-agent、Plugins、Website annotations。対象はこの5つに限りません。</p>
          <p>設定・呼び出し・宣言的メタデータが製品の動作にどうつながるかを読みます。名称・依存関係・README の自己申告や、開発だけの Codex 利用では加点しません。</p>
          <p>目的との適合と統合の質を見ます。機能数だけでは点を付けません。</p>
        </section>
        <section class="rubric-axis">
          <h3>03 点数は Decisions で確定</h3>
          <p class="rubric-focus">Decisions API の対応採点モデル gpt-6-luna が判定します。</p>
          <p>4観点に各5段階、計20条件の成立確率を API の predicate 確率として直接返します。確率が ${esc(CONDITION_PROBABILITY_THRESHOLD * 100)}% 以上なら成立です。</p>
          <p>80% は条件に対するモデルの推定値の閾値で、採点精度80%の保証ではありません。</p>
          <p>アプリが低い段階から連続して成立した最高段階を得点にします。各観点は0・2・4・6・8・10点、合計40点です。自由採点・平均・数値の丸めではありません。</p>
          <p>下位が未成立で上位だけ成立しても、その下位条件の手前で得点を止め、不確かさを記録します。採点の判定元は Decisions だけです。</p>
        </section>
        <section class="rubric-axis">
          <h3>04 理由は GPT-6.1 Sol</h3>
          <p class="rubric-focus">本番は GPT-6.1 Sol medium が採点後に理由を書きます。</p>
          <p>アプリがコミット SHA・ソースハッシュの一致を確認した全対象ソースと、Decisions の確定点・条件別の判定・確率を受け取り、実装根拠に基づいて説明します。</p>
          <p>点数・順位・通過判定や固定ルーブリックを変更する権限はありません。</p>
          <p>「確認メモ」は不足や不確かさを伝える情報です。運営の操作は不要で、確定点・順位・通過判定は維持されます。</p>
        </section>
        <section class="rubric-axis">
          <h3>05 審査指示の改変を検知</h3>
          <p class="rubric-focus">リポジトリの内容を信頼しない証拠として渡し、審査への指示と区別するようモデルに指示します。</p>
          <p>独立した Decisions の攻撃判定で、審査指示を改変しようとする内容の確率を調べます。80% 以上のときだけ「攻撃〇〇点」を表示し、通常は非表示です。攻撃の成功を示すものではありません。</p>
          <p>この指標はぬこぬこ賞だけの判断材料で、40点満点の総合点・順位・通過判定には一切含めません。</p>
        </section>
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
      <summary>まとめて審査する</summary>
      <div class="organizer-body">
        <div class="section-head">
          <div><h2>提出管理</h2><p>回答を貼り付け、内容を確認して一括審査を開始します。</p></div>
          <p id="runner"></p>
        </div>
        <div id="budget" class="budget"></div>
        <fieldset id="controls">
          <legend class="sr-only">審査キューへの登録</legend>
          <div class="section-head">
            <div><h3>一括審査</h3><p>内容を確認して一括開始すると、全件のコミット固定後に採点します。貼り付けやプレビューでは審査費用は発生しません。開始後はタブを閉じても継続します。</p></div>
            <label class="field">
              <span>登録先</span>
              <select id="mode"><option value="production">本番審査</option><option value="validation">検証</option></select>
            </label>
          </div>
          <div class="submission-options">
            <label id="effort-field" class="field" hidden>
              <span>理由生成の推論強度</span>
              <select id="effort"><option value="low">low（軽量）</option><option value="medium">medium（本番と同じ）</option><option value="high">high</option></select>
            </label>
            <p id="mode-note" class="note">本番審査のみ決勝候補に含まれ、理由生成の推論強度は medium 固定です。</p>
          </div>
          <div class="batch">
            <label class="field">
              <span>1. 回答シートを貼り付け</span>
              <textarea id="batch" rows="7" placeholder="Google Forms の回答を見出し行ごと貼り付けてください"></textarea>
            </label>
            <p class="note">最大30回答。提出日時・チーム名・GitHub リポジトリURL・デモURLを取り込み、メールや不要な列はブラウザ内で破棄します。GitHubの公開状態はサーバーで確認します。</p><p class="note">本番の提出締切: 10/18 17:15:59 日本時間（締切時刻を含む）。開始: 17:30 日本時間。全件のソース版を保存後、最大8並列で審査します。検証は今すぐ開始できます。</p><button id="import-review" type="button" class="subtle">2. 内容を確認</button>
            <div id="preview"></div>
            <button id="batch-submit" type="button" class="dark">3. 対象の回答を一括審査</button>
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
      <div class="presentation-launch"><div><button id="presentation-real" type="button" class="dark" disabled aria-describedby="presentation-readiness">発表モード</button><button id="presentation-demo" type="button" class="subtle">演出プレビュー</button></div><p id="presentation-readiness" role="status">本番結果を読み込んでいます。</p></div>
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
    <footer>${esc(EVENT_NAME)} <span>PRELIMINARY REVIEW</span></footer>
  </main>
`;

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let data: Dashboard | null = null;
let mode: Mode = "production";
let selected: string | null = null;
let posting = false;
let refreshing = false;
let automatic = false;
let timer: number | null = null;
let importResult: ImportResult | null = null;
let pendingBatch: { signature: string; sourceSignature: string; payload: string; acknowledged: boolean } | null = null;
let batchMessage = "";
let startTimer: number | null = null;
let retryReviewId: string | null = null;
let retryRequestedEffort: "medium" | "high" | null = null;
let freezeReviewId: string | null = null;
let freezeFeedback: { id: string; message: string } | null = null;
type MetadataDraft = { teamName: string; demoUrl: string; saving: boolean; error: string };
const metadataDrafts = new Map<string, MetadataDraft>();
const metadataFeedback = new Map<string, string>();
let retryFeedback: { id: string; message: string; failed: boolean } | null =
  null;

el<HTMLButtonElement>("presentation-real").addEventListener("click", (event) => {
  if (!data) return;
  const snapshot = capturePresentation(data.items);
  if (snapshot.ready) openPresentation(snapshot, event.currentTarget as HTMLElement);
});
el<HTMLButtonElement>("presentation-demo").addEventListener("click", (event) => openPresentation(demoPresentation(), event.currentTarget as HTMLElement));

el<HTMLButtonElement>("refresh").addEventListener(
  "click",
  () => void refresh(),
);
el<HTMLInputElement>("auto").addEventListener("change", (event) => {
  automatic = (event.currentTarget as HTMLInputElement).checked;
  schedule();
});
document.addEventListener("visibilitychange", () => {
  preview();
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
  preview();
});
el<HTMLSelectElement>("effort").addEventListener("change", () => {
  updateSubmissionOptions();
  preview();
});
el<HTMLTextAreaElement>("batch").addEventListener("input", () => {
  preview();
});
el<HTMLButtonElement>("import-review").addEventListener("click", sanitizeInput);
el<HTMLTextAreaElement>("batch").addEventListener("paste", (event) => {
  if (!event.clipboardData) return;
  event.preventDefault();
  const field = el<HTMLTextAreaElement>("batch");
  const parsed = parseInput(event.clipboardData.getData("text/plain"));
  field.value = parsed.sanitized;
  importResult = parsed;
  preview(false);
});
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
preview();
void refresh();

function selectedSubmissionOptions(): { mode: Mode; effort: Effort } {
  const selectedMode = el<HTMLSelectElement>("mode").value as Mode;
  return {
    mode: selectedMode,
    effort:
      selectedMode === "production"
        ? "medium"
        : (el<HTMLSelectElement>("effort").value as Effort),
  };
}
function updateSubmissionOptions(): void {
  const selection = selectedSubmissionOptions();
  el<HTMLElement>("effort-field").hidden = selection.mode === "production";
  el<HTMLElement>("mode-note").textContent =
    selection.mode === "production"
      ? "本番審査のみ決勝候補に含まれ、理由生成の推論強度は medium 固定です。"
      : `検証結果は決勝候補に含まれません。理由生成の推論強度は ${selection.effort} です。見出し付き回答のほか、チーム名とURLの2列、チーム名とURLのカンマ区切り、URLのみも使えます。提出日時は任意です。`;
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
    processing: "採点中",
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
  if (item.result?.eligibility === "no_implementation") return "実装ファイルなし・選考対象外";
  if (item.result && item.result.repoAssessment !== "scored") return "選考対象外";
  const stage = explanationState(item);
  if (explanationStale(item)) return "採点済み・理由待ちが長期化";
  if (stage) return { pending: "採点済み・理由待ち", processing: "採点済み・理由生成中", completed: "採点済み・理由完了", failed: "採点済み・理由生成失敗" }[stage];
  return needsOrganizerReview(item) ? "主催者確認" : status(item.status);
}
function explanationState(item: Submission): ExplanationState | null {
  if (!item.result) return null;
  if (item.explanationStatus && ["pending", "processing", "completed", "failed"].includes(item.explanationStatus)) return item.explanationStatus;
  if (item.status === "completed") return "completed";
  if (item.status === "failed") return "failed";
  return item.status === "processing" ? "processing" : "pending";
}
function explanationStale(item: Submission): boolean {
  const stage = explanationState(item);
  if (stage !== "pending" && stage !== "processing") return false;
  const updatedAt = Date.parse(item.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > 30 * 60 * 1000;
}
function reviewRequired(item: Submission): boolean {
  return !!(item.result as (NonNullable<Submission["result"]> & { reviewRequired?: boolean }) | null)?.reviewRequired;
}
function stageCounts(items: Submission[]) {
  const count = (stage: ExplanationState) => items.filter((item) => explanationState(item) === stage).length;
  return { scored: items.filter((item) => !!item.result).length, pending: count("pending"), processing: count("processing"), completed: count("completed"), failed: count("failed") };
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
  return normalizeRepository(value);
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
  return !!data?.batches?.some((batch) => ["queued", "freezing", "scoring"].includes(batch.status)) || !!data?.items.some(
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
        (item.demoUrl == null || typeof item.demoUrl === "string") &&
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
  const stages = stageCounts(items);
  const done = stages.scored, total = items.length;
  el<HTMLElement>("stats").innerHTML =
    `<div><span>本番登録</span><strong>${total}<small> / ${data.event.targetTeams}</small></strong></div><div><span>採点済み</span><strong>${done}</strong></div><div><span>未採点</span><strong>${total - done}</strong></div><div><span>理由完了</span><strong>${stages.completed}</strong></div>`;
  el<HTMLElement>("progress").innerHTML =
    `<div class="progress-label"><span>本番の採点進捗</span><span>${total ? Math.round((done / total) * 100) : 0}%</span></div><progress max="${Math.max(total, 1)}" value="${done}">${done} / ${total}</progress><p>本番 ${done} / ${total} 件を採点済み · 理由完了 ${stages.completed} / ${total} · 理由待ち ${stages.pending} · 理由生成中 ${stages.processing} · 理由生成失敗 ${stages.failed} · 採点失敗 ${items.filter((item) => !item.result && item.status === "failed").length}</p>${renderBatches()}`;
}
function renderBatches(): string {
  const labels = { queued: "待機中", freezing: "ソース版を固定中", scoring: "審査中", completed: "完了", failed: "失敗" };
  const markup = (data?.batches || []).map((batch) => {
    const items = (data?.items || []).filter((item) => (item as Submission & { batchId?: string }).batchId === batch.id);
    const stages = stageCounts(items);
    const scored = batch.scoredCount ?? stages.scored;
    const stageSummary = `採点済み ${scored} / ${batch.counts.total} · 採点中 ${items.filter((item) => !item.result && item.status === "processing").length} · 理由待ち ${stages.pending} · 理由生成中 ${stages.processing} · 理由完了 ${stages.completed} · 理由生成失敗 ${stages.failed} · 採点失敗 ${items.filter((item) => !item.result && item.status === "failed").length}`;
    const dispatches = batch.freezeDispatches ?? 1;
    const limit = batch.maxFreezeDispatches ?? 3;
    const recoverable = needsFreezeRetry(batch);
    const beforeStart = batch.mode === "production" && Date.now() < Date.parse(JUDGING_START_ISO);
    const disabled = posting || beforeStart;
    const controls = recoverable ? `<div class="freeze-retry"><p>コミット固定の登録・再送 ${esc(dispatches)} / ${esc(limit)} 回</p>${dispatches >= limit ? `<p>コミット固定の登録・再送の上限に達しています。</p>` : freezeReviewId === batch.id ? `<p>コミット固定を再開します。全件のSHAを保存してから最大8並列で審査します。確認すると登録・再送を1回消費します（最大${esc(limit)}回）。審査にはAPI費用が発生します。</p><div class="retry-actions"><button type="button" class="dark" data-freeze-confirm="${esc(batch.id)}"${disabled ? " disabled" : ""}>確認してコミット固定を再試行</button><button type="button" class="subtle" data-freeze-cancel="${esc(batch.id)}"${posting ? " disabled" : ""}>キャンセル</button></div>` : `<button type="button" class="subtle" data-freeze-prepare="${esc(batch.id)}"${disabled ? " disabled" : ""}>コミット固定を再試行</button>`}${beforeStart ? `<p>本番審査は10/18 17:30 日本時間から再試行できます。</p>` : ""}</div>` : "";
    return `<section class="batch-progress"><h3>${batch.mode === "production" ? "本番" : "検証"} · ${esc(labels[batch.status])}</h3><p>受付ID: ${esc(batch.id)}</p><p>ソース版固定 ${esc(batch.frozenCount)} / ${esc(batch.counts.total)} 件 · 待機 ${esc(batch.counts.queued)}</p><p>${esc(stageSummary)}</p><p>全件のSHAを保存してから最大8並列で採点します。</p>${batch.failureMessage ? `<p role="alert">${esc(batch.failureMessage)}</p>` : ""}${freezeFeedback?.id === batch.id ? `<p role="status">${esc(freezeFeedback.message)}</p>` : ""}${controls}</section>`;
  }).join("");
  return markup;
}
function needsFreezeRetry(batch: Batch): boolean {
  if (batch.frozenAt !== null) return false;
  if (batch.status === "failed") return true;
  const timestamp = batch.status === "queued" ? batch.freezeRequestedAt : batch.status === "freezing" ? batch.startedAt : null;
  if (!timestamp) return false;
  const time = Date.parse(timestamp);
  return Number.isFinite(time) && Date.now() - time >= 30 * 60 * 1000;
}
function canFreezeRetry(batch: Batch): boolean {
  return needsFreezeRetry(batch) && (batch.freezeDispatches ?? 1) < (batch.maxFreezeDispatches ?? 3) && (batch.mode !== "production" || Date.now() >= Date.parse(JUDGING_START_ISO));
}
el<HTMLElement>("progress").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!button || posting) return;
  if (button.dataset.freezeCancel) { freezeReviewId = null; stats(); return; }
  const id = button.dataset.freezePrepare || button.dataset.freezeConfirm;
  const batch = data?.batches?.find((item) => item.id === id);
  if (!batch || !canFreezeRetry(batch)) return;
  if (button.dataset.freezePrepare) { freezeReviewId = batch.id; stats(); }
  else if (freezeReviewId === batch.id) void retryFreeze(batch.id);
});
async function retryFreeze(id: string): Promise<void> {
  const batch = data?.batches?.find((item) => item.id === id);
  if (posting || freezeReviewId !== id || !batch || !canFreezeRetry(batch)) return;
  posting = true;
  freezeFeedback = null;
  render();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`/api/batches/${encodeURIComponent(id)}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }), signal: controller.signal });
    const body = await response.json() as { batch?: Batch; submissions?: Submission[]; message?: string };
    if (response.status !== 202) throw new Error(body.message || `HTTP ${response.status}`);
    if (body.batch?.id !== id || !Array.isArray(body.submissions)) throw new Error("登録結果を確認できませんでした。手動更新で確認してください。");
    if (data) {
      data.batches = [...(data.batches || []).filter((item) => item.id !== id), body.batch];
      const incoming = body.submissions;
      data.items = [...data.items.filter((item) => !incoming.some((value) => value.id === item.id)), ...incoming];
    }
    freezeFeedback = { id, message: "コミット固定の再試行を受け付けました。" };
  } catch (error) {
    freezeFeedback = { id, message: error instanceof Error ? error.message : "コミット固定の再試行を登録できませんでした。" };
  } finally {
    clearTimeout(timeout);
    posting = false;
    freezeReviewId = null;
    render();
    void refresh();
  }
}
function organizer(): void {
  el<HTMLFieldSetElement>("controls").disabled = posting || data?.open === false;
  if (data) {
    const budget = data.budget;
    el<HTMLElement>("budget").innerHTML =
      `<div><span>使用済み</span><strong>${money(budget.spentUsd)}</strong></div><div><span>予約済み</span><strong>${money(budget.reservedUsd)}</strong></div><div><span>残額</span><strong>${money(budget.remainingUsd)}</strong></div><div><span>上限</span><strong>${money(budget.limitUsd)}</strong></div><p>概算 USD</p>`;
    el<HTMLElement>("runner").textContent = data.runner.online
      ? "クラウド自動審査: 有効"
      : "クラウド自動審査: 停止中（再開待ち）";

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
        (a.result ? 0 : 1) -
          (b.result ? 0 : 1) ||
        b.createdAt.localeCompare(a.createdAt),
    )
    .map((item) => ({ item, position: null }));
  return [...ranked, ...rest];
}
function renderResults(): void {
  if (!data) return;
  const presentation = capturePresentation(data.items);
  el<HTMLButtonElement>("presentation-real").disabled = !presentation.ready;
  el<HTMLElement>("presentation-readiness").textContent = presentation.message;
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
    production.filter((item) => !!item.result).length <
      data.event.targetTeams ||
    production.some(
      (item) => !item.result,
    );
  el<HTMLElement>("cutoff").textContent =
    mode === "validation"
      ? "検証結果は決勝選考に含まれません。"
      : data.cutoff.tied
        ? `通過ライン ${data.cutoff.score}点: 同点${data.cutoff.tiedCount}チーム全員通過${provisional ? " · 暫定" : ""}`
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
    `<div class="list-heading"><h3>${mode === "production" ? (provisional ? "暫定通過候補・審査一覧" : "決勝進出・審査一覧") : "検証一覧"}</h3><span>${visible.length} 件</span></div><div class="table-head"><span>順位 / チーム・リポジトリ</span>${axes.map((axis) => `<span>${esc(axis.label)}</span>`).join("")}<span>合計</span><span>状態</span></div>` +
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
        return `<div class="result-entry"><button type="button" class="result-row${selected === item.id ? " selected" : ""}${atCutoff ? " cutoff-row" : ""}" data-id="${esc(item.id)}" aria-pressed="${selected === item.id}" aria-controls="detail"><span class="row-primary"><span class="rank">${position === null ? "--" : String(position).padStart(2, "0")}</span><span class="team-block"><strong>${esc(item.teamName || "チーム名未設定")}</strong><small>${esc(item.repo.normalized)}</small></span></span>${scores}<span class="total">${item.result ? `${esc(item.result.total)}<small>/40</small>` : "--"}${attack(item.result?.attackScore)}</span><span class="status ${item.status}">${esc(statusLabel(item))}${reviewRequired(item) ? `<small class="review-badge">確認メモ</small>` : ""}</span></button><div class="result-demo">${demoLink(item.demoUrl)}</div></div>`;
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
  const existingEditor = el<HTMLElement>("detail").querySelector<HTMLElement>(".metadata-editor");
  const expandedConditions = new Set([...el<HTMLElement>("detail").querySelectorAll<HTMLDetailsElement>("details.condition-checks[open]")].map((entry) => entry.dataset.criterion));
  const editorFocus = existingEditor?.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const result = item.result;
  const explanation = explanationState(item);
  const reasonsComplete = explanation === "completed";
  const reasonText = explanationStale(item) ? "理由の処理が30分以上更新されていません" : explanation === "failed" ? "理由の生成に失敗しました。再試行は任意です" : "理由を生成中です";
  const qualification =
    mode === "production" &&
    position !== null &&
    position <= data!.event.finalistCount
      ? data!.cutoff.tied && data!.cutoff.score === result?.total
        ? provisional ? "暫定通過候補 · 同点全員通過" : "決勝進出 · 同点全員通過"
        : provisional
          ? "暫定通過候補"
          : "決勝進出"
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
    `<div class="detail-head"><p class="kicker">SUBMISSION DETAIL</p><span class="status ${item.status}">${statusLabel(item)}</span></div><h3>${esc(item.teamName || "チーム名未設定")}</h3><p class="detail-repo">${safe ? `<a href="${esc(safe.url)}" target="_blank" rel="noopener noreferrer">${esc(item.repo.normalized)}</a>` : esc(item.repo.normalized)}</p><p class="detail-demo">${demoLink(item.demoUrl)}</p><div id="metadata-editor-host"></div>${qualification ? `<p class="qualification">${qualification}</p>` : ""}<dl class="metadata"><div><dt>審査区分</dt><dd>${item.mode === "production" ? "本番審査" : "検証"}</dd></div><div><dt>理由生成の推論強度</dt><dd>${esc(recordedEffort(item) || "--")}</dd></div><div><dt>登録</dt><dd>${date(item.createdAt)}</dd></div><div><dt>理由完了</dt><dd>${date(item.completedAt)}</dd></div><div><dt>評価した版</dt><dd class="sha">${pinned ? `<a href="${esc(pinned)}" target="_blank" rel="noopener noreferrer">${esc(result!.pinnedSha!.slice(0, 12))}</a>` : "--"}</dd></div></dl>${
      result
        ? `<div class="detail-total"><span>総合点</span><strong>${esc(result.total)}<small> / 40</small></strong></div>${attack(result.attackScore)}${typeof result.attackScore === "number" && result.attackScore >= 80 ? `<p class="note">攻撃評価は独立した指標で、40点満点の総合点には含まれません。</p>` : ""}${reviewRequired(item) ? `<p class="review-badge">確認メモ</p><p class="note">根拠や生成理由に不足・不確かさがあります。操作は不要です。Decisionsの確定点・順位・通過判定を維持します。</p>` : ""}${reasonsComplete ? `<h4>評価概要</h4><p>${esc(result.summary)}</p><h4>公開コメント</h4><p>${esc(result.publicReason)}</p>` : `<div class="explanation-stage" role="status"><h4>${esc(statusLabel(item))}</h4><p>${reasonText}。この採点結果は確定済みです。理由の生成で点数は変わりません。</p>${explanation === "failed" && item.failureMessage ? `<p>${esc(item.failureMessage)}</p>` : ""}</div>`}<p class="note">${esc(assessments[result.repoAssessment] || "リポジトリの評価結果")}</p><div class="criteria">${axes
            .map((axis) => {
              const criterion = result.criteria.find(
                (value) => value.key === axis.key,
              );
              const checks = result.usage?.decisionsConditions;
              const conditions = checks ? `<details class="condition-checks" data-criterion="${axis.key}"${expandedConditions.has(axis.key) ? " open" : ""}><summary>段階条件の判定を見る</summary><p class="note">下位から連続して確認できた最高段階が得点です。${esc(SOURCE_EVIDENCE)}</p><ul>${DECISION_CONDITIONS.filter((condition) => condition.key === axis.key).map((condition) => `<li><strong>${condition.level}点条件: ${checks[condition.name] === true ? "確認済み" : "未達・根拠未確認"}</strong><p>${esc(condition.description.slice(SOURCE_EVIDENCE.length))}</p></li>`).join("")}</ul></details>` : "";
              return `<section><div class="criterion-head"><h5>${esc(axis.label)}</h5><strong>${criterion ? esc(criterion.score) : "--"}<small> / 10</small></strong></div><p>${reasonsComplete ? esc(criterion?.reason || "評価理由はありません。") : reasonText}</p>${conditions}<div class="evidence"><span>根拠ファイル</span>${
                !reasonsComplete ? "<p>理由と根拠は生成後に表示します</p>" : criterion?.evidencePaths.length
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
  renderMetadataEditor(item, existingEditor);
  if (editorFocus?.isConnected) editorFocus.focus({ preventScroll: true });
  const metadata = item as Submission & { submittedAt?: string; pinnedSha?: string | null; frozenAt?: string | null };
  const extra = document.createElement("dl");
  extra.className = "metadata";
  const stages = document.createElement("dl");
  stages.className = "metadata";
  stages.innerHTML = `<div><dt>採点確定日時</dt><dd>${date(item.scoredAt ?? null)}</dd></div><div><dt>採点モデル</dt><dd>${esc(result?.usage?.decisionsModel || result?.usage?.model || "gpt-6-luna")}</dd></div><div><dt>理由生成</dt><dd>${explanation ? esc(statusLabel(item)) : "採点後に開始"}（GPT-6.1 Sol）</dd></div>`;
  if (result?.usage?.rubricVersion) {
    const version = document.createElement("div");
    version.innerHTML = `<dt>採点基準の版</dt><dd>${esc(result.usage.rubricVersion)}</dd>`;
    stages.append(version);
  }
  if (result?.usage?.fullSource) {
    const coverage = document.createElement("div");
    coverage.innerHTML = `<dt>評価したソース</dt><dd>対象テキスト全文・${esc(result.usage.sourceFiles ?? 0)}ファイル・${esc(((result.usage.sourceBytes ?? 0) / 1024).toFixed(1))}KB</dd>`;
    stages.append(coverage);
  }
  el<HTMLElement>("detail").append(stages);
  extra.innerHTML = `${metadata.submittedAt ? `<div><dt>提出日時</dt><dd>${esc(formatTimestampJst(metadata.submittedAt))}</dd></div>` : ""}${metadata.frozenAt ? `<div><dt>ソース版固定日時</dt><dd>${esc(formatTimestampJst(metadata.frozenAt))}</dd></div>` : ""}${metadata.pinnedSha && /^[a-fA-F0-9]{40}$/.test(metadata.pinnedSha) ? `<div><dt>固定済みSHA</dt><dd class="sha">${esc(metadata.pinnedSha)}</dd></div>` : ""}`;
  el<HTMLElement>("detail").append(extra);
  renderRetryControls(item);
}

function demoLink(value?: string | null, missing = "デモ未設定"): string {
  const url = normalizeDemoUrl(value || "");
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">デモを見る</a>` : `<span class="demo-missing">${esc(missing)}</span>`;
}

function renderMetadataEditor(item: Submission, previous: HTMLElement | null): void {
  const host = el<HTMLElement>("metadata-editor-host");
  const draft = metadataDrafts.get(item.id);
  if (draft && previous?.dataset.recordId === item.id && previous.querySelector("form")) {
    host.append(previous);
    updateMetadataEditor(previous, draft);
    return;
  }
  const section = document.createElement("section");
  section.className = "metadata-editor";
  section.dataset.recordId = item.id;
  section.innerHTML = draft ? `<form novalidate><label>チーム名<textarea name="teamName" maxlength="100" rows="2" required>${esc(draft.teamName)}</textarea></label><label>デモURL<input name="demoUrl" maxlength="2048" value="${esc(draft.demoUrl)}" inputmode="url"></label><p class="note">表示情報だけを変更します。再審査やAPI費用は発生しません。</p><p class="metadata-error" role="alert"></p><div class="metadata-actions"><button type="submit" class="subtle">表示情報を保存</button><button type="button" class="subtle" data-cancel>キャンセル</button></div></form>` : `<button type="button" class="subtle" data-edit>表示情報を編集</button><p role="status">${esc(metadataFeedback.get(item.id) || "")}</p>`;
  host.append(section);
  section.querySelector("[data-edit]")?.addEventListener("click", () => {
    metadataDrafts.set(item.id, { teamName: item.teamName || "", demoUrl: item.demoUrl || "", saving: false, error: "" });
    metadataFeedback.delete(item.id);
    renderResults();
  });
  if (!draft) return;
  updateMetadataEditor(section, draft);
  section.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea").forEach((input) => input.addEventListener("input", () => {
    if (input.name === "teamName") draft.teamName = input.value;
    else draft.demoUrl = input.value;
    draft.error = "";
    updateMetadataEditor(section, draft);
  }));
  section.querySelector("[data-cancel]")?.addEventListener("click", () => {
    if (draft.saving) return;
    metadataDrafts.delete(item.id);
    renderResults();
  });
  section.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveMetadata(item.id, draft, section);
  });
}

function updateMetadataEditor(section: HTMLElement, draft: MetadataDraft): void {
  section.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>("button, input, textarea").forEach((control) => { control.disabled = draft.saving; });
  const alert = section.querySelector<HTMLElement>(".metadata-error");
  if (alert) alert.textContent = draft.error;
  const save = section.querySelector<HTMLButtonElement>("button[type='submit']");
  if (save) save.textContent = draft.saving ? "保存中" : "表示情報を保存";
}

async function saveMetadata(id: string, draft: MetadataDraft, section: HTMLElement): Promise<void> {
  if (draft.saving) return;
  const teamName = draft.teamName.trim();
  const demoUrl = normalizeDemoUrl(draft.demoUrl);
  if (!teamName || teamName.length > 100) draft.error = "チーム名は100文字以内で入力してください。";
  else if (!demoUrl && (draft.demoUrl.trim() || /[\u0000-\u001f\u007f-\u009f\\]/.test(draft.demoUrl))) draft.error = "デモURLは認証情報を含まないHTTP・HTTPSのURLを2048文字以内で入力してください。";
  else draft.error = "";
  if (draft.error) { updateMetadataEditor(section, draft); return; }
  draft.saving = true;
  updateMetadataEditor(section, draft);
  try {
    const response = await fetch(`/api/submissions/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamName, demoUrl }) });
    if (response.status !== 200) throw new Error("save failed");
    const body: unknown = await response.json();
    const saved = (body as { submission?: Partial<Submission> } | null)?.submission;
    if (!saved || saved.id !== id || typeof saved.teamName !== "string" || !saved.teamName.trim() || saved.teamName !== saved.teamName.trim() || saved.teamName.length > 100 || (saved.demoUrl != null && (typeof saved.demoUrl !== "string" || normalizeDemoUrl(saved.demoUrl) !== saved.demoUrl))) throw new Error("invalid response");
    const metadata = { teamName: saved.teamName, demoUrl: saved.demoUrl ?? null };
    if (data) {
      data.items = data.items.map((item) => item.id === id ? { ...item, ...metadata } : item);
      data.ranking = data.ranking.map((entry) => entry.submissionId === id ? { ...entry, ...metadata } : entry);
    }
    metadataDrafts.delete(id);
    metadataFeedback.set(id, "表示情報を保存しました。");
    renderResults();
  } catch {
    draft.error = "保存できませんでした。入力を保持しています。もう一度保存してください。";
  } finally {
    draft.saving = false;
    updateMetadataEditor(section, draft);
    const currentEditor = el<HTMLElement>("detail").querySelector<HTMLElement>(".metadata-editor");
    if (currentEditor?.dataset.recordId === id) updateMetadataEditor(currentEditor, draft);
  }
}
let presentationOpen = false;

function openPresentation(snapshot: PresentationSnapshot, opener: HTMLElement): void {
  if (presentationOpen) return;
  presentationOpen = true;
  const dialog = document.createElement("section");
  dialog.className = `presentation-overlay${snapshot.mode === "demo" ? " presentation-demo" : ""}`;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "presentation-title");
  dialog.tabIndex = -1;
  const previousOverflow = document.body.style.overflow;
  const background = Array.from(document.body.children).filter((node): node is HTMLElement => node instanceof HTMLElement).map((node) => ({ node, inert: node.inert }));
  background.forEach(({ node }) => { node.inert = true; });
  document.body.style.overflow = "hidden";
  document.body.append(dialog);
  let pending: number | null = null;
  let lastAdvanceAt = -Infinity;
  let state: RevealState = { revealed: 0, busy: false };
  let selection = selectPresentation(snapshot);
  let started = false;
  const music = createPresentationAudio();
  let musicMuted = false;
  let musicStarted = false;
  let musicStarting = false;
  music.setVolume(0.35);
  const badge = snapshot.mode === "demo" ? "DEMO / 架空データ・演出プレビュー" : "REAL / 本番結果";
  dialog.innerHTML = `<div class="presentation-inner"><header class="presentation-header"><div><p class="presentation-badge">${badge}</p><h2 id="presentation-title">次のステージへ。</h2></div><button type="button" id="stage-close">閉じる <span aria-hidden="true">×</span></button></header><div class="presentation-audio" aria-label="発表BGM"><button type="button" id="bgm-toggle" aria-pressed="true">BGM: オン</button><label for="bgm-volume">音量 <span id="bgm-volume-label">35%</span></label><input id="bgm-volume" type="range" min="0" max="100" step="5" value="35" aria-label="BGMの音量"><span id="bgm-status" role="status">発表開始と同時に再生します。</span></div><p class="presentation-local">開始時の結果で固定します。</p><div id="stage-setup" class="presentation-setup"><p class="presentation-eyebrow">BEFORE THE SPOTLIGHT</p><h3>${selection.order.length}チームの発表を準備</h3><p>低い点数から順に、1チームずつ発表します。10位と同点は全員通過し、同率順位で表示します。</p>${snapshot.warnings.map((warning) => `<p class="presentation-warning">${esc(warning)}</p>`).join("")}<p id="stage-selection" role="status"></p><button type="button" id="stage-start">発表画面へ</button></div><div id="stage-show" hidden><div id="stage-card" class="presentation-card"></div><div class="presentation-controls"><button type="button" id="stage-back">戻る</button><button type="button" id="stage-next" class="presentation-next">一つ発表</button><button type="button" id="stage-restart">最初から</button><span id="stage-progress"></span></div><p class="presentation-keyboard">Space / → 次へ · ← 戻る · Escape 閉じる</p></div><ol id="stage-slots" class="presentation-slots" aria-label="発表済みチームと未発表の枠"></ol><p id="stage-live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p></div>`;
  const get = <T extends HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!;
  get("presentation-title").textContent = "決勝進出 発表ステージ";
  const startMusic = async () => {
    if (musicMuted || musicStarted || musicStarting) return;
    musicStarting = true;
    try {
      await music.start();
      if (!dialog.isConnected || !started) { music.stop(); return; }
      musicStarted = true;
      get("bgm-status").textContent = musicMuted ? "BGMをミュートしています。" : "BGMを再生中です。";
    } catch {
      if (!dialog.isConnected) return;
      musicMuted = true;
      music.setMuted(true);
      get("bgm-toggle").textContent = "BGM: 再生する";
      get("bgm-toggle").setAttribute("aria-pressed", "false");
      get("bgm-status").textContent = "音声を開始できませんでした。BGMボタンで再試行できます。";
    } finally {
      musicStarting = false;
    }
  };
  get("bgm-toggle").addEventListener("click", () => {
    musicMuted = !musicMuted;
    music.setMuted(musicMuted);
    get("bgm-toggle").textContent = musicMuted ? "BGM: オフ" : "BGM: オン";
    get("bgm-toggle").setAttribute("aria-pressed", String(!musicMuted));
    get("bgm-status").textContent = musicMuted ? "BGMをミュートしています。" : started ? "BGMを再生中です。" : "発表開始と同時に再生します。";
    if (started && !musicMuted) void startMusic();
  });
  get<HTMLInputElement>("bgm-volume").addEventListener("input", (event) => {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    music.setVolume(value / 100);
    get("bgm-volume-label").textContent = `${value}%`;
  });
  const cancel = () => {
    if (pending !== null) window.clearTimeout(pending);
    pending = null;
  };
  const updateSelection = () => {
    selection = selectPresentation(snapshot);
    get("stage-selection").textContent = selection.message;
    get<HTMLButtonElement>("stage-start").disabled = !selection.valid;
  };
  const renderStage = () => {
    const entry = state.revealed ? selection.order[state.revealed - 1] : null;
    const card = get("stage-card");
    card.className = `presentation-card${state.busy ? " is-anticipating" : ""}${!state.busy && entry?.rank === 1 ? " is-winner" : ""}`;
    card.innerHTML = state.busy ? `<div class="presentation-covered"><span class="presentation-spark" aria-hidden="true"></span><p>NEXT SPOTLIGHT</p><h3>次のアイデアに、光を。</h3><p>まもなく発表</p></div>` : entry ? `<div class="presentation-reveal"><p class="presentation-rank">${rankLabel(entry)}</p><h3 class="presentation-team">${esc(entry.teamName)}</h3><p class="presentation-demo-link">${demoLink(entry.demoUrl, snapshot.mode === "demo" ? "デモ未設定（架空データ）" : "デモ未設定")}</p><p class="presentation-score">${esc(entry.total)}<span> / 40</span></p><dl class="presentation-axes">${axes.map((axis) => `<div><dt>${esc(axis.label)}</dt><dd>${esc(entry.criteria.find((criterion) => criterion.key === axis.key)?.score ?? "--")}<small> / 10</small></dd></div>`).join("")}</dl>${entry.rank === 1 ? `<div class="presentation-celebration" aria-hidden="true">${Array.from({ length: 12 }, (_, index) => `<i style="--ray:${index}"></i>`).join("")}</div>` : ""}</div><figure class="presentation-mascot"><img src="/images/nukoevi-original.jpg" width="886" height="886" alt="発表を見守るぬこエビ"><figcaption>YOUR NEXT STAGE</figcaption></figure>` : `<div class="presentation-covered"><span class="presentation-spark" aria-hidden="true"></span><p>${selection.order.length} IDEAS / ONE NEXT STAGE</p><h3>そのアイデアに、<br>スポットライトを。</h3><p>チーム名と点数は発表までお楽しみに。</p></div>`;
    get("stage-slots").innerHTML = Array.from({ length: selection.order.length }, (_, index) => {
      const revealed = index < state.revealed ? selection.order[index] : null;
      return revealed ? `<li class="is-revealed"><span>${rankLabel(revealed)}</span><strong>${esc(revealed.teamName)}</strong><span>${esc(revealed.total)} / 40</span></li>` : `<li><span>発表枠 ${index + 1}</span><strong>未発表</strong><span aria-hidden="true">•••</span></li>`;
    }).join("");
    get<HTMLButtonElement>("stage-next").disabled = state.busy || state.revealed === selection.order.length;
    get("stage-next").textContent = state.revealed === selection.order.length ? "完了" : state.busy ? "発表中…" : state.revealed === 0 ? "一つ発表" : "次を発表";
    get<HTMLButtonElement>("stage-back").disabled = state.busy || state.revealed === 0;
    get("stage-progress").textContent = `${state.revealed} / ${selection.order.length} 発表済み`;
  };
  const advance = (event: { detail?: number; repeat?: boolean }) => {
    if (!started || !acceptsAdvance(state, { detail: event.detail ?? 0, repeat: event.repeat ?? false, elapsedMs: Date.now() - lastAdvanceAt }, selection.order.length)) return;
    lastAdvanceAt = Date.now();
    state = revealState(state, "begin", selection.order.length);
    renderStage();
    dialog.focus({ preventScroll: true });
    let reduced = false;
    try { reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; } catch { reduced = false; }
    pending = window.setTimeout(() => {
      pending = null;
      state = revealState(state, "complete", selection.order.length);
      renderStage();
      const entry = selection.order[state.revealed - 1]!;
      if (musicStarted) music.cue?.(entry.rank);
      get("stage-live").textContent = `${snapshot.mode === "demo" ? "架空データ。" : ""}${rankLabel(entry)}、${entry.teamName}、${entry.total}点、40点満点。`;
    }, reduced ? 60 : 650);
  };
  const back = () => {
    if (!started || state.busy) return;
    lastAdvanceAt = -Infinity;
    state = revealState(state, "back");
    get("stage-live").textContent = "";
    renderStage();
    dialog.focus({ preventScroll: true });
  };
  const close = () => {
    cancel();
    music.stop();
    document.removeEventListener("focusin", containFocus);
    dialog.remove();
    background.forEach(({ node, inert }) => { node.inert = inert; });
    document.body.style.overflow = previousOverflow;
    presentationOpen = false;
    if (opener.isConnected) opener.focus({ preventScroll: true });
  };
  const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href], [tabindex='0']")).filter((node) => !node.closest("[hidden]") && node.tabIndex >= 0);
  const containFocus = (event: FocusEvent) => {
    if (!dialog.contains(event.target as Node)) (focusable()[0] ?? dialog).focus({ preventScroll: true });
  };
  document.addEventListener("focusin", containFocus);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab") {
      const nodes = focusable();
      const first = nodes[0] ?? dialog;
      const last = nodes[nodes.length - 1] ?? dialog;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first.focus(); }
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("input, select, textarea, a, [contenteditable]")) return;
    if (event.repeat) { if ([" ", "Enter", "ArrowRight", "ArrowLeft"].includes(event.key)) event.preventDefault(); return; }
    if (event.key === " " && target.closest("button")) return;
    if ([" ", "ArrowRight", "ArrowLeft"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "ArrowLeft") back(); else advance(event);
    }
  });
  get("stage-close").addEventListener("click", close);
  get("stage-start").addEventListener("click", () => {
    if (!selection.valid || started) return;
    started = true;
    void startMusic();
    dialog.classList.add("is-presenting");
    dialog.querySelector(".presentation-local")?.remove();
    get("stage-setup").remove();
    get("stage-show").hidden = false;
    renderStage();
    dialog.focus({ preventScroll: true });
  });
  get("stage-next").addEventListener("click", advance);
  get("stage-back").addEventListener("click", back);
  get("stage-restart").addEventListener("click", () => {
    cancel();
    lastAdvanceAt = -Infinity;
    state = revealState(state, "restart");
    get("stage-live").textContent = "";
    renderStage();
    dialog.focus({ preventScroll: true });
  });
  updateSelection();
  renderStage();
  get("stage-close").focus({ preventScroll: true });
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
  return "effort" in item && (item.effort === "low" || item.effort === "medium" || item.effort === "high")
    ? item.effort
    : item.result?.usage?.effort || null;
}
function unfrozenBatch(item: Submission): Batch | undefined {
  return data?.batches?.find((batch) => batch.id === (item as Submission & { batchId?: string }).batchId && !batch.frozenAt);
}
function retryAllowed(item: Submission): boolean {
  if (unfrozenBatch(item) || (item.mode === "production" && Date.now() < Date.parse(JUDGING_START_ISO))) return false;
  return item.result ? (explanationState(item) === "failed" || explanationStale(item)) && (item.explanationDispatches ?? 0) > 0 && (item.explanationDispatches ?? 0) < 3 : canRetry(item);
}
function renderRetryControls(item: Submission): void {
  if (recoveryCandidate(item)) {
    renderRecoveryControls(item);
    return;
  }
  if (item.result && (item.explanationDispatches ?? 0) === 0) return;
  const reasonRetry = !!item.result;
  const failed = reasonRetry ? explanationState(item) === "failed" || explanationStale(item) : item.status === "failed" || needsOrganizerReview(item);
  const feedback = retryFeedback?.id === item.id ? retryFeedback : null;
  if (!failed && !feedback) return;
  const section = document.createElement("section");
  section.className = "retry-controls";
  const beforeStart = item.mode === "production" && Date.now() < Date.parse(JUDGING_START_ISO);
  const frozen = unfrozenBatch(item);
  const eligible = retryAllowed(item);
  const disabled = posting || beforeStart;
  const limit = reasonRetry ? (item.explanationDispatches ?? 0) >= 3 ? "理由生成の登録・再送の上限（3回）に達しています。" : "" : retryLimitMessage(item);
  section.innerHTML = `<h4>${reasonRetry ? "評価理由を再生成" : "主催者による再審査"}</h4>${feedback ? `<p role="${feedback.failed ? "alert" : "status"}">${esc(feedback.message)}</p>` : ""}${frozen ? "<p>この提出は一括審査のコミット固定待ちです。進行状況からコミット固定を再試行してください。</p>" : beforeStart ? "<p>本番審査は10/18 17:30 日本時間から再試行できます。</p>" : eligible ? retryReviewId === item.id ? `${reasonRetry && item.mode === "validation" ? `<label class="field"><span>理由生成の推論強度</span><select id="retry-effort"${posting ? " disabled" : ""}><option value=""${retryRequestedEffort === null ? " selected" : ""}>記録済みの強度を維持</option><option value="medium"${retryRequestedEffort === "medium" ? " selected" : ""}>medium</option><option value="high"${retryRequestedEffort === "high" ? " selected" : ""}>high</option></select></label>` : ""}<p>${reasonRetry ? "点数・順位は変えず、理由だけを生成します。追加API費用が発生します" : "記録済みの理由生成の推論強度で、新しいクラウド審査をキューへ追加します。未確定の費用予約は保持され、追加のAPI費用が発生します。"}${reasonRetry && item.mode === "production" ? "。理由生成の推論強度は medium 固定です。" : ""}</p><div class="retry-actions"><button id="retry-confirm" type="button" class="dark"${disabled ? " disabled" : ""}>${posting ? "登録中です" : reasonRetry ? "費用を確認して評価理由を再生成" : "費用を確認して再審査"}</button><button id="retry-cancel" type="button" class="subtle"${posting ? " disabled" : ""}>キャンセル</button></div>` : `<p>${reasonRetry ? `理由生成の登録・再送 ${item.explanationDispatches ?? 0} / 3回` : `審査実行 ${retryAttempts(item)} / 3回、登録・再送 ${retryDispatches(item)} / 3回`}</p><button id="retry-prepare" type="button" class="dark"${disabled ? " disabled" : ""}>${reasonRetry ? "評価理由を再生成" : "再審査を準備"}</button>` : `<p>${esc(limit)}</p>`}`;
  el<HTMLElement>("detail").append(section);
  section.querySelector<HTMLButtonElement>("#retry-prepare")?.addEventListener("click", () => {
    if (posting || !retryAllowed(item)) return;
    retryReviewId = item.id;
    retryRequestedEffort = null;
    renderResults();
  });
  section.querySelector<HTMLSelectElement>("#retry-effort")?.addEventListener("change", (event) => {
    if (posting) return;
    const value = (event.currentTarget as HTMLSelectElement).value;
    retryRequestedEffort = value === "high" ? "high" : value === "medium" ? "medium" : null;
    renderResults();
  });
  section.querySelector<HTMLButtonElement>("#retry-cancel")?.addEventListener("click", () => {
    retryReviewId = null;
    retryRequestedEffort = null;
    renderResults();
  });
  section.querySelector<HTMLButtonElement>("#retry-confirm")?.addEventListener("click", () => void retrySubmission(item.id));
}
function recoveryCandidate(item: Submission): boolean {
  const started = Date.parse(item.startedAt || "");
  return item.status === "processing" && !item.result && (item.recoveryDispatches ?? 0) === 0
    && Number.isFinite(started) && Date.now() - started >= 5 * 60 * 1000;
}
function renderRecoveryControls(item: Submission): void {
  const section = document.createElement("section");
  section.className = "retry-controls";
  const feedback = retryFeedback?.id === item.id ? retryFeedback : null;
  section.innerHTML = `<h4>停止した審査を確認</h4><p>課金前に止まった審査だけを同じソースから続行できます。利用済みの審査費用がある場合は復旧を受け付けません。1件につき1回までです。</p>${feedback ? `<p role="${feedback.failed ? "alert" : "status"}">${esc(feedback.message)}</p>` : ""}<button type="button" class="dark"${posting ? " disabled" : ""}>${posting ? "確認中です" : "課金前の停止を復旧"}</button>`;
  section.querySelector("button")?.addEventListener("click", () => void recoverSubmission(item));
  el<HTMLElement>("detail").append(section);
}
async function recoverSubmission(item: Submission): Promise<void> {
  if (posting || !recoveryCandidate(item)) return;
  posting = true;
  retryFeedback = null;
  renderResults();
  try {
    const response = await fetch(`/api/submissions/${encodeURIComponent(item.id)}/recover`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }), signal: AbortSignal.timeout(20000)
    });
    const body = await response.json() as { submission?: Submission; error?: string };
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (!body.submission || body.submission.id !== item.id || body.submission.pinnedSha !== item.pinnedSha
      || !["queued", "processing"].includes(body.submission.status)) throw new Error("復旧結果を確認できませんでした。手動更新で状態を確認してください。");
    if (data) data.items = data.items.map((value) => value.id === item.id ? body.submission! : value);
    retryFeedback = { id: item.id, failed: false, message: "課金前に停止した審査の続行を受け付けました。試行履歴と費用記録を保持しています。" };
  } catch (error) {
    retryFeedback = { id: item.id, failed: true, message: error instanceof Error ? error.message : "復旧を受け付けられませんでした。" };
  } finally {
    posting = false;
    renderResults();
    void refresh();
  }
}
function preservesScores(previous: Submission, next: Submission): boolean {
  return !!previous.result && !!next.result && previous.result.total === next.result.total && previous.result.criteria.every((criterion) => next.result?.criteria.some((value) => value.key === criterion.key && value.score === criterion.score)) && previous.result.criteria.length === next.result.criteria.length;
}
async function retrySubmission(id: string): Promise<void> {
  const current = data?.items.find((item) => item.id === id);
  const effortRecheck = retryRequestedEffort;
  if (
    posting ||
    retryReviewId !== id ||
    !current ||
    !retryAllowed(current)
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
        },
        body: JSON.stringify({ confirm: true, ...(current.result && current.mode === "production" ? { effort: "medium" } : effortRecheck ? { effort: effortRecheck } : {}) }),
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
      (current.result
        ? !preservesScores(current, body.submission) || !["pending", "processing"].includes(explanationState(body.submission) || "")
        : body.submission.status !== "queued")
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
      message: current.result ? "評価理由の再生成を受け付けました。点数・順位は変わりません。" : "再審査をクラウド審査キューに追加しました。タブを閉じてもサーバー上の実行は継続します。",
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
function parseInput(input = el<HTMLTextAreaElement>("batch").value): ImportResult {
  const selection = selectedSubmissionOptions();
  const existingKeys = new Set((data?.items || []).filter((item) => item.mode === selection.mode).flatMap((item) => {
    const parsed = normalizeRepository(item.repoUrl);
    return parsed ? [parsed.key] : [];
  }));
  return restorePendingImport(input, selection, existingKeys, pendingBatch);
}
function sanitizeInput(): void {
  const parsed = parseInput();
  el<HTMLTextAreaElement>("batch").value = parsed.sanitized;
  importResult = parsed;
  preview(false);
}
function preview(reparse = true): void {
  if (reparse || !importResult) importResult = parseInput();
  const parsed = importResult;
  const selection = selectedSubmissionOptions();
  const signature = JSON.stringify({ ...selection, items: parsed.items });
  const acknowledged = pendingBatch?.acknowledged && pendingBatch.sourceSignature === importSourceSignature(el<HTMLTextAreaElement>("batch").value, selection);
  const beforeStart = selection.mode === "production" && Date.now() < Date.parse(JUDGING_START_ISO);
  const reasons: Record<string, string> = { ready: "対象", duplicate: "重複", late: "締切後", missing_timestamp: "提出日時なし", invalid_timestamp: "提出日時が不正", invalid_url: "リポジトリURLが不正", invalid_demo: "デモURLが不正・対象外", over_limit: "31件目以降は対象外", invalid_team: "チーム名を確認", missing_headers: "見出しが不足・重複" };
  el<HTMLElement>("preview").innerHTML = `<h3>2. 対象を確認</h3><p>対象 ${parsed.items.length} 件 / 除外 ${parsed.rows.length - parsed.items.length} 件 · 理由生成の推論強度 ${esc(selection.effort)}</p>${parsed.error ? `<p role="alert">${esc(parsed.error)}</p>` : ""}<ol>${parsed.rows.map((row) => `<li><span class="preview-${row.reason === "ready" ? "ready" : "invalid"}">${esc(reasons[row.reason])}</span><span>${esc(row.teamName || "名称未入力")}<br>${esc(row.repoUrl)}<br>${row.reason === "invalid_demo" ? "デモURLを修正してください（対象外）" : demoLink(row.demoUrl)}</span><small>${row.submittedAt ? esc(formatTimestampJst(row.submittedAt)) : row.timestamp ? "提出日時を修正してください" : "提出日時なし"}</small></li>`).join("")}</ol><p>${acknowledged ? "この内容は受付済みです。進行状況を確認してください。" : beforeStart ? "本番審査は10/18 17:30 日本時間から開始できます。" : parsed.items.length ? "対象の回答だけを送信します。除外理由を確認して開始してください。" : "入力と除外理由を確認してください。"}</p>`;
  el<HTMLButtonElement>("batch-submit").disabled = posting || data?.open === false || !!parsed.error || !parsed.items.length || beforeStart || !!acknowledged;
  el<HTMLElement>("batch-results").textContent = batchMessage;
  if (startTimer !== null) clearTimeout(startTimer);
  startTimer = beforeStart ? window.setTimeout(() => preview(), Math.min(2147483647, Math.max(1, Date.parse(JUDGING_START_ISO) - Date.now()))) : null;
}
async function submitBatch(): Promise<void> {
  if (posting || data?.open === false) return;
  sanitizeInput();
  const selection = selectedSubmissionOptions();
  const items = importResult!.items.map((item) => ({ ...item }));
  if (importResult!.error || !items.length || (selection.mode === "production" && Date.now() < Date.parse(JUDGING_START_ISO))) return;
  const signature = JSON.stringify({ ...selection, items });
  const sourceSignature = importSourceSignature(el<HTMLTextAreaElement>("batch").value, selection);
  if (pendingBatch?.sourceSignature === sourceSignature && pendingBatch.acknowledged) return;
  if (!pendingBatch || pendingBatch.sourceSignature !== sourceSignature)
    pendingBatch = { signature, sourceSignature, payload: JSON.stringify({ id: crypto.randomUUID(), ...selection, items }), acknowledged: false };
  const request = pendingBatch;
  posting = true;
  batchMessage = "一括審査を登録中です。";
  organizer(); preview(false); renderResults();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch("/api/batches", { method: "POST", headers: { "content-type": "application/json" }, body: request.payload, signal: controller.signal });
    if (response.status !== 202) {
      batchMessage = response.status === 409 ? "受付内容が競合しています。手動更新で確認してください。" : `受付に失敗しました（HTTP ${response.status}）。再試行は同じ受付IDを使用します。`;
      return;
    }
    const body = await response.json() as { batch: Batch; submissions: Submission[] };
    if (!body.batch || body.batch.id !== JSON.parse(request.payload).id || !Array.isArray(body.submissions)) throw new Error("invalid response");
    request.acknowledged = true;
    batchMessage = `一括審査を受け付けました。受付ID: ${body.batch.id}。ソース版の固定と審査状況を確認できます。`;
    if (data) {
      data.items = [...data.items.filter((item) => !body.submissions.some((incoming) => incoming.id === item.id)), ...body.submissions];
      data.batches = [...(data.batches || []).filter((batch) => batch.id !== body.batch.id), body.batch];
    }
    render(); schedule();
  } catch {
    batchMessage = "受付結果を確認できませんでした。再試行は同じ受付IDと内容を使うため、別の一括審査は作成しません。";
  } finally {
    clearTimeout(timeout);
    posting = false;
    organizer(); preview(false); renderResults(); schedule();
  }
}
function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return `"${(/^[\s]*[=+\-@\t\r\n]/.test(text) ? "'" : "") + text.replace(/"/g, '""')}"`;
}
function exportData(format: "csv" | "json"): void {
  const rows = entries().map(({ item, position }) => ({
    rank: position ?? "",
    teamName: item.teamName,
    demoUrl: normalizeDemoUrl(item.demoUrl || "") || "",
    repo: item.repo.normalized,
    repoUrl: repo(item.repoUrl)?.url || "",
    status: statusLabel(item),
    explanationStatus: explanationState(item) ?? "",
    scoredAt: item.scoredAt ?? "",
    reviewRequired: reviewRequired(item),
    eligibility: item.result?.eligibility ?? "",
    fullSource: item.result?.usage?.fullSource ?? "",
    sourceFiles: item.result?.usage?.sourceFiles ?? "",
    sourceBytes: item.result?.usage?.sourceBytes ?? "",
    sourceHash: item.result?.usage?.sourceHash ?? "",
    explanationModel: (item.result?.usage as { explanationModel?: string } | undefined)?.explanationModel ?? "",
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
    summary: explanationState(item) === "completed" ? item.result?.summary ?? "" : "",
    publicReason: explanationState(item) === "completed" ? item.result?.publicReason ?? "" : "",
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
