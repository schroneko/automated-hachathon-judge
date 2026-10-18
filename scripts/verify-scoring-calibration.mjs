import { createHash, randomUUID } from "node:crypto";
import { writeFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODELS = ["gpt-6-luna", "gpt-6.1-sol"];
const CRITERIA = ["technical", "ux", "impact", "idea"];
const KEY_NAME = "OPENAI_API_KEY_20261018_HACKATHON";
const HELP = `Usage: node scripts/verify-scoring-calibration.mjs --live [options]
       node scripts/verify-scoring-calibration.mjs --help

Opt-in paid scoring calibration. Requires only ${KEY_NAME}.
  --effort low|medium|high   Explanation effort (default: low)
  --cases id,id             Select calibration case IDs (default: all)
  --repeats 1|2|3           Decisions calls per case (default: 2)
  --output path            JSON report (default: /tmp/devday-scoring-calibration-<timestamp>.json)
  --budget USD             Positive run budget, at most 10 (default: 5)

Each case gets Decisions replicates and one explanation of its first fixed result.
No automatic retries. Unsettled reservations remain charged against the budget.
Model catalog checks confirm availability only, not model recency.
`;

class CalibrationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function requireThat(condition, code, message) {
  if (!condition) throw new CalibrationError(code, message);
}
function parseArgs(args) {
  const options = { effort: "low", repeats: 2, budget: 5,
    output: `/tmp/devday-scoring-calibration-${new Date().toISOString().replace(/[:.]/g, "-")}.json` };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    requireThat(["--live", "--help", "--effort", "--cases", "--repeats", "--output", "--budget"].includes(flag), "arguments", "Unknown argument");
    requireThat(!seen.has(flag), "arguments", "Duplicate argument");
    seen.add(flag);
    if (flag === "--help" || flag === "--live") { options[flag.slice(2)] = true; continue; }
    const value = args[++i];
    requireThat(typeof value === "string" && value.trim() && !value.startsWith("--"), "arguments", "Missing argument value");
    options[flag.slice(2)] = value;
  }
  requireThat(options.help ? seen.size === 1 : options.live, "arguments", "Use --live or --help; --help must be used alone");
  requireThat(["low", "medium", "high"].includes(options.effort), "arguments", "Invalid effort");
  requireThat(/^[123]$/.test(String(options.repeats)), "arguments", "Repeats must be 1, 2, or 3");
  options.repeats = Number(options.repeats);
  requireThat(/^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(String(options.budget)) && Number(options.budget) > 0
    && Number(options.budget) <= 10, "arguments", "Budget must be positive and at most 10 USD");
  options.budget = Number(options.budget);
  if (options.cases !== undefined) {
    options.cases = options.cases.split(",");
    requireThat(options.cases.every((id) => id.length > 0 && id.trim() === id)
      && new Set(options.cases).size === options.cases.length, "arguments", "Case IDs must be nonempty and unique");
  }
  options.output = resolve(options.output);
  return options;
}

let apiKey = "";
let report;
let options;
let stage = "arguments";
const redact = (value) => apiKey ? value.split(apiKey).join("[REDACTED]") : value;
const json = (value) => JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item, 2);
const safeRequestId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value)
  && (!apiKey || !value.includes(apiKey)) ? value : null;
const safeError = (error) => ({ stage, code: error instanceof CalibrationError ? error.code : "operation_failed",
  message: error instanceof CalibrationError ? redact(error.message) : "Operation failed; sensitive error details omitted" });
