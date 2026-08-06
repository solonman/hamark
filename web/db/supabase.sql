CREATE TABLE IF NOT EXISTS app_admins (
  display_name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

INSERT INTO app_admins (display_name) VALUES
  ('老孙'),
  ('李丽萍'),
  ('晏恩华')
ON CONFLICT (display_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  domain_key TEXT NOT NULL DEFAULT 'AD_VIDEO',
  title TEXT NOT NULL,
  brand TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  object_key TEXT NOT NULL,
  thumbnail_key TEXT,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'UPLOADING',
  rights_confirmed INTEGER NOT NULL DEFAULT 0,
  created_by_email TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  deleted_at TEXT
);

ALTER TABLE videos ADD COLUMN IF NOT EXISTS thumbnail_key TEXT;

CREATE INDEX IF NOT EXISTS videos_status_idx ON videos(status);
CREATE INDEX IF NOT EXISTS videos_created_at_idx ON videos(created_at);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id),
  author_email TEXT NOT NULL,
  author_name TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL DEFAULT 'V0.2',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  revision INTEGER NOT NULL DEFAULT 0,
  analysis_title TEXT NOT NULL DEFAULT '',
  commercial_intent TEXT NOT NULL DEFAULT '',
  creative_theme TEXT NOT NULL DEFAULT '',
  synopsis TEXT NOT NULL DEFAULT '',
  thinking_chain TEXT NOT NULL DEFAULT '',
  shot_commentary TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  submitted_at TEXT,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS annotations_video_author_idx ON annotations(video_id, author_email);
CREATE INDEX IF NOT EXISTS annotations_video_status_idx ON annotations(video_id, status);

CREATE TABLE IF NOT EXISTS shots (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL REFERENCES annotations(id),
  order_index INTEGER NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  shot_number TEXT NOT NULL DEFAULT '',
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  shot_size TEXT NOT NULL DEFAULT '',
  camera_angle TEXT NOT NULL DEFAULT '',
  camera_movement TEXT NOT NULL DEFAULT '',
  visual_content TEXT NOT NULL DEFAULT '',
  dialogue TEXT NOT NULL DEFAULT '',
  voiceover TEXT NOT NULL DEFAULT '',
  screen_text TEXT NOT NULL DEFAULT '',
  sound_effect TEXT NOT NULL DEFAULT '',
  music TEXT NOT NULL DEFAULT '',
  creative_comment TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS shots_annotation_order_idx ON shots(annotation_id, order_index);

CREATE TABLE IF NOT EXISTS field_answers (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL REFERENCES annotations(id),
  field_code TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS field_answers_annotation_code_idx ON field_answers(annotation_id, field_code);

CREATE TABLE IF NOT EXISTS annotation_snapshots (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL REFERENCES annotations(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  author_email TEXT NOT NULL,
  author_name TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

CREATE INDEX IF NOT EXISTS annotation_snapshots_video_idx ON annotation_snapshots(video_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS annotation_snapshots_annotation_revision_idx ON annotation_snapshots(annotation_id, revision);

CREATE TABLE IF NOT EXISTS assignment_reviews (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES annotation_snapshots(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  submission_revision INTEGER NOT NULL,
  grader_email TEXT NOT NULL,
  grader_name TEXT NOT NULL,
  grader_role TEXT NOT NULL DEFAULT 'PEER',
  rubric_version TEXT NOT NULL DEFAULT 'RUBRIC-V0.4',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  revision INTEGER NOT NULL DEFAULT 0,
  scores_json TEXT NOT NULL DEFAULT '{}',
  total_score REAL NOT NULL DEFAULT 0,
  general_comment TEXT NOT NULL DEFAULT '',
  discussion_nomination INTEGER NOT NULL DEFAULT 0,
  is_valid_for_aggregate INTEGER NOT NULL DEFAULT 1,
  weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  submitted_at TEXT,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS assignment_reviews_submission_grader_idx ON assignment_reviews(submission_id, grader_email);
CREATE INDEX IF NOT EXISTS assignment_reviews_submission_status_idx ON assignment_reviews(submission_id, status);

CREATE TABLE IF NOT EXISTS assignment_review_snapshots (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES assignment_reviews(id),
  submission_id TEXT NOT NULL REFERENCES annotation_snapshots(id),
  grader_email TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

CREATE UNIQUE INDEX IF NOT EXISTS assignment_review_snapshots_revision_idx ON assignment_review_snapshots(review_id, revision);
CREATE INDEX IF NOT EXISTS assignment_review_snapshots_submission_idx ON assignment_review_snapshots(submission_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  wecom_corp_id TEXT NOT NULL,
  wecom_user_id TEXT NOT NULL,
  identity_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  last_login_at TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (wecom_corp_id, wecom_user_id),
  CHECK (status IN ('ACTIVE', 'DISABLED'))
);

CREATE TABLE IF NOT EXISTS user_departments (
  user_id TEXT NOT NULL REFERENCES users(id),
  wecom_department_id TEXT NOT NULL,
  department_name TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (user_id, wecom_department_id)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  browser_nonce_hash TEXT NOT NULL,
  return_to TEXT NOT NULL DEFAULT '/',
  flow_type TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (flow_type IN ('QR', 'IN_APP'))
);

CREATE INDEX IF NOT EXISTS oauth_states_expires_at_idx ON oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS wecom_app_tokens (
  corp_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (corp_id, agent_id)
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE wecom_app_tokens ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

CREATE INDEX IF NOT EXISTS audit_logs_object_idx ON audit_logs(object_type, object_id);
