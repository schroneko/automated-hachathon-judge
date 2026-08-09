interface Env {
  ASSETS: Fetcher;
  JUDGE_STATE: DurableObjectNamespace<import("./judge-state").JudgeState>;
  CALLBACKS_ENABLED?: string;
  JUDGE_STATE_ROWS_WRITTEN_DAILY_LIMIT?: string;
  JUDGE_STATE_ROWS_WRITTEN_DAILY_WARNING?: string;
  MAX_ACCEPTED_SUBMISSIONS?: string;
  RUNNER_TOKEN?: string;
  RUNNER_ENABLED?: string;
  PUBLIC_BASE_URL?: string;
  SUBMISSIONS_OPEN?: string;
  UNRANKED_OWNERS?: string;
}
