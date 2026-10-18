import { readFile, mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.argv[2];
if (!source) throw new Error("Pass the SQL export containing submissions, batches and budget accounts");
const sql = await readFile(source, "utf8");
const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
database.exec(sql);
const bundle = await build({ entryPoints: [resolve(root, "src/worker/api.ts")], bundle: true, platform: "node", format: "esm", write: false });
globalThis.fetch = () => { throw new Error("Archive generation must not make network requests"); };
const { handleApiRequest } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const env = {
  JUDGING_ENABLED: "false",
  SUBMISSIONS_OPEN: "false",
  JUDGE_DB: {
    prepare(query) {
      if (!/^SELECT\s/i.test(query.trim())) throw new Error("Archive only permits SELECT");
      let values = [];
      return {
        bind(...next) { values = next; return this; },
        async first(column) {
          const row = database.prepare(query).get(...values) ?? null;
          return column && row ? row[column] : row;
        },
        async all() { return { results: database.prepare(query).all(...values) }; }
      };
    }
  }
};
const response = await handleApiRequest(new Request("https://archive.invalid/api/dashboard"), env, {});
if (!response.ok) throw new Error(`Dashboard generation failed: ${response.status}`);
const dashboard = await response.json();
dashboard.items = dashboard.items.filter(item => item.mode === "production");
dashboard.batches = dashboard.batches.filter(batch => batch.mode === "production");
dashboard.readOnly = true;
dashboard.archivedAt = new Date().toISOString();
dashboard.open = false;
dashboard.runner = { online: false, lastSeenAt: dashboard.runner.lastSeenAt };
if (!dashboard.items.length || dashboard.items.length !== dashboard.counts.total) throw new Error("Production archive count mismatch");
for (const item of dashboard.items) {
  const stored = database.prepare("SELECT result_json, pinned_sha FROM devday_judge_submissions WHERE id = ? AND mode = ?").get(item.id, "production");
  if (!stored || item.pinnedSha !== stored.pinned_sha || JSON.stringify(item.result) !== JSON.stringify(stored.result_json ? JSON.parse(stored.result_json) : null)) throw new Error("Archive changed a stored judgment");
}
const target = resolve(root, "public/api");
async function save(path, value) {
  const file = resolve(target, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}
await save("dashboard", dashboard);
await save("ranking", { items: dashboard.ranking });
await save("recent", { items: dashboard.items });
await save("submission-status", { open: false, closed: true, readOnly: true });
await save("runner-status", { online: false, lastSeenAt: dashboard.runner.lastSeenAt });
for (const item of dashboard.items) {
  await save(`submissions/${item.id}`, item);
  await save(`results/${item.id}`, item);
}
const sourceHash = createHash("sha256").update(sql).digest("hex");
console.log(JSON.stringify({ sourceHash, archivedAt: dashboard.archivedAt, submissions: dashboard.items.length, scored: dashboard.items.filter(item => item.result !== null).length, explanations: dashboard.items.filter(item => item.explanationStatus === "completed").length, ranking: dashboard.ranking.length }));
