import { describe, expect, it } from "vitest";
import { acceptsAdvance, capturePresentation, demoPresentation, rankLabel, revealState, selectPresentation, type PresentationSource } from "../src/client/presentation";
import { CRITERIA } from "../src/shared/constants";
import { SCORE_LEVELS } from "../src/shared/rubric";

function item(index: number, total = Math.max(0, 40 - index * 2)): PresentationSource {
  return {
    id: `entry-${index}`, mode: "production", status: "completed", teamName: `Real Team ${index}`,
    repo: { owner: "real", repo: `project-${index}`, normalized: `real/project-${index}`, canonicalUrl: "" },
    result: { total, summary: "private-unused-summary", publicReason: "unused-reason", repoAssessment: "scored", pinnedSha: null, attackScore: null,
      criteria: CRITERIA.map(({ key, label }, axis) => ({ key, label, score: Math.floor(total / 8) * 2 + (axis < total / 2 % 4 ? 2 : 0), reason: "not copied", evidencePaths: ["not copied"] })),
    },
  };
}
const teams = (count = 10) => Array.from({ length: count }, (_, index) => item(index));

describe("presentation snapshot readiness", () => {
  it("explains empty production data", () => {
    expect(capturePresentation([])).toMatchObject({ ready: false, cutoff: null });
    expect(capturePresentation([]).message).toContain("提出がありません");
  });
  it("requires ten results rather than a configured target of thirty", () => {
    expect(capturePresentation(teams(9))).toMatchObject({ ready: false });
    expect(capturePresentation(teams())).toMatchObject({ ready: true });
    expect(capturePresentation(teams(30))).toMatchObject({ ready: true });
  });
  it("filters validation entries before scoring and ranking", () => {
    const validation = { ...item(90, 40), mode: "validation" as const, status: "failed" as const, result: null };
    const snapshot = capturePresentation([...teams(), validation]);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.entries).toHaveLength(10);
    expect(capturePresentation([validation]).ready).toBe(false);
  });
  it("excludes README-only and unavailable repositories even when they have higher scores", () => {
    const readmeOnly = item(30, 40);
    readmeOnly.result!.eligibility = "no_implementation";
    const unavailable = item(31, 40);
    unavailable.result!.repoAssessment = "missing_or_private";
    const snapshot = capturePresentation([...teams(), readmeOnly, unavailable]);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.entries).toHaveLength(10);
    expect(selectPresentation(snapshot).order.some((entry) => entry.id === readmeOnly.id || entry.id === unavailable.id)).toBe(false);
    expect(readmeOnly.result!.total).toBe(40);
    expect(capturePresentation([...teams(9), readmeOnly]).ready).toBe(false);
  });
  it.each(["queued", "processing", "completed", "failed"] as const)("blocks any registered %s production entry without a score", (status) => {
    const snapshot = capturePresentation([...teams(), { ...item(11), status, result: null }]);
    expect(snapshot.ready).toBe(false);
    expect(selectPresentation(snapshot).valid).toBe(false);
    expect(snapshot.message).toContain(status === "failed" ? "失敗" : "採点確定");
  });
  it.each(["queued", "processing", "completed", "failed"] as const)("allows fixed scores despite %s status or unfinished explanations", (status) => {
    const source = teams().map((entry) => ({ ...entry, status, explanationStatus: "pending" }));
    expect(capturePresentation(source).ready).toBe(true);
  });
  it.each([NaN, Infinity, -Infinity, -1, 40.1, 12.5, 39])("rejects invalid total %s", (total) => {
    const source = teams();
    source[0]!.result!.total = total;
    expect(capturePresentation(source).ready).toBe(false);
    expect(capturePresentation(source).message).toContain("総合点");
  });
  it.each([0, 12, 40])("accepts a possible rubric total %s", (total) => {
    const source = teams();
    source[0]!.result!.total = total;
    expect(capturePresentation(source).ready).toBe(true);
  });
  it("warns about reviewRequired without changing points or excluding the team", () => {
    const source = teams();
    source[0]!.result!.reviewRequired = true;
    const snapshot = capturePresentation(source);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.warnings).toHaveLength(1);
    expect(selectPresentation(snapshot).order.find((entry) => entry.id === "entry-0")).toMatchObject({ total: 40, rank: 1, reviewRequired: true });
  });
  it("rejects duplicate production identity", () => {
    expect(capturePresentation([...teams(), item(0)]).ready).toBe(false);
  });
  it("owns deeply frozen copies and retains no reason or form fields", () => {
    const source = teams();
    source[0]!.demoUrl = "https://DEMO.test:443/first";
    const before = JSON.stringify(source);
    const snapshot = capturePresentation(source);
    const selected = selectPresentation(snapshot);
    expect(JSON.stringify(source)).toBe(before);
    source[0]!.teamName = "Changed after opening";
    source[0]!.demoUrl = "https://demo.test/changed";
    source[0]!.repo.normalized = "changed/repo";
    source[0]!.result!.criteria[0]!.score = 0;
    source[0]!.result!.total = 0;
    expect(snapshot.entries[0]).toMatchObject({ teamName: "Real Team 0", repo: "real/project-0", demoUrl: "https://demo.test/first", total: 40 });
    expect(snapshot.entries[0]!.criteria[0]!.score).toBe(10);
    expect(selected.order[9]!.total).toBe(40);
    expect(selected.order[9]!.demoUrl).toBe("https://demo.test/first");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0]!.criteria[0])).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("not copied");
    expect(JSON.stringify(snapshot)).not.toContain("private-unused-summary");
    expect(capturePresentation(source).entries[0]!.id).not.toBe("entry-0");
  });
  it.each([undefined, null, "", "javascript:alert(1)", "https://user:pass@demo.test", "https://demo.test/\\path", "https://demo.test/\npath"])("captures unsafe or missing demo as null: %s", (demoUrl) => {
    const source = teams();
    source[0]!.demoUrl = demoUrl;
    const snapshot = capturePresentation(source);
    expect(snapshot.entries[0]!.demoUrl).toBeNull();
    expect(snapshot.ready).toBe(true);
  });
  it("captures canonical HTTP demos and explicit placeholders for old missing names", () => {
    const source = teams();
    source[0]!.demoUrl = " HTTP://Demo.test:80 ";
    source[0]!.teamName = "";
    expect(capturePresentation(source).entries[0]).toMatchObject({ demoUrl: "http://demo.test/", teamName: "チーム名未設定", repo: "real/project-0" });
  });
});

