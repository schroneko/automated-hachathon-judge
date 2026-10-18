import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "https://hackathon.nukoevi.app";
const SCHEMA = "devday-judging-batch-verification/v1";
const AXES = ["technical", "ux", "impact", "idea"];
const LABELS = { technical: "新機能の活用", ux: "使いやすさ", impact: "有用性", idea: "独創性" };
const LEVELS = [2, 4, 6, 8, 10];
const CONDITIONS = AXES.flatMap((axis) => LEVELS.map((level) => `${axis}_level_${level}`));
const DEADLINE_MS = 1_800_000;
const POLL_MS = 3_000;
const REQUEST_MS = 30_000;
const MAX_READ_ERRORS = 12;
const MAX_CONSECUTIVE_ERRORS = 5;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LIMITATION = "--budget limits the observed cumulative sum of all 30 returned per-submission costs, not a hard stop. It cannot cancel admitted jobs; monitoring continues after an overrun. Returned usage may omit failed or in-flight charges. The Worker ledger enforces the actual pre-reservation cap. Dashboard budget is production only; no public validation-budget endpoint is assumed.";
let report;
let output;
let releaseLock;
let activeRequest;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
}

function parseArgs(args) {
  if (args.includes("--help")) return { help: true };
  const options = { effort: "medium", live: false, dryRun: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    requireValue(["--input", "--output", "--effort", "--budget", "--live", "--dry-run"].includes(key), `Unknown argument: ${key}`);
    requireValue(!seen.has(key), `Duplicate argument: ${key}`);
    seen.add(key);
    if (key === "--live") options.live = true;
    else if (key === "--dry-run") options.dryRun = true;
    else {
      const value = args[++index];
      requireValue(typeof value === "string" && value.length > 0 && !value.startsWith("--"), `Missing value for ${key}`);
      options[key.slice(2)] = value;
    }
  }
  requireValue(!(options.live && options.dryRun), "--live and --dry-run are mutually exclusive");
  requireValue(options.input && options.output && options.budget, "--input, --output and --budget are required");
  requireValue(["low", "medium"].includes(options.effort), "--effort must be low or medium");
  requireValue(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(options.budget), "--budget must be positive USD");
  options.budget = Number(options.budget);
  requireValue(Number.isFinite(options.budget) && options.budget > 0, "--budget must be positive finite USD");
  options.input = resolve(options.input);
  options.output = resolve(options.output);
  requireValue(options.input !== options.output, "Input and output paths must differ");
  return options;
}

function repoUrl(value) {
  requireValue(typeof value === "string" && value.length <= 512, "Repository URL must be a string of at most 512 characters");
  const raw = value.trim();
  requireValue(/^https:\/\/(?:www\.)?github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/?$/i.test(raw), "Expected a GitHub HTTPS owner/repository URL without credentials, port, query, hash or extra paths");
  const url = new URL(raw);
  const parts = url.pathname.replace(/\/$/, "").slice(1).split("/");
  parts[1] = parts[1].replace(/\.git$/i, "");
  requireValue(parts.every((part) => part && part !== "." && part !== ".."), "Invalid repository path");
  return `https://github.com/${parts.join("/").toLowerCase()}`;
}

