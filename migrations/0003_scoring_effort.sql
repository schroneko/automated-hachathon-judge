ALTER TABLE devday_judge_submissions ADD COLUMN effort TEXT NOT NULL DEFAULT 'high' CHECK (effort IN ('low', 'high'));

UPDATE devday_judge_submissions SET effort = 'low' WHERE mode = 'validation';
