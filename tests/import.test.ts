import { describe, expect, it } from "vitest";
import { importSourceSignature, restorePendingImport, normalizeRepository, normalizeDemoUrl, normalizeTimestamp, parseSubmissionImport, scanDelimited } from "../src/client/submission-import";

const header = "タイムスタンプ\tメールアドレス\tチーム名または個人名\tデモURL\tGitHub リポジトリ URL（パブリック）\tGitHubアカウント";
const response = (index: number, time = "2026/10/18 17:15:00") => `${time}\tprivate${index}@example.test\tTeam ${index}\thttps://demo.example.test/${index}\thttps://github.com/team/project${index}\tunused-handle`;
const parse = (text: string) => parseSubmissionImport(text, { mode: "production" });

describe("submission import", () => {
  it.each(["demoURL", "demo URL", "デモURL", "デモ URL（パブリックであること）", "demo", "Ｄｅｍｏ　ＵＲＬ"])("preserves optional demo header %s in preview, sanitation and payload", (alias) => {
    const result = parse(`timestamp\tメールアドレス\tteamName\tgithubRepositoryURL\t${alias}\tother\n2026/10/18 17:00\tprivate@example.test\tTeam\thttps://github.com/a/b\t HTTP://Demo.Example.test:80/a \tprivate-unused`);
    expect(result.rows[0]).toMatchObject({ reason: "ready", demoUrl: "http://demo.example.test/a" });
    expect(result.items[0]?.demoUrl).toBe("http://demo.example.test/a");
    expect(parse(result.sanitized).items).toEqual(result.items);
    expect(JSON.stringify(result)).not.toContain("private");
    const selection = { mode: "production" as const, effort: "medium" };
    const payload = JSON.stringify({ id: "captured-id", ...selection, items: result.items });
    expect(JSON.parse(payload).items[0].demoUrl).toBe("http://demo.example.test/a");
    const pending = { sourceSignature: importSourceSignature(result.sanitized, selection), payload };
    expect(restorePendingImport(result.sanitized, selection, new Set(["a/b"]), pending).items).toEqual(result.items);
    expect(importSourceSignature(result.sanitized.replace("demo.example.test/a", "demo.example.test/b"), selection)).not.toBe(pending.sourceSignature);
  });
  it("accepts missing and empty optional demos and never infers them from legacy inputs", () => {
    const source = "timestamp\tteamName\tgithubRepositoryURL\n2026/10/18 17:00\tTeam\thttps://github.com/a/b";
    expect(parse(source).items[0]).not.toHaveProperty("demoUrl");
    expect(parse(source.replace("githubRepositoryURL", "githubRepositoryURL\tdemoURL") + "\t").items).toEqual(parse(source).items);
    for (const input of ["Team\thttps://github.com/a/b", "Team,https://github.com/a/b", "https://github.com/a/b"]) {
      expect(parseSubmissionImport(input, { mode: "validation" }).items[0]).not.toHaveProperty("demoUrl");
    }
  });
  it.each(["demoURL\tdemo", "デモURL\tＤｅｍｏ　ＵＲＬ"])("keeps duplicate optional demo aliases invalid across roundtrips: %s", (aliases) => {
    const source = `timestamp\tteamName\tgithubRepositoryURL\t${aliases}\temail\n2026/10/18 17:00\tTeam\thttps://github.com/a/b\thttps://one.test\thttps://two.test\tprivate@example.test`;
    for (const mode of ["production", "validation"] as const) {
      let result = parseSubmissionImport(source, { mode });
      for (let round = 0; round < 3; round++) {
        expect(result.error).toBeTruthy();
        expect(result.items).toEqual([]);
        expect(result.rows[0]?.reason).toBe("missing_headers");
        expect(result.sanitized.split("\n")[0]!.split("\t").filter((name) => name === "demoURL")).toHaveLength(2);
        expect(JSON.stringify(result)).not.toContain("private@example.test");
        result = parseSubmissionImport(result.sanitized, { mode });
      }
    }
  });
  it.each(["javascript:alert(1)", "data:text/html,test", "//demo.test", "ftp://demo.test", "https://user:pass@demo.test", "https://demo.test/\\path", "https://demo.test/a\u0000b", "https://demo.test/a\u007fb", "https://demo.test/a\tb", "https://demo.test/a\nb", "https://demo.test/" + "a".repeat(2048)])("excludes unsafe demos and preserves their exclusion after sanitation: %s", (demo) => {
    const source = `timestamp\tteamName\tgithubRepositoryURL\tdemoURL\temail\n2026/10/18 17:00\tTeam\thttps://github.com/a/b\t"${demo}"\tprivate@example.test`;
    const result = parse(source);
    expect(result.items).toEqual([]);
    expect(result.rows[0]).toMatchObject({ reason: "invalid_demo", demoUrl: demo });
    expect(parse(result.sanitized).rows[0]?.reason).toBe("invalid_demo");
    expect(JSON.stringify(result)).not.toContain("private@example.test");
  });
  it("imports 30 responses using the verified five-column form header", () => {
    const exactHeader = "タイムスタンプ\tメールアドレス\tチーム名または個人名\tGitHub リポジトリ URL（パブリック）\tデモ URL（パブリックであること）";
    const source = [exactHeader, ...Array.from({ length: 30 }, (_, index) => `2026/10/18 17:00:00\tprivate${index}@example.test\tTeam ${index}\thttps://github.com/team/project${index}\thttps://demo.example.test/${index}`)].join("\r\n");
    const result = parse(source);
    expect(result.items).toHaveLength(30);
    expect(result.items[0]).toEqual({ teamName: "Team 0", repoUrl: "https://github.com/team/project0", demoUrl: "https://demo.example.test/0", submittedAt: "2026-10-18T08:00:00.000Z" });
    expect(JSON.stringify(result)).not.toContain("@example.test");
    expect(result.sanitized).toContain("https://demo.example.test/29");
    expect(parse(result.sanitized).items).toEqual(result.items);
  });
  it("uses canonical identity only for headerless validation without a team", () => {
    const result = parseSubmissionImport("https://github.com/Owner/Repo.git", { mode: "validation" });
    expect(result.items[0]?.teamName).toBe("owner/repo");
    expect(parseSubmissionImport(result.sanitized, { mode: "validation" }).items).toEqual(result.items);
    expect(parse(result.sanitized).items).toEqual([]);
    expect(parseSubmissionImport("Custom\thttps://github.com/Owner/Repo", { mode: "validation" }).items[0]?.teamName).toBe("Custom");
    expect(parseSubmissionImport("teamName\tgithubRepositoryURL\n\thttps://github.com/a/b", { mode: "validation" }).items).toEqual([]);
  });
  it.each(["2026/10/18 17:16:00", "2026/02/30 12:00"])("does not reserve a repository for an invalid first timestamp %s", (time) => {
    const result = parse(`${header}\n${response(1, time)}\n${response(1)}`);
    expect(result.rows[1]?.reason).toBe("ready");
    expect(result.items).toHaveLength(1);
  });
  it("does not reserve a repository for an invalid team and accepts prior submissions", () => {
    const result = parse(`timestamp\tteamName\tgithubRepositoryURL\n2026/10/17 12:00\t${"a".repeat(101)}\thttps://github.com/a/b\n2026/10/17 12:00\tValid\thttps://github.com/a/b`);
    expect(result.rows.map((row) => row.reason)).toEqual(["invalid_team", "ready"]);
  });
  it.each(["timestamp\ttimestamp\tteamName\tgithubRepositoryURL", "timestamp\tteamName\tteamName\tgithubRepositoryURL", "timestamp\tteamName\tgithubRepositoryURL\tgithubRepositoryURL", "timestamp\tgithubRepositoryURL", "timestamp\tteamName"])("keeps invalid headers closed across sanitation and mode changes: %s", (labels) => {
    for (const mode of ["production", "validation"] as const) {
      const cells = labels.split("\t").map((name) => name === "timestamp" ? "2026/10/18 12:00" : name === "teamName" ? "Team" : "https://github.com/a/b");
      const result = parseSubmissionImport(`${labels}\temail\tdemo\n${cells.join("\t")}\tprivate@example.test\thttps://demo.example.test`, { mode });
      expect(result.error).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain("private@example.test");
      expect(result.rows[0]?.demoUrl).toBe("https://demo.example.test/");
      expect(result.sanitized).toContain("https://demo.example.test/");
      for (const nextMode of ["production", "validation"] as const) {
        const next = parseSubmissionImport(result.sanitized, { mode: nextMode });
        expect(next.error).toBeTruthy();
        expect(next.items).toEqual([]);
      }
    }
  });
  it("replays the exact captured subset after dashboard refresh and retains initial duplicates", () => {
    const selection = { mode: "validation" as const, effort: "low" };
    const source = "Existing\thttps://github.com/a/existing\nNew\thttps://github.com/a/new";
    const initial = parseSubmissionImport(source, { mode: selection.mode, existingKeys: new Set(["a/existing"]) });
    const pending = { sourceSignature: importSourceSignature(initial.sanitized, selection), payload: JSON.stringify({ id: "immutable-id", ...selection, items: initial.items }) };
    const originalBody = pending.payload;
    const replay = restorePendingImport(initial.sanitized, selection, new Set(["a/existing", "a/new"]), pending);
    expect(replay.items).toEqual(initial.items);
    expect(replay.rows.map((row) => row.reason)).toEqual(["duplicate", "ready"]);
    expect(pending.payload).toBe(originalBody);
    expect(JSON.parse(pending.payload).id).toBe("immutable-id");
    expect(importSourceSignature(source, { ...selection, effort: "medium" })).not.toBe(pending.sourceSignature);
    expect(importSourceSignature(source, { ...selection, mode: "production" })).not.toBe(pending.sourceSignature);
    expect(importSourceSignature(source + "\nOther\thttps://github.com/a/other", selection)).not.toBe(pending.sourceSignature);
    expect(restorePendingImport(source, { ...selection, effort: "medium" }, new Set(["a/existing", "a/new"]), pending).items).toEqual([]);
  });
  it("accepts 30 logical answers excluding the header and explicitly excludes 31", () => {
    const full = parse([header, ...Array.from({ length: 30 }, (_, i) => response(i))].join("\n"));
    expect(full.items).toHaveLength(30);
    expect(full.rows).toHaveLength(30);
    const excess = parse([header, ...Array.from({ length: 31 }, (_, i) => response(i))].join("\n"));
    expect(excess.items).toHaveLength(30);
    expect(excess.rows[30]?.reason).toBe("over_limit");
  });
  it("normalizes BOM, fullwidth labels and header whitespace", () => {
    const result = parse("\uFEFF タイムスタンプ \t チーム名または個人名　\tＧｉｔＨｕｂ　リポジトリ　ＵＲＬ（パブリック）\r\n2026/10/18 17:15\tTeam\thttps://github.com/a/b");
    expect(result.items[0]?.submittedAt).toBe("2026-10-18T08:15:00.000Z");
  });
  it("scans quoted tabs, newlines, escaped quotes and CRLF", () => {
    const result = parse(`${header}\r\n2026/10/18 17:14:59\tsecret@example.test\t"Team\tOne\r\nThe ""Best"""\thttps://demo.example.test\thttps://github.com/a/b\taccount\r\n`);
    expect(result.rows).toHaveLength(1);
    expect(result.items[0]?.teamName).toBe('Team\tOne\nThe "Best"');
    expect(parse(result.sanitized).items).toEqual(result.items);
    expect(scanDelimited('"a,b",c', ",")).toEqual([["a,b", "c"]]);
  });
  it("discards unused private data from the entire result", () => {
    const result = parse(`${header}\n${response(1)}`);
    const json = JSON.stringify(result);
    expect(json).not.toContain("private1");
    expect(result.items[0]?.demoUrl).toBe("https://demo.example.test/1");
    expect(json).not.toContain("unused-handle");
    expect(parse(result.sanitized).items).toEqual(result.items);
  });
  it("keeps logical answer positions after discarding otherwise empty private rows", () => {
    const result = parse([header, "\tprivate@example.test\t\t\t\t", ...Array.from({ length: 30 }, (_, i) => response(i))].join("\n"));
    const sanitized = parse(result.sanitized);
    expect(sanitized.rows).toHaveLength(31);
    expect(sanitized.rows[30]?.reason).toBe("over_limit");
    expect(JSON.stringify(result)).not.toContain("private@");
  });
  it("ignores blank rows while counting quoted multiline answers once", () => {
    expect(parse(`${header}\n\t\t\t\t\t\n\n${response(1)}\n`).items).toHaveLength(1);
  });
  it("does not accept missing or ambiguous production headers after sanitizing", () => {
    for (const text of [`teamName\tgithubRepositoryURL\nTeam\thttps://github.com/a/b`, `${header}\tタイムスタンプ\n${response(1)}\t2026/10/18 17:00`]) {
      const result = parse(text);
      expect(parse(result.sanitized).error).toBeTruthy();
      expect(parse(result.sanitized).items).toHaveLength(0);
    }
  });
  it("preserves invalid selected dates for correction and rejects them in validation too", () => {
    const result = parseSubmissionImport(`${header}\n${response(1, "2026/02/30 17:00")}`, { mode: "validation" });
    expect(result.rows[0]?.reason).toBe("invalid_timestamp");
    expect(result.sanitized).toContain("2026/02/30 17:00");
  });
  it("uses JST and includes submissions through 17:15:59", () => {
    const results = parse([header, response(1), response(2, "2026/10/18 17:15:12"), response(3, "2026/10/18 17:15:55"), response(4, "2026/10/18 17:15:59"), response(5, "2026/10/18 17:16:00")].join("\n"));
    expect(results.rows.map((row) => row.reason)).toEqual(["ready", "ready", "ready", "ready", "late"]);
    expect(normalizeTimestamp("2026-10-18T08:15:00Z")).toBe(normalizeTimestamp("2026-10-18T17:15:00+09:00"));
    expect(normalizeTimestamp("2026年10月18日 17時14分59秒")).toBe("2026-10-18T08:14:59.000Z");
  });
  it.each(["2026/02/29 17:00", "2026/10/18 24:00", "2026/10/18", "17:00", "2026/13/01 12:00", "2026/10/18 12:60"])("rejects invalid timestamp %s", (value) => {
    expect(normalizeTimestamp(value)).toBeNull();
    expect(parse(`${header}\n${response(1, value)}`).rows[0]?.reason).toBe("invalid_timestamp");
  });
  it("requires production timestamps and unambiguous headers", () => {
    expect(parse(`${header}\n${response(1, "")}`).rows[0]?.reason).toBe("missing_timestamp");
    expect(parse("Team\thttps://github.com/a/b").error).toBeTruthy();
    expect(parse("Team\thttps://github.com/a/b").items).toEqual([]);
    expect(parse(`${header}\tタイムスタンプ\n${response(1)}\t2026/10/18 17:00`).error).toBeTruthy();
  });
  it.each(["Team\thttps://github.com/a/b", '"Team, One",https://github.com/a/b', "https://github.com/a/b"])("accepts validation legacy input %s", (input) => {
    const result = parseSubmissionImport(input, { mode: "validation" });
    expect(result.items).toHaveLength(1);
    expect(parseSubmissionImport(result.sanitized, { mode: "validation" }).items).toEqual(result.items);
    expect(parse(result.sanitized).items).toHaveLength(0);
  });
  it("marks case insensitive .git duplicates and same-mode existing repos", () => {
    const result = parseSubmissionImport("https://www.github.com/Owner/Repo.git/\nhttps://github.com/owner/repo", { mode: "validation" });
    expect(result.rows.map((row) => row.reason)).toEqual(["ready", "duplicate"]);
    expect(parseSubmissionImport("https://github.com/Owner/Repo", { mode: "validation", existingKeys: new Set(["owner/repo"]) }).rows[0]?.reason).toBe("duplicate");
  });
  it.each(["https://user:pass@github.com/a/b", "https://github.com/a/b?x=1", "https://github.com/a/b#main", "https://github.com/a/b/tree/main", "https://github.com:443/a/b", "http://github.com/a/b", "https://github.com/a", "https://github.com/a/..", "https://github.com/a--b/c"])("rejects invalid URL %s", (input) => {
    expect(normalizeRepository(input)).toBeNull();
  });
  it.each(['"private@example.test', '"secret"oops\tvalue', 'a"secret\tb'])("fails closed on malformed quoting", (input) => {
    const result = parse(input);
    expect(result.error).toBeTruthy();
    expect(result.rows).toEqual([]);
    expect(result.sanitized).toBe("");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("private@");
  });
});

