import type { PublicSubmissionRecord, CriterionKey } from "../shared/types";
import { CRITERIA } from "../shared/constants";
import { normalizeDemoUrl } from "./submission-import";

export type PresentationSource = Pick<PublicSubmissionRecord, "id" | "mode" | "status" | "teamName" | "repo" | "result"> & { demoUrl?: string | null };
export type PresentationEntry = Readonly<{
  id: string;
  teamName: string;
  repo: string;
  demoUrl: string | null;
  total: number;
  criteria: readonly Readonly<{ key: CriterionKey; label: string; score: number }>[];
  rank: number;
  tied: boolean;
  reviewRequired: boolean;
  index: number;
}>;
export type PresentationSnapshot = Readonly<{
  mode: "real" | "demo";
  entries: readonly PresentationEntry[];
  ready: boolean;
  message: string;
  warnings: readonly string[];
  cutoff: number | null;
  automatic: readonly PresentationEntry[];
  candidates: readonly PresentationEntry[];
  remaining: number;
}>;
export type PresentationSelection = Readonly<{ valid: boolean; message: string; order: readonly PresentationEntry[] }>;
export type RevealState = Readonly<{ revealed: number; busy: boolean }>;
export type RevealAction = "begin" | "complete" | "back" | "restart";

export function capturePresentation(items: readonly PresentationSource[], mode: "real" | "demo" = "real"): PresentationSnapshot {
  const production = items.filter((item) => item.mode === "production");
  let message = "10チームの発表を準備できます。";
  if (!production.length) message = "本番審査の提出がありません。";
  else if (production.some((item) => item.status === "failed" && !item.result)) message = "採点結果のない失敗した本番提出があります。";
  else if (production.some((item) => !item.result)) message = "登録済みの本番提出すべての採点確定を待っています。";
  else if (production.some((item) => !Number.isSafeInteger(item.result!.total) || item.result!.total % 2 !== 0 || item.result!.total < 0 || item.result!.total > 40)) message = "本番結果にルーブリックと一致しない総合点があります（0〜40点の偶数）。";
  else if (new Set(production.map((item) => item.id)).size !== production.length) message = "提出IDが重複しています。結果を確認してください。";
  else if (production.length < 10) message = `採点済みの本番提出が10件必要です（現在${production.length}件）。`;
  const ready = message === "10チームの発表を準備できます。";
  const sorted = production.filter((item) => item.result && Number.isFinite(item.result.total)).map((item, index) => ({ item, index })).sort((a, b) => b.item.result!.total - a.item.result!.total || a.index - b.index);
  const entries: readonly PresentationEntry[] = Object.freeze(sorted.map(({ item, index }) => {
    const total = item.result!.total;
    return Object.freeze({
      id: item.id, teamName: item.teamName || "チーム名未設定", repo: item.repo.normalized, demoUrl: normalizeDemoUrl(item.demoUrl || ""), total, index,
      rank: sorted.findIndex((value) => value.item.result!.total === total) + 1,
      tied: sorted.filter((value) => value.item.result!.total === total).length > 1,
      reviewRequired: item.result!.reviewRequired === true,
      criteria: Object.freeze(item.result!.criteria.map(({ key, label, score }) => Object.freeze({ key, label, score }))),
    });
  }));
  const cutoff = ready ? entries[9]!.total : null;
  const higher = cutoff === null ? [] : entries.filter((entry) => entry.total > cutoff);
  const boundary = cutoff === null ? [] : entries.filter((entry) => entry.total === cutoff);
  const needsChoice = higher.length + boundary.length > 10;
  const warnings = entries.some((entry) => entry.reviewRequired) ? ["根拠不足・要確認の提出があります。主催者が確認してください。点数・順位や発表対象からの除外は自動変更しません。"] : [];
  return Object.freeze({ mode, entries, ready, message, warnings: Object.freeze(warnings), cutoff,
    automatic: Object.freeze(needsChoice ? higher : entries.slice(0, 10)),
    candidates: Object.freeze(needsChoice ? boundary : []), remaining: needsChoice ? 10 - higher.length : 0 });
}

export function selectPresentation(snapshot: PresentationSnapshot, ids: readonly string[] = []): PresentationSelection {
  const invalid = (message: string): PresentationSelection => Object.freeze({ valid: false, message, order: Object.freeze([]) });
  if (!snapshot.ready) return invalid(snapshot.message);
  if (new Set(ids).size !== ids.length) return invalid("同じ提出を複数回選択できません。");
  if (ids.some((id) => !snapshot.candidates.some((entry) => entry.id === id))) return invalid("通過ラインの候補だけを選択してください。");
  if (ids.length !== snapshot.remaining) return invalid(`同点候補からちょうど${snapshot.remaining}チームを選択してください（現在${ids.length}件）。`);
  const selected = [...snapshot.automatic, ...snapshot.candidates.filter((entry) => ids.includes(entry.id))];
  return Object.freeze({ valid: true, message: "10チームの準備ができました。", order: Object.freeze(selected.sort((a, b) => a.total - b.total || a.index - b.index)) });
}

export function rankLabel(entry: Pick<PresentationEntry, "rank" | "tied">): string {
  return `${entry.tied ? "同率" : ""}第${entry.rank}位`;
}

export function revealState(state: RevealState, action: RevealAction, count = 10): RevealState {
  if (action === "restart") return { revealed: 0, busy: false };
  if (action === "back") return { revealed: Math.max(0, state.revealed - 1), busy: false };
  if (action === "begin") return state.busy || state.revealed >= count ? state : { ...state, busy: true };
  return state.busy ? { revealed: Math.min(count, state.revealed + 1), busy: false } : state;
}

export function acceptsAdvance(state: RevealState, event: { detail?: number; repeat?: boolean; elapsedMs?: number }, count = 10): boolean {
  return !state.busy && state.revealed < count && !event.repeat && (event.detail ?? 0) <= 1 && (event.elapsedMs ?? Infinity) >= 350;
}

export function demoPresentation(): PresentationSnapshot {
  const names = ["Velvet Comet", "Lunar Teacup", "Prism Picnic", "Cloud Carousel", "Orbit Petals", "Peach Satellite", "Mint Meteor", "Ribbon Rocket", "Starlight Atelier", "Golden Daydream"];
  return capturePresentation(names.map((name, index) => ({
    id: `demo-${index}`, mode: "production", status: "completed", teamName: `DEMO / ${name}`,
    repo: { normalized: `fictional-preview/project-${index + 1}`, owner: "fictional-preview", repo: `project-${index + 1}`, canonicalUrl: "" },
    result: { total: 20 + index * 2, reviewRequired: false, summary: "", publicReason: "", repoAssessment: "scored", pinnedSha: null, attackScore: null,
      criteria: CRITERIA.map(({ key, label }, axis) => ({ key, label, score: Math.floor((10 + index) / 4) * 2 + (axis < (10 + index) % 4 ? 2 : 0), reason: "", evidencePaths: [] })) },
  })), "demo");
}
