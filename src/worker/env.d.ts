interface Env {
  ASSETS: Fetcher;
  JUDGE_STATE: DurableObjectNamespace<import("./judge-state").JudgeState>;
  CALLBACKS_ENABLED?: string;
  MAX_ACCEPTED_SUBMISSIONS?: string;
  RUNNER_TOKEN?: string;
  RUNNER_ENABLED?: string;
  PUBLIC_BASE_URL?: string;
  SUBMISSIONS_OPEN?: string;
  UNRANKED_OWNERS?: string;
}