describe("truthful ranks and inclusive cutoff qualification", () => {
  it("uses competition ranks and announces tied teams without assigning artificial positions", () => {
    const source = teams(12);
    source[2]!.result!.total = source[1]!.result!.total;
    const snapshot = capturePresentation(source);
    expect(snapshot.entries.slice(0, 4).map((entry) => entry.rank)).toEqual([1, 2, 2, 4]);
    expect(rankLabel(snapshot.entries[1]!)).toBe("同率第2位");
    expect(rankLabel(snapshot.entries[3]!)).toBe("第4位");
  });
  it("selects exactly ten automatically only for an unambiguous boundary", () => {
    const snapshot = capturePresentation(teams(15));
    const selection = selectPresentation(snapshot);
    expect(selection.valid).toBe(true);
    expect(snapshot.cutoff).toBe(22);
    expect(selection.order).toHaveLength(10);
    expect(selection.order.map((entry) => entry.total)).toEqual([22, 24, 26, 28, 30, 32, 34, 36, 38, 40]);
    expect(selection.order[0]!.rank).toBe(10);
  });
  it("qualifies all four boundary ties after eight higher teams", () => {
    const source = teams(8);
    source.push(item(22, 24), item(20, 24), item(23, 24), item(21, 24), item(24, 22));
    const snapshot = capturePresentation(source);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.cutoff).toBe(24);
    expect(snapshot.automatic).toHaveLength(12);
    expect(snapshot.message).toContain("12チーム");
    const selection = selectPresentation(snapshot);
    expect(selection.valid).toBe(true);
    expect(selection.order).toHaveLength(12);
    expect(selection.message).toContain("12チーム");
    expect(selection.order.slice(0, 4).map((entry) => [entry.id, entry.rank, entry.tied])).toEqual([
      ["entry-22", 9, true], ["entry-20", 9, true], ["entry-23", 9, true], ["entry-21", 9, true]
    ]);
    expect(rankLabel(selection.order[0]!)).toBe("同率第9位");
    expect(selection.order.slice(4).map((entry) => entry.rank)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(selection.order.filter((entry) => entry.total > 24)).toHaveLength(8);
    expect(selection.order.some((entry) => entry.id === "entry-24")).toBe(false);
    expect(selection.order.map((entry) => entry.id)).toEqual([
      "entry-22", "entry-20", "entry-23", "entry-21", "entry-7", "entry-6", "entry-5", "entry-4", "entry-3", "entry-2", "entry-1", "entry-0"
    ]);
  });
  it("keeps stable original order for equal scores without inventing ranks", () => {
    const source = teams();
    source[0]!.result!.total = 38;
    const snapshot = capturePresentation(source);
    expect(selectPresentation(snapshot).order.slice(-2).map((entry) => [entry.id, entry.rank])).toEqual([["entry-0", 1], ["entry-1", 1]]);
    expect(rankLabel(selectPresentation(snapshot).order[9]!)).toBe("同率第1位");
  });
  it("qualifies all twelve teams when every team has thirty points", () => {
    const snapshot = capturePresentation(Array.from({ length: 12 }, (_, index) => item(index, 30)));
    expect(snapshot.ready).toBe(true);
    expect(snapshot.cutoff).toBe(30);
    expect(snapshot.automatic).toHaveLength(12);
    const selection = selectPresentation(snapshot);
    expect(selection.valid).toBe(true);
    expect(selection.order).toHaveLength(12);
    expect(selection.order.map((entry) => entry.id)).toEqual(Array.from({ length: 12 }, (_, index) => `entry-${index}`));
    expect(selection.order.every((entry) => entry.total === 30 && entry.rank === 1 && entry.tied)).toBe(true);
    expect(selection.order.every((entry) => rankLabel(entry) === "同率第1位")).toBe(true);
  });
  it("computes the tied cutoff from eligible results when excluded repositories have higher scores", () => {
    const source = teams(8);
    source.push(item(20, 22), item(21, 22), item(22, 22), item(23, 22));
    const readmeOnly = item(24, 40);
    readmeOnly.result!.eligibility = "no_implementation";
    const unavailable = item(25, 40);
    unavailable.result!.repoAssessment = "missing_or_private";
    const snapshot = capturePresentation([...source, readmeOnly, unavailable]);
    const selection = selectPresentation(snapshot);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.cutoff).toBe(22);
    expect(selection.valid).toBe(true);
    expect(selection.order).toHaveLength(12);
    expect(selection.order.slice(0, 4).map((entry) => [entry.id, entry.rank])).toEqual([
      ["entry-20", 9], ["entry-21", 9], ["entry-22", 9], ["entry-23", 9]
    ]);
    expect(selection.order.some((entry) => entry.id === readmeOnly.id || entry.id === unavailable.id)).toBe(false);
  });
  it("isolates fictional preview data from real results and future captures", () => {
    const real = capturePresentation(teams());
    const before = JSON.stringify(real);
    const demo = demoPresentation();
    expect(demo.mode).toBe("demo");
    expect(selectPresentation(demo).order).toHaveLength(10);
    expect(new Set(demo.entries.map((entry) => entry.teamName)).size).toBe(10);
    expect(demo.entries.every((entry) => entry.id.startsWith("demo-") && entry.teamName.startsWith("DEMO / "))).toBe(true);
    expect(demo.entries.every((entry) => entry.demoUrl === null)).toBe(true);
    expect(JSON.stringify(demo)).not.toMatch(/https?:\/\//);
    expect(demo.entries.every((entry) => entry.criteria.every((criterion) => (SCORE_LEVELS as readonly number[]).includes(criterion.score)) && entry.criteria.reduce((sum, criterion) => sum + criterion.score, 0) === entry.total)).toBe(true);
    expect(demo.entries.some((entry) => real.entries.some((other) => other.id === entry.id || other.teamName === entry.teamName))).toBe(false);
    expect(JSON.stringify(real)).toBe(before);
  });
});