function demoUrl(value) {
  requireValue(typeof value === "string" && !/[\u0000-\u001f\u007f-\u009f\\]/.test(value), "Invalid demo URL");
  const raw = value.trim();
  if (!raw) return undefined;
  requireValue(raw.length <= 2048 && /^https?:\/\/[^/?#@]+(?:[/?#]|$)/i.test(raw), "Invalid demo URL");
  const url = new URL(raw);
  requireValue(["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password && url.href.length <= 2048, "Invalid demo URL");
  return url.href;
}

function readInput(path) {
  const input = JSON.parse(readFileSync(path, "utf8"));
  requireValue(Array.isArray(input) || (object(input) && Object.keys(input).length === 1 && Array.isArray(input.items)), "Input must be an array or an object containing only items");
  const values = Array.isArray(input) ? input : input.items;
  requireValue(values.length === 30, "Exactly 30 distinct repositories are required");
  const seen = new Set();
  const items = values.map((item, index) => {
    requireValue(object(item) && Object.keys(item).every((key) => ["repoUrl", "teamName", "demoUrl"].includes(key)), `Invalid item ${index + 1}`);
    const url = repoUrl(item.repoUrl);
    requireValue(!seen.has(url), `Duplicate repository: ${url}`);
    seen.add(url);
    requireValue(item.teamName === undefined || (typeof item.teamName === "string" && !/[\u0000-\u001f\u007f-\u009f]/.test(item.teamName)), `Invalid teamName at item ${index + 1}`);
    const teamName = `LOAD TEST ${item.teamName?.trim() || url.slice("https://github.com/".length)}`;
    requireValue(teamName.length <= 100, `teamName including LOAD TEST prefix exceeds 100 characters at item ${index + 1}`);
    const demo = item.demoUrl === undefined ? undefined : demoUrl(item.demoUrl);
    return { repoUrl: url, teamName, ...(demo === undefined ? {} : { demoUrl: demo }) };
  });
  return items.sort((a, b) => a.repoUrl < b.repoUrl ? -1 : a.repoUrl > b.repoUrl ? 1 : 0);
}

function regularFile(path) {
  try {
    const info = lstatSync(path);
    requireValue(info.isFile() && !info.isSymbolicLink(), `Refusing nonregular file: ${path}`);
    return info;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function lock(path) {
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  const owner = { pid: process.pid, host: hostname(), token };
  let fd;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Output lock exists: ${lockPath}. Refusing concurrent writers. After an uncatchable termination, verify no verifier is running before removing only the lock; retain the report and its UUID.`);
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify(owner));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return () => {
    if (regularFile(lockPath) && JSON.parse(readFileSync(lockPath, "utf8")).token === token) unlinkSync(lockPath);
  };
}

function persist() {
  report.updatedAt = new Date().toISOString();
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, output);
    const directory = openSync(dirname(output), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function event(name, details = {}) {
  const entry = { at: new Date().toISOString(), event: name, batchId: report.request.id, ...details };
  report.events.push(entry);
  persist();
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function failure(error, context) {
  const entry = { at: new Date().toISOString(), context, message: String(error.message || error).slice(0, 400) };
  report.errors.push(entry);
  event("error", { context, message: entry.message });
}

function diagnostic(severity, code, message, repo = null) {
  if (report.diagnostics.some((entry) => entry.code === code && entry.repo === repo && entry.message === message)) return;
  report.diagnostics.push({ at: new Date().toISOString(), severity, code, repo, message });
  event("diagnostic", { severity, code, ...(repo ? { repo } : {}) });
}

function prepare(options, items) {
  const intent = { mode: "validation", effort: options.effort, budgetUsd: options.budget, items };
  const info = regularFile(output);
  if (info) {
    const previous = JSON.parse(readFileSync(output, "utf8"));
    requireValue(previous.schema === SCHEMA && previous.baseUrl === BASE && object(previous.intent) && object(previous.request) && object(previous.lifecycle) && object(previous.records) && object(previous.budget) && object(previous.timings) && object(previous.polledJobStates) && Array.isArray(previous.events) && Array.isArray(previous.errors) && Array.isArray(previous.diagnostics), "Existing output is not this verifier's report schema; refusing to replace it");
    requireValue(canonical(previous.intent) === canonical(intent), "Existing report has different normalized input, effort or budget intent; refusing to replace its identity");
    requireValue(UUID.test(previous.request.id) && canonical(previous.request) === canonical({ id: previous.request.id, mode: "validation", effort: options.effort, items }) && previous.requestBody === JSON.stringify(previous.request), "Existing report request identity/body is invalid; refusing to replace it");
    requireValue(Number.isSafeInteger(previous.lifecycle.readErrors) && previous.lifecycle.readErrors >= 0 && ["not_attempted", "unknown", "accepted", "rejected"].includes(previous.lifecycle.postOutcome), "Invalid saved lifecycle");
    requireValue(previous.lifecycle.firstPostAttemptAt === null || timestamp(previous.lifecycle.firstPostAttemptAt), "Invalid saved POST attempt timestamp");
    requireValue(previous.lifecycle.deadlineAt === null || timestamp(previous.lifecycle.deadlineAt), "Invalid saved deadline timestamp");
    requireValue(previous.lifecycle.postOutcome === "not_attempted" ? previous.lifecycle.firstPostAttemptAt === null : timestamp(previous.lifecycle.firstPostAttemptAt), "Saved POST outcome and attempt identity disagree");
    requireValue(!previous.lifecycle.firstPostAttemptAt || timestamp(previous.lifecycle.deadlineAt), "Saved POST attempt has no durable deadline");
    requireValue(!previous.lifecycle.firstPostAttemptAt || Date.parse(previous.lifecycle.deadlineAt) === Date.parse(previous.lifecycle.firstPostAttemptAt) + DEADLINE_MS, "Saved POST deadline differs from the first attempt deadline");
    requireValue(!previous.lifecycle.acceptedAt || timestamp(previous.lifecycle.acceptedAt), "Invalid saved acceptance timestamp");
    requireValue(!previous.lifecycle.acceptedAt || timestamp(previous.lifecycle.deadlineAt), "Saved acceptance has no durable deadline");
    report = previous;
    return false;
  }
  const request = { id: randomUUID(), mode: "validation", effort: options.effort, items };
  requireValue(Buffer.byteLength(JSON.stringify(request)) <= 131_072, "Normalized request exceeds batch body limit");
  report = {
    schema: SCHEMA, baseUrl: BASE, createdAt: new Date().toISOString(), intent, request, requestBody: JSON.stringify(request), phase: "prepared",
    lifecycle: { firstPostAttemptAt: null, acceptedAt: null, acceptanceObservedAt: null, acceptanceBasis: null, deadlineAt: null, postOutcome: "not_attempted", postHttpStatus: null, readErrors: 0 },
    budget: { requestedUsd: options.budget, observedReturnedCostUsd: 0, maximumObservedReturnedCostUsd: 0, exceeded: false, limitation: LIMITATION },
    polledJobStates: { label: "Polled JOB STATES, not actual API concurrency", maxScoringProcessingWithoutResult: 0, maxReasonProcessing: 0 },
    timings: { allSourcesFixedObservedAt: null, allScoredObservedAt: null, allReasonsCompletedObservedAt: null, fromAcceptanceMs: {} },
    batch: null, records: {}, diagnostics: [], errors: [], events: []
  };
  event("prepared", { count: 30, effort: options.effort, budgetUsd: options.budget, budgetIsHardStop: false });
  return true;
}

function remaining() {
  return report.lifecycle.deadlineAt ? Date.parse(report.lifecycle.deadlineAt) - Date.now() : DEADLINE_MS;
}

async function request(path, method = "GET") {
  requireValue(remaining() > 0, "Monitoring deadline reached");
  const controller = new AbortController();
  activeRequest = controller;
  const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_MS, remaining()));
  try {
    const response = await fetch(`${BASE}${path}`, {
      method, redirect: "error", cache: "no-store", signal: controller.signal,
      headers: method === "POST" ? { Origin: BASE, "content-type": "application/json" } : { accept: "application/json" },
      ...(method === "POST" ? { body: report.requestBody } : {})
    });
    const raw = await response.text();
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      requireValue(response.status === 404, `HTTP ${response.status} returned invalid JSON`);
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    activeRequest = undefined;
  }
}

function accept(body, basis) {
  const { lifecycle } = report;
  if (!lifecycle.acceptedAt) {
    const observed = new Date().toISOString();
    requireValue(timestamp(body.batch.createdAt), "Accepted batch is missing its server creation timestamp");
    lifecycle.acceptanceObservedAt = observed;
    lifecycle.acceptedAt = basis === "POST 202" ? observed : body.batch.createdAt;
    lifecycle.acceptanceBasis = basis === "POST 202" ? "POST 202 received by client" : "server createdAt; actual acceptance response not observed";
    if (!lifecycle.deadlineAt) lifecycle.deadlineAt = new Date(Date.parse(body.batch.createdAt) + DEADLINE_MS).toISOString();
    report.phase = "monitoring";
    event("accepted", { basis: lifecycle.acceptanceBasis, deadlineAt: lifecycle.deadlineAt });
  }
}

function envelope(body) {
  requireValue(object(body) && object(body.batch) && Array.isArray(body.submissions), "Invalid batch response envelope");
  const batch = body.batch;
  requireValue(batch.id === report.request.id && batch.eventId === "devday-20261018" && batch.mode === "validation" && batch.effort === report.intent.effort, "Batch ID, event, mode or effort does not match the durable request");
  requireValue(["queued", "freezing", "scoring", "completed", "failed"].includes(batch.status), "Unknown batch status");
  requireValue(body.submissions.length === 30 && batch.counts?.total === 30, "Batch response must contain exactly 30 submissions");
  const expected = new Map(report.intent.items.map((item) => [item.repoUrl, item]));
  const ids = new Set();
  for (const item of body.submissions) {
    requireValue(object(item) && typeof item.id === "string" && item.id && !ids.has(item.id), "Missing or duplicate submission ID");
    ids.add(item.id);
    requireValue(typeof item.repoUrl === "string", "Missing submission repository URL");
    const url = repoUrl(item.repoUrl);
    const input = expected.get(url);
    requireValue(input && item.repoUrl === url, "Batch contains an unexpected, duplicate or noncanonical repository");
    expected.delete(url);
    requireValue(item.batchId === batch.id && item.eventId === batch.eventId && item.mode === "validation" && item.effort === report.intent.effort && item.teamName === input.teamName && (item.demoUrl ?? null) === (input.demoUrl ?? null), "Submission identity, metadata, mode or effort mismatch");
    requireValue(object(item.repo) && item.repo.normalized === url.slice("https://github.com/".length) && item.repo.canonicalUrl === url && `${item.repo.owner}/${item.repo.repo}` === item.repo.normalized, "Submission repository authority mismatch");
    requireValue(["queued", "processing", "completed", "failed"].includes(item.status) && (item.explanationStatus === undefined || ["pending", "processing", "completed", "failed"].includes(item.explanationStatus)), "Unknown submission or explanation status");
    requireValue(item.result === null || object(item.result), "Invalid result field");
  }
}

function fixedEvidence(result) {
  const usage = result.usage ?? {};
  return {
    scores: Array.isArray(result.criteria) ? result.criteria.map((entry) => [entry?.key ?? null, entry?.score ?? null]).sort(([a], [b]) => String(a).localeCompare(String(b))) : null,
    total: result.total ?? null, pinnedSha: result.pinnedSha ?? null,
    repoAssessment: result.repoAssessment ?? null, eligibility: result.eligibility ?? null, attackScore: result.attackScore ?? null, attackProbability: result.attackProbability ?? null,
    sourceHash: usage.sourceHash ?? null, sourceFiles: usage.sourceFiles ?? null, sourceBytes: usage.sourceBytes ?? null, fullSource: usage.fullSource ?? null,
    conditions: usage.decisionsConditions ?? null, probabilities: usage.decisionsConditionProbabilities ?? null, threshold: usage.conditionThreshold ?? null,
    decisionsScores: usage.decisionsScores ?? null, model: usage.model ?? null, decisionsModel: usage.decisionsModel ?? null, effort: usage.effort ?? null, rubricVersion: usage.rubricVersion ?? null, referenceVersion: usage.referenceVersion ?? null
  };
}

function validateResult(item, record) {
  const result = item.result;
  const usage = result.usage;
  const check = (valid, code, message) => { if (!valid) diagnostic("error", code, message, item.repo.normalized); };
  const exactKeys = (value, keys) => object(value) && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
  check(Array.isArray(result.criteria) && result.criteria.length === 4 && canonical(result.criteria.map((entry) => entry?.key).sort()) === canonical([...AXES].sort()), "axes", "Result must contain exactly the four known axes");
  const criteria = Array.isArray(result.criteria) ? result.criteria.filter(object) : [];
  check(criteria.length === 4 && criteria.every((entry) => [0, ...LEVELS].includes(entry.score)), "score_levels", "Criterion scores must be 0, 2, 4, 6, 8 or 10");
  check(criteria.every((entry) => entry.label === LABELS[entry.key]), "criterion_labels", "Criterion labels must match the official axes");
  check(criteria.every((entry) => Array.isArray(entry.evidencePaths) && entry.evidencePaths.length <= 24 && entry.evidencePaths.every((path) => typeof path === "string" && path.length > 0 && path.length <= 1024)), "evidence_paths", "Evidence paths must be arrays of nonempty path strings");
  check(Number.isInteger(result.total) && result.total >= 0 && result.total <= 40 && result.total === criteria.reduce((sum, entry) => sum + entry.score, 0), "score_sum", "Total must equal criteria sum; the separate attack score is excluded");
  check(result.reviewRequired === undefined || typeof result.reviewRequired === "boolean", "review_type", "reviewRequired must be a boolean when present");
  check(result.attackScore === null || (Number.isInteger(result.attackScore) && result.attackScore >= 80 && result.attackScore <= 100), "attack_score", "Separate attack score must be null or an integer from 80 to 100");
  if (result.attackProbability !== undefined) check(Number.isFinite(result.attackProbability) && result.attackProbability >= 0 && result.attackProbability <= 1 && result.attackScore === (result.attackProbability >= 0.8 ? Math.round(result.attackProbability * 100) : null), "attack_probability", "Separate attack score must match the probability visibility threshold");
  check(SHA.test(result.pinnedSha ?? "") && result.pinnedSha === record.pinnedSha, "result_sha", "Result must retain the first observed 40-character pinned SHA");
  check(result.repoAssessment === "scored", "repo_assessment", "This real-repository test requires a scored repository assessment");
  check(object(usage), "usage", "Scored result is missing usage evidence");
  if (!object(usage)) return;
  check(usage.fullSource === true && Number.isInteger(usage.sourceFiles) && usage.sourceFiles >= 0 && Number.isInteger(usage.sourceBytes) && usage.sourceBytes >= 0 && HASH.test(usage.sourceHash ?? ""), "source_metadata", "Complete fullSource metadata with a 64-character source hash is required");
  check(usage.rubricVersion === "2026-10-18-v4" && usage.model === "gpt-6-luna" && usage.decisionsModel === "gpt-6-luna" && usage.effort === report.intent.effort, "scoring_authority", "Expected v4, gpt-6-luna Decisions and the selected effort");
  check(Number.isFinite(usage.costUsd) && usage.costUsd >= 0 && Number.isSafeInteger(Math.round(usage.costUsd * 1_000_000)), "cost", "Returned costUsd must be finite, nonnegative and representable in micro USD");
  check(Number.isInteger(usage.inputTokens) && usage.inputTokens >= 0 && Number.isInteger(usage.outputTokens) && usage.outputTokens >= 0, "tokens", "Returned token counts must be nonnegative integers");
  check(Array.isArray(usage.requestIds) && usage.requestIds.length <= 2 && usage.requestIds.every((id) => typeof id === "string" && id.length > 0), "request_ids", "Usage requestIds must contain at most two nonempty strings");
  const conditionsValid = exactKeys(usage.decisionsConditions, CONDITIONS) && CONDITIONS.every((name) => typeof usage.decisionsConditions[name] === "boolean");
  const probabilitiesValid = exactKeys(usage.decisionsConditionProbabilities, CONDITIONS) && CONDITIONS.every((name) => Number.isFinite(usage.decisionsConditionProbabilities[name]) && usage.decisionsConditionProbabilities[name] >= 0 && usage.decisionsConditionProbabilities[name] <= 1);
  check(conditionsValid, "conditions", "Exactly the 20 known boolean conditions are required");
  check(probabilitiesValid, "probabilities", "Exactly the 20 known finite probabilities in [0,1] are required");
  check(usage.conditionThreshold === 0.8, "threshold", "Condition threshold must be 0.8");
  check(exactKeys(usage.decisionsScores, AXES), "decisions_axes", "Decisions scores must contain exactly the four known axes");
  if (conditionsValid && probabilitiesValid) {
    check(CONDITIONS.every((name) => usage.decisionsConditions[name] === (usage.decisionsConditionProbabilities[name] >= 0.8)), "condition_probability", "Booleans must equal probability >= 0.8");
    const nonmonotonic = [];
    for (const axis of AXES) {
      let gap = false;
      let score = 0;
      for (const level of LEVELS) {
        if (!usage.decisionsConditions[`${axis}_level_${level}`]) gap = true;
        else if (gap) nonmonotonic.push(`${axis}_level_${level}`);
        else score = level;
      }
      check(criteria.find((entry) => entry.key === axis)?.score === score && usage.decisionsScores?.[axis] === score, "prefix_score", `Scores for ${axis} must match the initial true prefix`);
    }
    if (nonmonotonic.length) {
      diagnostic("review", "nonmonotonic_conditions", `Nonmonotonic conditions retained: ${nonmonotonic.join(", ")}`, item.repo.normalized);
      check(result.reviewRequired === true, "nonmonotonic_review", "Nonmonotonic conditions require reviewRequired to remain true");
    }
  }
  if (record.reviewRequiredObserved) check(result.reviewRequired === true, "review_flag_removed", "A previously observed reviewRequired flag was removed");
  if (result.reviewRequired === true) {
    record.reviewRequiredObserved = true;
    diagnostic("review", "review_required", "Public result is marked for review", item.repo.normalized);
  }
  if (item.status === "completed" && item.explanationStatus === "completed") {
    check(usage.explanationModel === "gpt-6.1-sol", "explanation_authority", "Completed explanation must use gpt-6.1-sol");
    check(criteria.every((entry) => Array.isArray(entry.evidencePaths) && entry.evidencePaths.length > 0) || result.reviewRequired === true, "explanation_evidence_review", "A completed explanation with empty evidence paths requires reviewRequired");
    const japanese = (text) => typeof text === "string" && text.trim().length > 0 && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text);
    check(japanese(result.summary) && japanese(result.publicReason) && criteria.length === 4 && criteria.every((entry) => japanese(entry.reason)), "japanese_explanation", "Completed summary, publicReason and all four reasons must contain nonempty Japanese text");
  }
}

function terminal(item) {
  return item.status === "failed" || (item.status === "completed" && ["completed", "failed"].includes(item.explanationStatus));
}

function observe(body) {
  envelope(body);
  const now = new Date().toISOString();
  const previousDigest = report.observationDigest;
  const batch = body.batch;
  const frozen = body.submissions.every((item) => timestamp(item.frozenAt) && SHA.test(item.pinnedSha ?? ""));
  const barrier = frozen && timestamp(batch.frozenAt);
  for (const field of ["createdAt", "startedAt", "frozenAt", "completedAt"]) {
    if (batch[field] !== null && batch[field] !== undefined && !timestamp(batch[field])) diagnostic("error", "batch_timestamp", `Invalid batch ${field}`);
  }
  if (body.submissions.some((item) => item.result !== null || item.status === "processing") && !barrier) diagnostic("error", "source_barrier", "Scoring was observed before every source and the batch were frozen");
  for (const item of body.submissions) {
    const repo = item.repo.normalized;
    const record = report.records[repo] ??= { id: item.id, repoUrl: item.repoUrl, firstObservedAt: now, pinnedSha: null, fixedEvidence: null, firstSourceFixedObservedAt: null, firstScoredObservedAt: null, firstReasonProcessingObservedAt: null, firstReasonsCompletedObservedAt: null, firstTerminalObservedAt: null, maxObservedCostUsd: 0, statusHistory: [] };
    if (record.id !== item.id) diagnostic("error", "submission_id_changed", "Submission ID changed for the same repository", repo);
    record.firstStatusObservedAt ??= {};
    record.firstReasonStatusObservedAt ??= {};
    record.firstStatusObservedAt[item.status] ??= now;
    if (item.explanationStatus) record.firstReasonStatusObservedAt[item.explanationStatus] ??= now;
    for (const field of ["createdAt", "updatedAt", "startedAt", "frozenAt", "scoredAt", "completedAt"]) {
      if (item[field] !== null && item[field] !== undefined && !timestamp(item[field])) diagnostic("error", "submission_timestamp", `Invalid submission ${field}`, repo);
    }
    if (item.pinnedSha !== null && item.pinnedSha !== undefined) {
      if (!SHA.test(item.pinnedSha)) diagnostic("error", "pinned_sha", "Pinned SHA must contain 40 lowercase hex characters", repo);
      if (record.pinnedSha === null) record.pinnedSha = item.pinnedSha;
      else if (record.pinnedSha !== item.pinnedSha) diagnostic("error", "pinned_sha_changed", "First observed pinned SHA changed", repo);
    } else if (record.pinnedSha !== null) diagnostic("error", "pinned_sha_removed", "First observed pinned SHA disappeared", repo);
    if (timestamp(item.frozenAt) && SHA.test(item.pinnedSha ?? "")) record.firstSourceFixedObservedAt ??= now;
    if (record.firstSourceFixedObservedAt && !timestamp(item.frozenAt)) diagnostic("error", "source_unfrozen", "Previously fixed source lost its frozenAt timestamp", repo);
    if (barrier && [item.startedAt, item.scoredAt].some((value) => timestamp(value) && Date.parse(value) < Date.parse(batch.frozenAt))) diagnostic("error", "score_before_barrier", "Server scoring timestamp precedes the batch source-freeze barrier", repo);
    if (barrier && Date.parse(item.frozenAt) > Date.parse(batch.frozenAt)) diagnostic("error", "freeze_order", "Submission frozenAt is after the batch freeze barrier", repo);
    if (item.result !== null) {
      record.firstScoredObservedAt ??= now;
      const evidence = fixedEvidence(item.result);
      if (record.fixedEvidence === null) record.fixedEvidence = evidence;
      else if (canonical(record.fixedEvidence) !== canonical(evidence)) diagnostic("error", "fixed_result_changed", "Fixed scores, SHA, source metadata or Decisions evidence changed during later responses", repo);
      validateResult(item, record);
      const cost = item.result.usage?.costUsd;
      if (Number.isFinite(cost) && cost >= 0 && Number.isSafeInteger(Math.round(cost * 1_000_000))) {
        if (cost < record.maxObservedCostUsd) diagnostic("error", "cost_decreased", "Cumulative returned per-submission cost decreased", repo);
        record.maxObservedCostUsd = Math.max(Math.round(record.maxObservedCostUsd * 1_000_000), Math.round(cost * 1_000_000)) / 1_000_000;
      }
      record.sourceFiles = item.result.usage?.sourceFiles ?? null;
      record.sourceBytes = item.result.usage?.sourceBytes ?? null;
      record.costUsd = cost ?? null;
    } else if (record.fixedEvidence !== null) diagnostic("error", "result_disappeared", "A previously observed fixed result disappeared", repo);
    if (item.explanationStatus === "processing") record.firstReasonProcessingObservedAt ??= now;
    if (item.explanationStatus === "completed") record.firstReasonsCompletedObservedAt ??= now;
    if (item.status === "failed" || item.explanationStatus === "failed") diagnostic("error", "job_failed", item.failureMessage || "Submission or explanation failed", repo);
    if (terminal(item)) {
      record.firstTerminalObservedAt ??= now;
      record.finalPublicResult = item.result;
      if (item.status === "completed" && item.result === null) diagnostic("error", "completed_without_result", "Completed submission has no result", repo);
    }
    const state = { status: item.status, explanationStatus: item.explanationStatus ?? null, hasResult: item.result !== null, pinnedSha: item.pinnedSha ?? null, frozenAt: item.frozenAt ?? null, startedAt: item.startedAt ?? null, scoredAt: item.scoredAt ?? null, completedAt: item.completedAt ?? null, costUsd: item.result?.usage?.costUsd ?? null };
    if (canonical(record.statusHistory.at(-1)?.state ?? null) !== canonical(state)) record.statusHistory.push({ observedAt: now, state });
    record.latestPublic = item;
  }
  report.batch = batch;
  const scoring = body.submissions.filter((item) => item.status === "processing" && item.result === null).length;
  const reasons = body.submissions.filter((item) => item.explanationStatus === "processing").length;
  report.polledJobStates.maxScoringProcessingWithoutResult = Math.max(report.polledJobStates.maxScoringProcessingWithoutResult, scoring);
  report.polledJobStates.maxReasonProcessing = Math.max(report.polledJobStates.maxReasonProcessing, reasons);
  const cost = Object.values(report.records).reduce((sum, record) => sum + Math.round(record.maxObservedCostUsd * 1_000_000), 0) / 1_000_000;
  report.budget.observedReturnedCostUsd = body.submissions.reduce((sum, item) => sum + (Number.isFinite(item.result?.usage?.costUsd) && item.result.usage.costUsd >= 0 && Number.isSafeInteger(Math.round(item.result.usage.costUsd * 1_000_000)) ? Math.round(item.result.usage.costUsd * 1_000_000) : 0), 0) / 1_000_000;
  report.budget.maximumObservedReturnedCostUsd = Math.max(report.budget.maximumObservedReturnedCostUsd, cost);
  if (cost > report.intent.budgetUsd) {
    report.budget.exceeded = true;
    diagnostic("error", "observed_budget_exceeded", "Observed cumulative returned usage exceeded --budget; admitted jobs cannot be cancelled and read-only monitoring continues");
  }
  if (barrier) report.timings.allSourcesFixedObservedAt ??= now;
  if (body.submissions.every((item) => item.result !== null)) report.timings.allScoredObservedAt ??= now;
  if (body.submissions.every((item) => item.explanationStatus === "completed")) report.timings.allReasonsCompletedObservedAt ??= now;
  for (const field of ["allSourcesFixedObservedAt", "allScoredObservedAt", "allReasonsCompletedObservedAt"]) {
    if (report.timings[field]) report.timings.fromAcceptanceMs[field] = Date.parse(report.timings[field]) - Date.parse(report.lifecycle.acceptedAt);
  }
  report.observationDigest = digest(body);
  if (previousDigest !== report.observationDigest) event("observation", { batchStatus: batch.status, frozen: body.submissions.filter((item) => item.frozenAt).length, scored: body.submissions.filter((item) => item.result !== null).length, reasonsCompleted: body.submissions.filter((item) => item.explanationStatus === "completed").length, terminal: body.submissions.filter(terminal).length, scoringProcessingJobs: scoring, reasonProcessingJobs: reasons, maxPolledScoringJobs: report.polledJobStates.maxScoringProcessingWithoutResult, maxPolledReasonJobs: report.polledJobStates.maxReasonProcessing, observedCostUsd: report.budget.maximumObservedReturnedCostUsd });
  return body.submissions.every(terminal);
}

async function preflight() {
  const response = await request("/api/dashboard");
  requireValue(response.status === 200 && object(response.body) && Array.isArray(response.body.items), `Dashboard preflight failed: HTTP ${response.status}`);
  const body = response.body;
  const existing = body.items.filter((item) => item.mode === "validation");
  const limit = body.event?.submissionLimits?.validation;
  requireValue(Number.isInteger(limit) && limit >= 0 && body.open === true && body.runner?.online === true, "Validation preflight requires known registration limit, open submissions and online runner");
  requireValue(existing.length + 30 <= limit, "Insufficient validation registration slots for exactly 30 repositories");
  const wanted = new Set(report.intent.items.map((item) => item.repoUrl));
  requireValue(!existing.some((item) => wanted.has(repoUrl(item.repoUrl))), "A requested repository is already registered in validation mode");
  report.preflight = { at: new Date().toISOString(), validationRegistered: existing.length, validationLimit: limit, open: body.open, runnerOnline: body.runner.online, budgetScope: "Dashboard budget is production only and was not used" };
  event("preflight_passed", { validationRegistered: existing.length, validationLimit: limit, budgetIsHardStop: false });
}

function finish(phase) {
  report.phase = phase;
  report.finishedAt = new Date().toISOString();
  report.failedJobs = Object.values(report.records).filter((record) => record.latestPublic?.status === "failed" || record.latestPublic?.explanationStatus === "failed").map((record) => ({ id: record.id, repoUrl: record.repoUrl, status: record.latestPublic.status, explanationStatus: record.latestPublic.explanationStatus, failureMessage: record.latestPublic.failureMessage }));
  report.unfinishedRepositories = report.intent.items.filter((item) => !report.records[item.repoUrl.slice("https://github.com/".length)]?.latestPublic || !terminal(report.records[item.repoUrl.slice("https://github.com/".length)].latestPublic)).map((item) => item.repoUrl);
  event("finished", { phase, failedJobs: report.failedJobs.length, integrityErrors: report.diagnostics.filter((entry) => entry.severity === "error").length, observedCostUsd: report.budget.maximumObservedReturnedCostUsd, budgetIsHardStop: false });
  process.exitCode = phase === "succeeded" ? 0 : 1;
}

async function live() {
  let consecutiveErrors = 0;
  let initialLookup = true;
  while (true) {
    if (remaining() <= 0) return finish("deadline_exceeded");
    let response;
    try {
      response = await request(`/api/batches/${report.request.id}`);
      requireValue([200, 404].includes(response.status), `Batch GET failed: HTTP ${response.status}`);
      if (response.status === 200) envelope(response.body);
      consecutiveErrors = 0;
    } catch (error) {
      report.lifecycle.readErrors += 1;
      consecutiveErrors += 1;
      failure(error, "batch_get");
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS || report.lifecycle.readErrors >= MAX_READ_ERRORS) return finish("read_error_limit");
      if (remaining() <= 0) return finish("deadline_exceeded");
      await sleep(Math.min(POLL_MS, remaining()));
      continue;
    }
    if (response.status === 200) {
      accept(response.body, "GET 200");
      if (observe(response.body)) {
        const allCompleted = response.body.submissions.every((item) => item.status === "completed" && item.explanationStatus === "completed" && item.result !== null);
        if (!["completed", "failed"].includes(response.body.batch.status)) diagnostic("error", "batch_terminal_status", "Every job is terminal but the batch is not terminal");
        if (response.body.batch.status === "failed") diagnostic("error", "batch_failed", response.body.batch.failureMessage || "Batch failed");
        return finish(allCompleted && response.body.batch.status === "completed" && !report.diagnostics.some((entry) => entry.severity === "error") ? "succeeded" : "failed");
      }
    } else if (initialLookup && !report.lifecycle.firstPostAttemptAt && !report.lifecycle.acceptedAt) {
      try {
        await preflight();
      } catch (error) {
        failure(error, "preflight");
        return finish("preflight_failed");
      }
      const now = new Date().toISOString();
      report.lifecycle.firstPostAttemptAt = now;
      report.lifecycle.deadlineAt = new Date(Date.parse(now) + DEADLINE_MS).toISOString();
      report.lifecycle.postOutcome = "unknown";
      report.phase = "post_attempted";
      event("post_attempted", { deadlineAt: report.lifecycle.deadlineAt });
      try {
        const posted = await request("/api/batches", "POST");
        report.lifecycle.postHttpStatus = posted.status;
        if (posted.status === 202) {
          envelope(posted.body);
          report.lifecycle.postOutcome = "accepted";
          accept(posted.body, "POST 202");
          observe(posted.body);
        } else {
          report.lifecycle.postOutcome = [400, 401, 403, 409, 410, 413, 415, 422, 429].includes(posted.status) ? "rejected" : "unknown";
          failure(new Error(`POST returned HTTP ${posted.status}; no POST will be repeated`), "batch_post");
        }
      } catch (error) {
        failure(error, "batch_post_outcome_unknown");
      }
      persist();
    } else if (report.lifecycle.postOutcome === "rejected" && !report.lifecycle.acceptedAt) {
      return finish("post_rejected");
    } else if (!report.lifecycle.firstPostAttemptAt && !report.lifecycle.acceptedAt) {
      return finish("batch_not_found");
    } else if (!report.missingAfterAttemptObservedAt) {
      report.missingAfterAttemptObservedAt = new Date().toISOString();
      event("awaiting_batch_visibility", { postWillNotBeRepeated: true });
    }
    initialLookup = false;
    if (remaining() <= 0) return finish("deadline_exceeded");
    await sleep(Math.min(POLL_MS, remaining()));
  }
}

function signalHandler(signal) {
  activeRequest?.abort();
  try {
    if (report) {
      report.phase = "interrupted";
      event("interrupted", { signal, postWillNotBeRepeated: Boolean(report.lifecycle.firstPostAttemptAt) });
    }
  } catch {
    process.stderr.write(`${JSON.stringify({ event: "signal_persistence_failed", signal })}\n`);
  }
  try {
    releaseLock?.();
  } catch {
    process.stderr.write(`${JSON.stringify({ event: "lock_release_failed" })}\n`);
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`Usage: node scripts/verify-judging-batch.mjs --input PATH --output PATH --budget USD [--effort low|medium] [--dry-run | --live]\n\nDefault: dry run, medium effort, no network. --live enables only public GETs and at most one durable validation batch POST.\nInput: exactly 30 distinct {repoUrl, teamName?, demoUrl?} objects, as an array or {items: [...]}. GitHub HTTPS owner/repo URLs are normalized to lowercase.\nOutput: private atomic JSON report; keep it for every rerun. Existing intent and UUID/body are preserved. Unknown POST outcomes are observed only, never resubmitted. No retry/recover endpoints or source execution.\nLive monitoring: 3-second GET polls, requests at most 30 seconds, persisted 1800-second deadline from the first POST attempt or existing server acceptance. At most 5 consecutive or 12 cumulative read errors.\n${LIMITATION}\nConcurrency evidence is polled JOB STATES, not actual API concurrency. Nonmonotonic model conditions are review diagnostics, not target score-band failures.\nExit: 0 for a prepared dry run or all 30 verified successes, 1 for failure/deadline, 130/143 for signals.\n`);
    return;
  }
  const items = readInput(options.input);
  output = options.output;
  releaseLock = lock(output);
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
  const fresh = prepare(options, items);
  if (!options.live) {
    if (!fresh) event("dry_run_reused", { count: 30, effort: options.effort, network: false, postPreviouslyAttempted: Boolean(report.lifecycle.firstPostAttemptAt) });
    return;
  }
  await live();
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  if (report) {
    try {
      failure(error, "fatal");
      finish("fatal_error");
    } catch {
      process.stderr.write(`${JSON.stringify({ event: "report_persistence_failed" })}\n`);
    }
  } else process.stderr.write(`${JSON.stringify({ event: "error", message: String(error.message || error).slice(0, 400) })}\n`);
} finally {
  try {
    releaseLock?.();
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${JSON.stringify({ event: "lock_release_failed", message: String(error.message || error).slice(0, 200) })}\n`);
  }
}
