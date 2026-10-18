import { SUBMISSION_DEADLINE_ISO } from "../shared/constants";

export type ImportMode = "production" | "validation";
export type ImportReason = "ready" | "duplicate" | "late" | "missing_timestamp" | "invalid_timestamp" | "invalid_url" | "invalid_demo" | "over_limit" | "invalid_team" | "missing_headers";
export type ImportItem = { teamName: string; repoUrl: string; demoUrl?: string; submittedAt?: string };
export type ImportRow = ImportItem & { index: number; timestamp: string; key: string; reason: ImportReason };
export type ImportResult = { rows: ImportRow[]; items: ImportItem[]; sanitized: string; error: string | null };
const clean = (value: string) => value.normalize("NFKC").trim();
const label = (value: string) => clean(value).toLowerCase().replace(/\s/g, "");

function delimiterOf(input: string): string {
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && char === "\t") return "\t";
    else if (!quoted && (char === "\r" || char === "\n")) break;
  }
  return ",";
}

export function scanDelimited(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false, rowQuoted = false;
  const finishRow = () => {
    if (rowQuoted || row.some((value) => value.trim())) rows.push(row);
    row = [];
    rowQuoted = false;
  };
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += char;
    } else if (char === delimiter || char === "\n") {
      row.push(cell); cell = ""; closed = false;
      if (char === "\n") finishRow();
    } else if (char === '"' && !cell && !closed) { quoted = true; rowQuoted = true; }
    else {
      if (closed || char === '"') throw new Error("区切りや引用符の形式を確認してください。");
      cell += char;
    }
  }
  if (quoted) throw new Error("区切りや引用符の形式を確認してください。");
  row.push(cell); finishRow();
  return rows;
}

export function normalizeRepository(input: string): { url: string; key: string } | null {
  const text = clean(input);
  const match = /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/?$/i.exec(text);
  if (!match || match[1]!.includes("--")) return null;
  const name = match[2]!.replace(/\.git$/i, "");
  if (!name || name === "." || name === ".." || name.length > 100) return null;
  return { url: `https://github.com/${match[1]}/${name}`, key: `${match[1]}/${name}`.toLowerCase() };
}