describe("one-at-a-time reveal state", () => {
  it("advances only on completion and ignores rapid duplicate begin and completion", () => {
    const initial = { revealed: 0, busy: false };
    const busy = revealState(initial, "begin");
    expect(initial).toEqual({ revealed: 0, busy: false });
    expect(busy).toEqual({ revealed: 0, busy: true });
    expect(revealState(busy, "begin")).toBe(busy);
    expect(acceptsAdvance(busy, {})).toBe(false);
    const done = revealState(busy, "complete");
    expect(done).toEqual({ revealed: 1, busy: false });
    expect(revealState(done, "complete")).toBe(done);
  });
  it("rejects double clicks and held keyboard even after a fast reduced-motion completion", () => {
    const state = revealState(revealState({ revealed: 0, busy: false }, "begin"), "complete");
    expect(acceptsAdvance(state, { detail: 2 })).toBe(false);
    expect(acceptsAdvance(state, { repeat: true })).toBe(false);
    expect(acceptsAdvance(state, { detail: 1 })).toBe(true);
    expect(acceptsAdvance(state, { repeat: false })).toBe(true);
    expect(acceptsAdvance(state, { detail: 1, elapsedMs: 349 })).toBe(false);
    expect(acceptsAdvance(state, { detail: 1, elapsedMs: 350 })).toBe(true);
  });
  it("rewinds and restarts without retaining future revealed data or busy state", () => {
    const order = selectPresentation(capturePresentation(teams())).order;
    let state = { revealed: 0, busy: false };
    state = revealState(revealState(state, "begin"), "complete");
    state = revealState(revealState(state, "begin"), "complete");
    expect(order.slice(0, state.revealed).map((entry) => entry.rank)).toEqual([10, 9]);
    state = revealState(state, "back");
    expect(order.slice(0, state.revealed).map((entry) => entry.rank)).toEqual([10]);
    state = revealState(revealState(state, "begin"), "restart");
    expect(state).toEqual({ revealed: 0, busy: false });
    expect(revealState(state, "complete")).toEqual(state);
    expect(revealState(state, "back").revealed).toBe(0);
  });
  it("stops after all ten announcements", () => {
    let state = { revealed: 0, busy: false };
    for (let index = 0; index < 15; index++) state = revealState(revealState(state, "begin"), "complete");
    expect(state).toEqual({ revealed: 10, busy: false });
    expect(acceptsAdvance(state, {})).toBe(false);
  });
  it("reveals every qualified team and stops at twelve when the cutoff includes ties", () => {
    const source = teams(8);
    source.push(item(20, 24), item(21, 24), item(22, 24), item(23, 24));
    const order = selectPresentation(capturePresentation(source)).order;
    expect(order).toHaveLength(12);
    let state = { revealed: 0, busy: false };
    for (let index = 0; index < order.length; index++) {
      expect(acceptsAdvance(state, {}, order.length)).toBe(true);
      state = revealState(state, "begin", order.length);
      expect(acceptsAdvance(state, {}, order.length)).toBe(false);
      state = revealState(state, "complete", order.length);
      expect(state.revealed).toBe(index + 1);
    }
    expect(state).toEqual({ revealed: 12, busy: false });
    expect(order.slice(0, state.revealed)).toHaveLength(12);
    expect(order.at(-1)!.rank).toBe(1);
    expect(acceptsAdvance(state, {}, order.length)).toBe(false);
    expect(revealState(state, "begin", order.length)).toBe(state);
    expect(revealState(state, "complete", order.length)).toBe(state);
    expect(revealState(state, "back", order.length)).toEqual({ revealed: 11, busy: false });
    expect(revealState(state, "restart", order.length)).toEqual({ revealed: 0, busy: false });
  });
});
