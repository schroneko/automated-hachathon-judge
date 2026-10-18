ALTER TABLE devday_judge_submissions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0);
UPDATE devday_judge_submissions SET attempts = 1 WHERE status IN ('processing', 'completed', 'failed');