describe("safe demo URL normalization", () => {
  it.each([[" HTTP://Demo.TEST:80 ", "http://demo.test/"], ["https://DEMO.test:443/a/../b?q=1#x", "https://demo.test/b?q=1#x"], ["https://demo.test/日本語", "https://demo.test/%E6%97%A5%E6%9C%AC%E8%AA%9E"], ["https://localhost", "https://localhost/"]])("canonicalizes %s without claiming public availability", (input, expected) => {
    expect(normalizeDemoUrl(input!)).toBe(expected);
  });
  it.each(["", " ", "demo.test", "//demo.test", "https://", "https:///demo.test", "https://@demo.test", "javascript:alert(1)", "data:text/html,test", "https://user@demo.test", "https://:pass@demo.test", "https://demo.test\\@other.test", "https://demo.test/\u0000", "https://demo.test/\u001f", "https://demo.test/\u007f", "https://demo.test/\u0085", "\thttps://demo.test", "https://demo.test/\r", "https://demo.test/\n"])("rejects unsafe or empty URL %s", (input) => {
    expect(normalizeDemoUrl(input)).toBeNull();
  });
  it("bounds both input and serialized URL to 2048 characters", () => {
    const prefix = "https://demo.test/";
    const exact = prefix + "a".repeat(2048 - prefix.length);
    expect(normalizeDemoUrl(exact)).toBe(exact);
    expect(normalizeDemoUrl(exact + "a")).toBeNull();
    expect(normalizeDemoUrl(prefix + "あ".repeat(300))).toBeNull();
  });
});
