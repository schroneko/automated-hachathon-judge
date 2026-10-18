export const API_BODY_LIMIT_BYTES = 2048;
export const BATCH_BODY_LIMIT_BYTES = 131_072;
export const BATCH_ITEM_LIMIT = 30;
export const SUBMISSION_DEADLINE_ISO = "2026-10-18T08:15:59.000Z";
export const JUDGING_START_ISO = "2026-10-18T08:30:00.000Z";
export const CALLBACK_BODY_LIMIT_BYTES = 131_072;
export const EVENT_ID = "devday-20261018";
export const EVENT_NAME = "DevDay Community Hackathon";
export const EVENT_DATE = "2026-10-18";
export const TARGET_TEAMS = 30;
export const FINALIST_COUNT = 10;
export const PRODUCTION_SUBMISSION_LIMIT = 40;
export const VALIDATION_SUBMISSION_LIMIT = 140;
export const MAX_MEMORY_DEFERRALS = 360;
export const MEMORY_DEFERRAL_DELAY_SECONDS = 5;
export const MAX_EVIDENCE_FILES = 2000;
export const MAX_EVIDENCE_TOTAL_BYTES = 3 * 1024 * 1024;
export const MAX_SNAPSHOT_SERIALIZED_BYTES = 4 * 1024 * 1024;
export const MAX_EVIDENCE_FILE_BYTES = 3 * 1024 * 1024;
export const RUNNER_ONLINE_WINDOW_MS = 30 * 60 * 1000;

export const CRITERIA = [
  { key: "technical", label: "新機能の活用", focus: "DevDay 2026で発表された機能を、目的に合った形で活用しているか？" },
  { key: "ux", label: "使いやすさ", focus: "他の人にとって使いやすいものになっているか？" },
  { key: "impact", label: "有用性", focus: "他の人にとって今後どれだけ役に立つ可能性があるか？" },
  { key: "idea", label: "独創性", focus: "着眼点や解決方法にオリジナリティがあるか？" }
] as const;
