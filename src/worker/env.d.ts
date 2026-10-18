interface Env {
  ASSETS: Fetcher;
  JUDGE_DB: D1Database;
  SCORING_QUEUE: Queue<import("../shared/types").ScoringQueueMessage>;
  RUNNER_TOKEN?: string;
  JUDGING_ENABLED?: string;
  OPENAI_API_KEY_20261018_HACKATHON?: string;
  SUBMISSIONS_OPEN?: string;
}
