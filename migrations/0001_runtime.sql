CREATE TABLE IF NOT EXISTS devday_judge_submissions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  repo_normalized TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  team_name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('production', 'validation')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  callback_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  pinned_sha TEXT,
  failure_message TEXT,
  result_json TEXT,
  outcome_json TEXT,
  UNIQUE (event_id, repo_normalized, mode)
);

CREATE INDEX IF NOT EXISTS devday_judge_submissions_queue ON devday_judge_submissions (event_id, mode, status, created_at, id);
CREATE INDEX IF NOT EXISTS devday_judge_submissions_ranking ON devday_judge_submissions (event_id, mode, status, completed_at);

CREATE TABLE IF NOT EXISTS devday_judge_budget_accounts (
  mode TEXT PRIMARY KEY CHECK (mode IN ('production', 'validation')),
  limit_micro_usd INTEGER NOT NULL CHECK (limit_micro_usd >= 0),
  spent_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (spent_micro_usd >= 0),
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0)
);

INSERT OR IGNORE INTO devday_judge_budget_accounts (mode, limit_micro_usd) VALUES ('production', 90000000), ('validation', 20000000);

CREATE TABLE IF NOT EXISTS devday_judge_budget_reservations (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES devday_judge_submissions(id),
  callback_token TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('production', 'validation')),
  kind TEXT NOT NULL CHECK (kind IN ('decisions', 'responses')),
  model TEXT NOT NULL,
  max_input_tokens INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  reserved_micro_usd INTEGER NOT NULL CHECK (reserved_micro_usd > 0),
  actual_micro_usd INTEGER,
  usage_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled')),
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE INDEX IF NOT EXISTS devday_judge_budget_reservations_submission ON devday_judge_budget_reservations (submission_id, status);
