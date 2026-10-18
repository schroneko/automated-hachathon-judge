ALTER TABLE devday_judge_submissions ADD COLUMN rescore_request_id TEXT;
ALTER TABLE devday_judge_submissions ADD COLUMN rescore_requested_at TEXT;

CREATE TABLE devday_judge_scoring_history (
  submission_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  submission_json TEXT NOT NULL CHECK (json_valid(submission_json)),
  PRIMARY KEY (submission_id, event_id, request_id),
  FOREIGN KEY (submission_id) REFERENCES devday_judge_submissions(id)
);

CREATE TABLE devday_judge_rescore_evidence_manifests (
  submission_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  callback_token TEXT NOT NULL,
  pinned_sha TEXT,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 1 AND 4194304),
  chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 8),
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  PRIMARY KEY (submission_id, event_id, attempt, callback_token),
  FOREIGN KEY (submission_id) REFERENCES devday_judge_submissions(id)
);

CREATE TABLE devday_judge_rescore_evidence_chunks (
  submission_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  callback_token TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 7),
  content BLOB NOT NULL CHECK (typeof(content) = 'blob' AND length(content) BETWEEN 1 AND 524288),
  PRIMARY KEY (submission_id, event_id, attempt, callback_token, chunk_index),
  FOREIGN KEY (submission_id, event_id, attempt, callback_token) REFERENCES devday_judge_rescore_evidence_manifests(submission_id, event_id, attempt, callback_token)
);
