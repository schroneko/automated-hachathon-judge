ALTER TABLE devday_judge_submissions ADD COLUMN explanation_status TEXT CHECK (explanation_status IN ('pending', 'processing', 'completed', 'failed'));
ALTER TABLE devday_judge_submissions ADD COLUMN evidence_snapshot_json TEXT;
ALTER TABLE devday_judge_submissions ADD COLUMN decisions_result_json TEXT;
ALTER TABLE devday_judge_submissions ADD COLUMN scored_at TEXT;
ALTER TABLE devday_judge_submissions ADD COLUMN explanation_dispatches INTEGER NOT NULL DEFAULT 0 CHECK (explanation_dispatches BETWEEN 0 AND 3);
ALTER TABLE devday_judge_submissions ADD COLUMN explanation_requested_at TEXT;
ALTER TABLE devday_judge_submissions ADD COLUMN explanation_started_at TEXT;

UPDATE devday_judge_submissions SET explanation_status = 'completed', scored_at = COALESCE(completed_at, updated_at) WHERE result_json IS NOT NULL;
