ALTER TABLE devday_judge_submissions ADD COLUMN dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0 AND dispatch_count <= 3);

UPDATE devday_judge_submissions SET dispatch_count = CASE WHEN attempts < 1 THEN 1 ELSE attempts END;
