ALTER TABLE devday_judge_submissions ADD COLUMN recovery_dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_dispatch_count BETWEEN 0 AND 1);
ALTER TABLE devday_judge_submissions ADD COLUMN recovery_requested_at TEXT;
ALTER TABLE devday_judge_submissions ADD COLUMN recovery_previous_started_at TEXT;
ALTER TABLE devday_judge_submissions ADD COLUMN recovery_previous_updated_at TEXT;
