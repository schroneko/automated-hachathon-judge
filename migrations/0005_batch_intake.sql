CREATE TABLE devday_judge_batches (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('production', 'validation')),
  effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high')),
  request_json TEXT NOT NULL,
  admission_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'freezing', 'scoring', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  frozen_at TEXT,
  completed_at TEXT,
  failure_message TEXT,
  freeze_dispatches INTEGER NOT NULL DEFAULT 1 CHECK (freeze_dispatches BETWEEN 1 AND 3),
  freeze_dispatched_at TEXT
);

ALTER TABLE devday_judge_submissions ADD COLUMN batch_id TEXT REFERENCES devday_judge_batches(id);
ALTER TABLE devday_judge_submissions ADD COLUMN submitted_at TEXT;
ALTER TABLE devday_judge_submissions ADD COLUMN default_branch TEXT;
ALTER TABLE devday_judge_submissions ADD COLUMN frozen_at TEXT;
ALTER TABLE devday_judge_submissions ADD COLUMN frozen_resolution_json TEXT;
ALTER TABLE devday_judge_submissions ADD COLUMN scoring_effort TEXT CHECK (scoring_effort IN ('low', 'medium', 'high'));

CREATE INDEX devday_judge_submissions_batch ON devday_judge_submissions (batch_id, id);
CREATE INDEX devday_judge_batches_event ON devday_judge_batches (event_id, created_at, id);