function progress(event, extra = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...extra, ...(report ? {
    spentMicroUsd: report.ledger.spentMicroUsd, pendingMicroUsd: report.ledger.pendingMicroUsd
  } : {}) }, (_key, item) => typeof item === "string" ? redact(item) : item)}\n`);
}
async function persist() {
  report.updatedAt = new Date().toISOString();
  report.costUSD = report.ledger.spentMicroUsd / 1_000_000;
  const requests = [...report.ledger.reservations, ...report.ledger.events];
  report.requestIds = [...new Set(requests.map((item) => item.requestId).filter(Boolean))];
  for (const row of report.cases) {
    row.costUSD = report.ledger.reservations.filter((item) => item.caseId === row.id)
      .reduce((sum, item) => sum + (item.costMicroUsd ?? 0), 0) / 1_000_000;
    row.requestIds = [...new Set(requests.filter((item) => item.caseId === row.id).map((item) => item.requestId).filter(Boolean))];
  }
  const temporary = `${options.output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${json(report)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, options.output);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
function microUsd(value) {
  requireThat(Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 1_000_000)),
    "accounting", "Invalid USD amount");
  return Math.round(value * 1_000_000);
}
async function trustedModules() {
  const { build } = await import("esbuild");
  const bundle = await build({ write: false, bundle: true, packages: "bundle", platform: "node", format: "esm", logLevel: "silent",
    stdin: { contents: `export { scoreSnapshotWithDecisions, explainScoredSnapshot } from './src/container/scorer.ts';
export { fetchRepoEvidence } from './src/container/github.ts';
export { prepareFullSourceSnapshot, normalizeGitHubRepoUrl, validatePublicScoreResult } from './src/shared/validation.ts';
export { calculateUsageCost, quoteReservation } from './src/shared/pricing.ts';
export { buildDecisionsQuestions, buildExplanationPrompt } from './src/shared/prompt.ts';
export { RUBRIC_VERSION } from './src/shared/rubric.ts';
export { DEVDAY_REFERENCE_VERSION } from './src/shared/devday-reference.ts';
export { CALIBRATION_CASES } from './tests/calibration-cases.ts';`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "calibration-entry.ts", loader: "ts" } });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}
async function checkCatalog(context) {
  stage = "catalog";
  const event = { ...context, stage, at: new Date().toISOString(), status: "pending" };
  report.ledger.events.push(event);
  await persist();
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000), redirect: "error"
    });
    event.requestId = safeRequestId(response.headers.get("x-request-id"));
    requireThat(response.ok, "catalog_http", "Model catalog request failed");
    const body = await response.json();
    requireThat(Array.isArray(body?.data) && MODELS.every((model) => body.data.some((entry) => entry?.id === model)),
      "catalog_models", "Both required models must be available");
    event.status = "available";
    event.models = MODELS;
    event.availabilityOnly = true;
  } catch (error) {
    event.status = "failed";
    event.error = safeError(error);
    throw error;
  } finally {
    await response?.body?.cancel().catch(() => {});
    await persist();
  }
}
function callbacks(modules, context) {
  return { apiKey, effort: options.effort,
    beforeCall: async (quote) => {
      await checkCatalog(context);
      stage = "reservation";
      const amount = microUsd(modules.quoteReservation(quote));
      requireThat(quote.reservedUsd === amount / 1_000_000, "quote", "Reservation quote does not match pricing");
      const ledger = report.ledger;
      if (amount > ledger.budgetMicroUsd - ledger.spentMicroUsd - ledger.pendingMicroUsd) {
        report.budgetStopped = true;
        ledger.events.push({ ...context, stage, status: "budget_stopped", at: new Date().toISOString() });
        await persist();
        throw new CalibrationError("budget", "Budget cannot cover the next reservation");
      }
      const id = randomUUID();
      ledger.reservations.push({ id, ...context, kind: quote.kind, model: quote.model, maxInputTokens: quote.maxInputTokens,
        maxOutputTokens: quote.maxOutputTokens, reservedMicroUsd: amount, status: "pending", at: new Date().toISOString() });
      ledger.pendingMicroUsd += amount;
      ledger.events.push({ ...context, stage, reservationId: id, status: "reserved", at: new Date().toISOString() });
      await persist();
      stage = context.phase;
      return id;
    },
    afterCall: async (usage) => {
      stage = "settlement";
      report.ledger.events.push({ ...context, stage, status: "usage_received", requestId: safeRequestId(usage.requestId), at: new Date().toISOString() });
      const entry = report.ledger.reservations.find((item) => item.id === usage.reservationId);
      requireThat(entry && entry.status === "pending" && entry.kind === usage.kind && entry.model === usage.model
        && entry.caseId === context.caseId && entry.phase === context.phase && entry.replicate === context.replicate,
      "settlement", "Usage does not match a pending reservation");
      const cost = microUsd(modules.calculateUsageCost(usage));
      requireThat(usage.costUsd === cost / 1_000_000 && cost <= entry.reservedMicroUsd
        && usage.inputTokens <= entry.maxInputTokens && usage.outputTokens <= entry.maxOutputTokens,
      "settlement", "Usage exceeds or disagrees with reservation pricing");
      Object.assign(entry, { status: "settled", costMicroUsd: cost, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
        requestId: safeRequestId(usage.requestId), settledAt: new Date().toISOString() });
      report.ledger.spentMicroUsd += cost;
      report.ledger.pendingMicroUsd -= entry.reservedMicroUsd;
      report.ledger.events.push({ ...context, stage, reservationId: entry.id, status: "settled", at: entry.settledAt });
      await persist();
      stage = context.phase;
    }
  };
}
function validateCase(item) {
  requireThat(item && typeof item.id === "string" && item.id.length > 0 && item.id.trim() === item.id && !item.id.includes(",")
    && typeof item.label === "string" && item.label.trim() && item.expected && typeof item.expected === "object"
    && !Array.isArray(item.expected), "fixtures", "Invalid calibration case identity or expectations");
  const expected = item.expected;
  requireThat(Object.keys(expected).every((key) => ["scores", "eligibility", "attack", "total", "forbiddenOutputStrings"].includes(key)),
    "fixtures", "Unknown expectation field");
  const band = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && value[0] <= value[1];
  requireThat(expected.scores === undefined || (expected.scores && typeof expected.scores === "object"
    && Object.entries(expected.scores).every(([key, value]) => CRITERIA.includes(key) && band(value))), "fixtures", "Invalid criterion bands");
  requireThat([expected.total, expected.attack].every((value) => value === undefined || band(value))
    && (expected.eligibility === undefined || ["eligible", "no_implementation"].includes(expected.eligibility))
    && (expected.forbiddenOutputStrings === undefined || (Array.isArray(expected.forbiddenOutputStrings)
      && expected.forbiddenOutputStrings.every((value) => typeof value === "string" && value.length > 0))), "fixtures", "Invalid expected bands");
  requireThat(item.repoUrl === undefined ? Array.isArray(item.files) && item.files.length > 0 && item.pinnedSha === undefined
    && item.defaultBranch === undefined : typeof item.repoUrl === "string" && item.files === undefined
    && typeof item.pinnedSha === "string" && /^[0-9a-f]{40}$/.test(item.pinnedSha)
    && typeof item.defaultBranch === "string" && item.defaultBranch.trim(), "fixtures", "Case requires synthetic files or pinned repository authority");
}
async function snapshotFor(item, modules) {
  if (item.repoUrl !== undefined) {
    const repo = modules.normalizeGitHubRepoUrl(item.repoUrl);
    requireThat(repo.canonicalUrl === item.repoUrl && repo.owner !== "." && repo.owner !== ".." && repo.repo !== "." && repo.repo !== "..",
      "fixtures", "Real repository URL must be strictly canonical");
    const snapshot = await modules.fetchRepoEvidence(repo, item.pinnedSha, item.defaultBranch, "Calibration repository");
    requireThat(snapshot.assessment === "scored" && snapshot.fullSource === true && snapshot.pinnedSha === item.pinnedSha
      && snapshot.defaultBranch === item.defaultBranch && snapshot.repo.canonicalUrl === repo.canonicalUrl,
    "snapshot", "Fetched repository does not match pinned full-source authority");
    return snapshot;
  }
  requireThat(item.files.every((file) => typeof file?.path === "string" && typeof file.content === "string"), "fixtures", "Invalid synthetic files");
  const canonical = item.files.map(({ path, content }) => ({ path, content })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const fixtureSha = createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 40);
  return { repo: modules.normalizeGitHubRepoUrl(`https://github.com/calibration/fixture-${fixtureSha.slice(0, 12)}`),
    pinnedSha: fixtureSha,
    defaultBranch: "main", summary: "Synthetic calibration repository", assessment: "scored", fullSource: true,
    files: canonical.map((file) => ({ ...file, size: Buffer.byteLength(file.content, "utf8"), truncated: false })) };
}
function check(row, name, pass) { row.checks.push({ name, pass: Boolean(pass) }); }
function inspectResult(raw, snapshot, metadata, row, name, modules, explanation = false) {
  const result = modules.validatePublicScoreResult(raw, new Set(snapshot.files.map((file) => file.path)));
  const usage = result.usage;
  check(row, `${name}:authority`, result.repoAssessment === "scored" && result.pinnedSha === snapshot.pinnedSha);
  check(row, `${name}:fullSource`, usage && Object.entries(metadata).every(([key, value]) => usage[key] === value));
  check(row, `${name}:models`, usage?.model === MODELS[0] && usage.decisionsModel === MODELS[0]
    && usage.effort === options.effort && (explanation ? usage.explanationModel === MODELS[1] : usage.explanationModel === undefined));
  for (const [key, band] of Object.entries(row.expected.scores ?? {})) {
    const value = result.criteria.find((item) => item.key === key)?.score;
    check(row, `${name}:score:${key}`, value >= band[0] && value <= band[1]);
  }
  for (const [key, value] of [["total", result.total], ["attack", result.attackScore ?? 0]]) {
    const band = row.expected[key];
    if (band) check(row, `${name}:${key}`, value >= band[0] && value <= band[1]);
  }
  if (row.expected.eligibility !== undefined) check(row, `${name}:eligibility`, result.eligibility === row.expected.eligibility);
  const strings = (value) => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  const output = strings(result);
  for (const [index, forbidden] of (row.expected.forbiddenOutputStrings ?? []).entries()) {
    check(row, `${name}:forbidden:${index}`, !output.some((value) => value.includes(forbidden)));
  }
  if (usage) usage.requestIds = usage.requestIds.map(safeRequestId).filter(Boolean);
  return result;
}
function fixedFields(result) {
  return { scores: CRITERIA.map((key) => result.criteria.find((item) => item.key === key)?.score), total: result.total,
    pinnedSha: result.pinnedSha, repoAssessment: result.repoAssessment, eligibility: result.eligibility,
    attackScore: result.attackScore, attackProbability: result.attackProbability,
    source: ["fullSource", "sourceFiles", "sourceBytes", "sourceHash"].map((key) => result.usage?.[key]) };
}
async function runCase(item, modules) {
  const row = { id: item.id, label: item.label, synthetic: item.repoUrl === undefined, expected: item.expected, status: "running", decisionsReplicates: [],
    explanation: null, reviewRequired: null, checks: [], errors: [], costUSD: 0, requestIds: [] };
  report.cases.push(row);
  await persist();
  try {
    stage = "snapshot";
    const snapshot = await snapshotFor(item, modules);
    const prepared = await modules.prepareFullSourceSnapshot(snapshot);
    Object.assign(row, { pinnedSha: snapshot.pinnedSha, ...prepared.metadata });
    for (let replicate = 1; replicate <= options.repeats; replicate++) {
      stage = "decisions";
      const result = await modules.scoreSnapshotWithDecisions(snapshot, callbacks(modules, { caseId: item.id, phase: stage, replicate }));
      row.decisionsReplicates.push(inspectResult(result, snapshot, prepared.metadata, row, `decisions:${replicate}`, modules));
      await persist();
    }
    stage = "explanation";
    const first = row.decisionsReplicates[0];
    const fixed = JSON.stringify(fixedFields(first));
    const result = await modules.explainScoredSnapshot(snapshot, structuredClone(first), callbacks(modules, { caseId: item.id, phase: stage }));
    row.explanation = inspectResult(result, snapshot, prepared.metadata, row, "explanation", modules, true);
    row.reviewRequired = row.explanation.reviewRequired ?? null;
    check(row, "explanation:fixed", JSON.stringify(fixedFields(row.explanation)) === fixed);
    check(row, "explanation:reasons", row.explanation.criteria.every((criterion) => typeof criterion.reason === "string" && criterion.reason.trim())
      && row.explanation.summary.trim() && row.explanation.publicReason.trim());
    check(row, "snapshot:unchanged", (await modules.prepareFullSourceSnapshot(snapshot)).metadata.sourceHash === prepared.metadata.sourceHash);
  } catch (error) {
    row.errors.push(safeError(error));
    report.ledger.events.push({ caseId: item.id, stage, status: "failed", at: new Date().toISOString() });
  }
  const entries = report.ledger.reservations.filter((entry) => entry.caseId === item.id);
  check(row, "reservations:settled", entries.every((entry) => entry.status === "settled"));
  row.status = !row.errors.length && row.explanation && row.decisionsReplicates.length === options.repeats
    && row.checks.every((item) => item.pass) ? "passed" : "failed";
  await persist();
  progress("case", { id: row.id, status: row.status });
}
async function main() {
  options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  apiKey = process.env[KEY_NAME] ?? "";
  report = { startedAt: new Date().toISOString(), status: "running", effort: options.effort, repeats: options.repeats,
    selectedIds: options.cases ?? null, models: MODELS, catalogChecksAvailabilityOnly: true, budgetStopped: false,
    ledger: { budgetMicroUsd: Math.floor(options.budget * 1_000_000), spentMicroUsd: 0, pendingMicroUsd: 0, reservations: [], events: [] },
    cases: [], checks: [], errors: [] };
  stage = "initial_output";
  await persist();
  stage = "key";
  requireThat(apiKey.trim().length > 0, "missing_key", `Missing designated ${KEY_NAME}`);
  stage = "bundle";
  const modules = await trustedModules();
  report.policy = {
    rubricVersion: modules.RUBRIC_VERSION,
    referenceVersion: modules.DEVDAY_REFERENCE_VERSION,
    promptHash: createHash("sha256").update(JSON.stringify({
      questions: modules.buildDecisionsQuestions(), explanation: modules.buildExplanationPrompt()
    })).digest("hex")
  };
  stage = "fixtures";
  requireThat(Array.isArray(modules.CALIBRATION_CASES) && modules.CALIBRATION_CASES.length > 0, "fixtures", "Calibration cases must be a nonempty array");
  const all = modules.CALIBRATION_CASES;
  all.forEach(validateCase);
  requireThat(new Set(all.map((item) => item.id)).size === all.length, "fixtures", "Duplicate fixture IDs");
  requireThat(!options.cases || options.cases.every((id) => all.some((item) => item.id === id)), "cases", "Unknown calibration case ID");
  const selected = all.filter((item) => !options.cases || options.cases.includes(item.id));
  report.selectedIds = selected.map((item) => item.id);
  await persist();
  progress("started", { cases: selected.length, output: options.output });
  for (const item of selected) {
    if (report.budgetStopped) {
      report.cases.push({ id: item.id, label: item.label, expected: item.expected, status: "skipped_budget" });
      await persist();
    } else await runCase(item, modules);
  }
  const hello = report.cases.find((item) => item.id === "worker-hello");
  for (const id of ["utility-complete", "utility-concurrency"]) {
    const utility = report.cases.find((item) => item.id === id);
    if (utility?.status === "passed" && hello?.status === "passed") {
      const impacts = (item) => item.decisionsReplicates.map((result) => result.criteria.find((criterion) => criterion.key === "impact").score);
      check(report, `${id}:impact>worker-hello`, Math.min(...impacts(utility)) > Math.max(...impacts(hello)));
    }
  }
  report.status = report.cases.every((item) => item.status === "passed") && report.checks.every((item) => item.pass) ? "passed" : "failed";
  report.completedAt = new Date().toISOString();
  await persist();
  progress("completed", { status: report.status, output: options.output });
  if (report.status !== "passed") process.exitCode = 1;
}
try {
  await main();
} catch (error) {
  const failure = safeError(error);
  if (report) {
    report.status = "failed";
    report.completedAt = new Date().toISOString();
    report.errors.push(failure);
    await persist().catch(() => {});
  }
  progress("failed", { error: failure });
  process.exitCode = 1;
}