export function normalizeDemoUrl(input: string): string | null {
  if (/[\u0000-\u001f\u007f-\u009f\\]/.test(input)) return null;
  const text = input.trim();
  if (!text || text.length > 2048 || !/^https?:\/\//i.test(text)) return null;
  const authority = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(text)?.[1];
  if (!authority || authority.includes("@")) return null;
  try {
    const url = new URL(text);
    return url.hostname && !url.username && !url.password && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

export function normalizeTimestamp(input: string): string | null {
  const text = clean(input).replace(/年|月/g, "/").replace(/日/g, " ").replace(/時|分/g, ":").replace(/秒/g, "").trim();
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "0", fraction = "", zone = "+09:00"] = match;
  const values = [y, mo, d, h, mi, s].map(Number);
  const [year, month, day, hour, minute, second] = values as [number, number, number, number, number, number];
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year < 1000 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null;
  const iso = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}T${h!.padStart(2, "0")}:${mi}:${s.padStart(2, "0")}${fraction}${zone}`;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function formatTimestampJst(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(value)) + " 日本時間";
}

const quote = (value: string) => /[\t\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
const selectedLine = (values: string[]) => values.some((value) => value.trim()) ? values.map(quote).join("\t") : ['""', ...values.slice(1)].join("\t");
export function parseSubmissionImport(input: string, options: { mode: ImportMode; existingKeys?: ReadonlySet<string> }): ImportResult {
  let table: string[][];
  try { table = scanDelimited(input, delimiterOf(input)); }
  catch { return { rows: [], items: [], sanitized: "", error: "区切りや引用符の形式を確認してください。" }; }
  if (!table.length) return { rows: [], items: [], sanitized: "", error: null };
  const headers = table[0]!.map(label);
  const names = { timestamp: ["タイムスタンプ", "timestamp", "submittedat"], team: ["チーム名または個人名", "チーム名", "teamname", "team"], repo: ["githubリポジトリurl(パブリック)", "githubリポジトリurl", "githubrepositoryurl", "repositoryurl", "repourl"], demo: ["demourl", "デモurl", "デモurl(パブリックであること)", "demo", "デモ"] };
  const indices = (aliases: string[]) => headers.flatMap((header, index) => aliases.includes(header) ? [index] : []);
  const ts = indices(names.timestamp), teams = indices(names.team), repos = indices(names.repo), demos = indices(names.demo);
  const hasHeader = !!(ts.length || teams.length || repos.length || demos.length) && !table[0]!.some((cell) => normalizeRepository(cell));
  const mapped = teams.length === 1 && repos.length === 1 && ts.length <= 1 && demos.length <= 1;
  const validHeader = hasHeader && mapped && (options.mode === "validation" || ts.length === 1);
  const answers = hasHeader ? table.slice(1) : table;
  const seen = new Set<string>();
  const rows = answers.map((cells, index): ImportRow => {
    const timestamp = hasHeader ? (ts.length === 1 ? cells[ts[0]!] || "" : "") : "";
    let teamName = clean(hasHeader ? (teams.length === 1 ? cells[teams[0]!] || "" : "") : cells.length === 2 ? cells[0]! : "");
    const inputUrl = clean(hasHeader ? (repos.length === 1 ? cells[repos[0]!] || "" : "") : cells.length === 1 ? cells[0]! : cells.length === 2 ? cells[1]! : "");
    const repository = normalizeRepository(inputUrl);
    const inputDemo = hasHeader && demos.length === 1 ? cells[demos[0]!] || "" : "";
    const demoUrl = normalizeDemoUrl(inputDemo);
    if (!hasHeader && options.mode === "validation" && !teamName && repository) teamName = repository.key;
    const submittedAt = timestamp.trim() ? normalizeTimestamp(timestamp) : null;
    let reason: ImportReason = "ready";
    if (index >= 30) reason = "over_limit";
    else if ((options.mode === "production" && !validHeader) || (hasHeader && !mapped)) reason = "missing_headers";
    else if (teamName.length > 100 || (hasHeader && !teamName)) reason = "invalid_team";
    else if (!repository) reason = "invalid_url";
    else if (!demoUrl && (inputDemo.trim() !== "" || /[\u0000-\u001f\u007f-\u009f\\]/.test(inputDemo))) reason = "invalid_demo";
    else if (timestamp.trim() && !submittedAt) reason = "invalid_timestamp";
    else if (options.mode === "production" && !submittedAt) reason = "missing_timestamp";
    else if (options.mode === "production" && submittedAt! > SUBMISSION_DEADLINE_ISO) reason = "late";
    else if (seen.has(repository.key) || options.existingKeys?.has(repository.key)) reason = "duplicate";
    if (repository && reason === "ready") seen.add(repository.key);
    return { index: index + 1, timestamp, teamName, repoUrl: repository?.url || inputUrl, ...(inputDemo ? { demoUrl: demoUrl || inputDemo } : {}), key: repository?.key || "", ...(submittedAt ? { submittedAt } : {}), reason };
  });
  const columns = [...ts.map(() => ({ name: "timestamp", value: (row: ImportRow) => ts.length === 1 ? row.timestamp : "" })), ...teams.map(() => ({ name: "teamName", value: (row: ImportRow) => teams.length === 1 ? row.teamName : "" })), ...repos.map(() => ({ name: "githubRepositoryURL", value: (row: ImportRow) => repos.length === 1 ? row.repoUrl : "" })), ...demos.map(() => ({ name: "demoURL", value: (row: ImportRow) => demos.length === 1 ? row.demoUrl || "" : "" }))];
  const sanitized = hasHeader ? [columns.map((column) => column.name).join("\t"), ...rows.map((row) => selectedLine(columns.map((column) => column.value(row))))].join("\n") : rows.map((row) => selectedLine(row.teamName ? [row.teamName, row.repoUrl] : [row.repoUrl])).join("\n");
  return { rows, items: rows.filter((row) => row.reason === "ready").map(({ teamName, repoUrl, demoUrl, submittedAt }) => ({ teamName, repoUrl, ...(demoUrl && normalizeDemoUrl(demoUrl) ? { demoUrl } : {}), ...(submittedAt ? { submittedAt } : {}) })), sanitized, error: options.mode === "production" && !validHeader ? "本番審査には提出日時・チーム名・リポジトリURLの一意な見出しが必要です。" : hasHeader && !mapped ? "見出しの重複や不足を確認してください。" : null };
}

export function importSourceSignature(input: string, selection: { mode: ImportMode; effort: string }): string {
  const parsed = parseSubmissionImport(input, { mode: selection.mode });
  return JSON.stringify({ ...selection, source: parsed.sanitized, error: parsed.error });
}

export function restorePendingImport(input: string, selection: { mode: ImportMode; effort: string }, existingKeys: ReadonlySet<string>, pending: { sourceSignature: string; payload: string } | null): ImportResult {
  if (!pending || pending.sourceSignature !== importSourceSignature(input, selection)) return parseSubmissionImport(input, { mode: selection.mode, existingKeys });
  const items = (JSON.parse(pending.payload) as { items: ImportItem[] }).items;
  const keys = new Set(items.flatMap((item) => normalizeRepository(item.repoUrl)?.key || []));
  const parsed = parseSubmissionImport(input, { mode: selection.mode, existingKeys: new Set([...existingKeys].filter((key) => !keys.has(key))) });
  return { ...parsed, items };
}
