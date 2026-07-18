import { Codex } from "@openai/codex-sdk";
import { CODEX_TIMEOUT_MS } from "../shared/constants";
import { buildScoringPrompt } from "../shared/prompt";
import { calculateNukoScore, visibleNukoScore } from "../shared/nuko-score";
import { validatePublicScoreResult, codexOutputSchema } from "../shared/validation";
import type { LeaseJob, PublicScoreResult } from "../shared/types";
import { fetchRepoEvidence, resolveRepoEvidence, RetryableGithubError, zeroResultForAssessment } from "./github";
import { createReadonlyWorkspace } from "./workspace";

export class RetryableScoringError extends Error {}

export async function scoreSubmission(job: LeaseJob): Promise<PublicScoreResult> {
  let snapshot;
  try {
    snapshot = job.pinnedSha && job.defaultBranch
      ? await fetchRepoEvidence(job.repo, job.pinnedSha, job.defaultBranch, job.summary)
      : await resolveRepoEvidence(job.repo, job.summary);
  } catch (error) {
    if (error instanceof RetryableGithubError) {
      throw new RetryableScoringError(error.message);
    }
    throw error;
  }

  if (snapshot.assessment !== "scored") {
    return zeroResultForAssessment(snapshot);
  }

  const workspace = await createReadonlyWorkspace(job.submissionId, snapshot);
  const prompt = buildScoringPrompt(snapshot);
  const nukoScore = visibleNukoScore(calculateNukoScore(snapshot.files));
  const codex = new Codex({
    env: {
      HOME: process.env.HOME ?? "/root",
      PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    },
    config: { web_search_mode: "disabled" }
  });

  try {
    const thread = codex.startThread({
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      sandboxMode: "read-only",
      model: process.env.CODEX_MODEL ?? "gpt-5.4",
      modelReasoningEffort: "medium",
      networkAccessEnabled: false,
      webSearchMode: "disabled"
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CODEX_TIMEOUT_MS);
    const turn = await thread.run(prompt, { outputSchema: codexOutputSchema, signal: controller.signal }).finally(() => clearTimeout(timer));

    const parsed =
      typeof turn.finalResponse === "string"
        ? validatePublicScoreResult(JSON.parse(turn.finalResponse))
        : validatePublicScoreResult(turn.finalResponse);
    const result = {
      ...parsed,
      pinnedSha: snapshot.pinnedSha,
      nukoScore
    };
    return validatePublicScoreResult(result, new Set(snapshot.files.map((file) => file.path)));
  } catch (error) {
    if (isRetryableCodexError(error)) {
      throw new RetryableScoringError(error instanceof Error ? error.message : "Codex transient failure");
    }
    throw error;
  }
}

function isRetryableCodexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("timeout") || message.includes("timed out") || message.includes("econn") || message.includes("503") || message.includes("rate limit") || message.includes("stream disconnected") || message.includes("error sending request");
}
