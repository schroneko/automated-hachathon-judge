import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoEvidenceSnapshot } from "../shared/types";

export async function createReadonlyWorkspace(submissionId: string, snapshot: RepoEvidenceSnapshot): Promise<string> {
  const workspace = join("/tmp", "nukoevi-evals", submissionId);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(join(workspace, "input"), { recursive: true });
  await writeFile(join(workspace, "input", "snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
  await chmod(join(workspace, "input", "snapshot.json"), 0o444);
  await chmod(join(workspace, "input"), 0o555);
  await chmod(workspace, 0o555);
  return workspace;
}
