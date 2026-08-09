export const API_BODY_LIMIT_BYTES = 2048;
export const CALLBACK_BODY_LIMIT_BYTES = 131_072;
export const DEFAULT_MAX_ACCEPTED_SUBMISSIONS = 500;
export const IP_SUBMISSION_COOLDOWN_MS = 1_000;
export const MAX_RECENT_SUBMISSIONS = 50;
export const MAX_RECOVERED_JOBS_PER_REQUEST = 10;
export const SCORER_BUCKET_COUNT = 10;
export const MAX_EVIDENCE_FILES = 24;
export const MAX_EVIDENCE_TOTAL_BYTES = 120_000;
export const MAX_EVIDENCE_FILE_BYTES = 12_000;
export const CODEX_TIMEOUT_MS = 180_000;
export const RUNNER_ONLINE_WINDOW_MS = 30_000;
export const CALLBACK_PATH_PREFIX = "/internal/scoring-callback";
export const STATE_OBJECT_NAME = "global";

export const CRITERIA = [
  {
    key: "technical",
    label: "技術的な実装",
    focus: "completeness, architecture, robustness, security"
  },
  {
    key: "ux",
    label: "デザインとユーザー体験",
    focus: "UI structure, flow, consistency, accessibility, based only on repository evidence"
  },
  {
    key: "impact",
    label: "潜在的なインパクト",
    focus: "importance, audience, practicality, growth potential"
  },
  {
    key: "idea",
    label: "アイデアの質",
    focus: "originality, problem-solution fit, insight"
  }
] as const;

export const SCORE_ANCHORS = "0 means no evaluable evidence; 1-2 very early/minimal; 3-4 partially works with major gaps; 5-6 meets baseline; 7-8 clearly strong; 9-10 exceptional for a hackathon.";
