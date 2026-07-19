interface Env {
  ASSETS: Fetcher;
  JUDGE_STATE: DurableObjectNamespace<import("./judge-state").JudgeState>;
  RUNNER_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
  SUBMISSIONS_OPEN?: string;
}
