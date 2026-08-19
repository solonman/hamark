-- Minimal pre-1A history used only inside a guarded TEST_ONLY schema.
-- It contains representative V0.2/V0.3 rows but no V0.4 contract or business row.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  wecom_corp_id TEXT NOT NULL,
  wecom_user_id TEXT NOT NULL,
  identity_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  last_login_at TEXT NOT NULL DEFAULT '',
  last_synced_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  CHECK (status IN ('ACTIVE', 'DISABLED'))
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  domain_key TEXT NOT NULL DEFAULT 'AD_VIDEO',
  title TEXT NOT NULL,
  brand TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  object_key TEXT NOT NULL,
  thumbnail_key TEXT,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'video/mp4',
  file_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'READY',
  rights_confirmed INTEGER NOT NULL DEFAULT 1,
  created_by_email TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  deleted_at TEXT
);

CREATE TABLE annotation_taxonomy_versions (
  taxonomy_version TEXT PRIMARY KEY,
  workflow_version TEXT NOT NULL,
  status TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id),
  author_email TEXT NOT NULL,
  author_name TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  revision INTEGER NOT NULL DEFAULT 0,
  analysis_title TEXT NOT NULL DEFAULT '',
  commercial_intent TEXT NOT NULL DEFAULT '',
  synopsis TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE shot_groups (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL REFERENCES annotations(id),
  order_index INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT ''
);

CREATE TABLE shots (
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
  shot_group_id TEXT REFERENCES shot_groups(id)
);

CREATE TABLE annotation_snapshots (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL REFERENCES annotations(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  author_email TEXT NOT NULL,
  author_name TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL DEFAULT 'SUBMISSION',
  created_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT ''
);

INSERT INTO users (
  id, wecom_corp_id, wecom_user_id, identity_key, display_name, email, status
) VALUES
  ('user_active', 'corp', 'active', 'corp:active', 'Active User', 'owner@example.com', 'ACTIVE'),
  ('user_disabled', 'corp', 'disabled', 'corp:disabled', 'Disabled User', 'disabled@example.com', 'DISABLED'),
  ('user_duplicate_a', 'corp', 'duplicate-a', 'corp:duplicate-a', 'Duplicate A', 'duplicate@example.com', 'ACTIVE'),
  ('user_duplicate_b', 'corp', 'duplicate-b', 'corp:duplicate-b', 'Duplicate B', 'DUPLICATE@example.com', 'DISABLED');

INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, last_seen_at, created_at)
VALUES ('session_active', 'user_active', 'test-only-token', '2099-01-01', '2026-08-19', '2026-08-19');

INSERT INTO annotation_taxonomy_versions (
  taxonomy_version, workflow_version, status, label
) VALUES
  ('V0.2', 'REVERSE-WORKFLOW-V0.2', 'ACTIVE', 'V0.2 history'),
  ('V0.3-PILOT', 'REVERSE-WORKFLOW-V0.3-PILOT', 'PILOT', 'V0.3 history');

INSERT INTO videos (
  id, title, object_key, original_name, created_by_email, created_by_name
) VALUES
  ('video_v02', 'TEST_ONLY V0.2', 'test/v02.mp4', 'v02.mp4', 'owner@example.com', 'Owner'),
  ('video_v03', 'TEST_ONLY V0.3', 'test/v03.mp4', 'v03.mp4', 'owner@example.com', 'Owner'),
  ('video_v04', 'TEST_ONLY V0.4', 'test/v04.mp4', 'v04.mp4', 'owner@example.com', 'Owner'),
  ('video_identity_disabled', 'TEST_ONLY disabled identity', 'test/disabled.mp4', 'disabled.mp4', 'disabled@example.com', 'Disabled'),
  ('video_identity_duplicate', 'TEST_ONLY duplicate identity', 'test/duplicate.mp4', 'duplicate.mp4', 'duplicate@example.com', 'Duplicate'),
  ('video_identity_missing', 'TEST_ONLY missing identity', 'test/missing.mp4', 'missing.mp4', 'missing@example.com', 'Missing');

INSERT INTO annotations (
  id, video_id, author_email, author_name, taxonomy_version, workflow_version,
  status, revision, analysis_title, commercial_intent, synopsis
) VALUES
  ('annotation_v02', 'video_v02', 'owner@example.com', 'Owner', 'V0.2', 'REVERSE-WORKFLOW-V0.2',
   'SUBMITTED', 1, 'V0.2 title', 'V0.2 intent', 'V0.2 synopsis'),
  ('annotation_v03', 'video_v03', 'owner@example.com', 'Owner', 'V0.3-PILOT', 'REVERSE-WORKFLOW-V0.3-PILOT',
   'DRAFT', 3, 'V0.3 title', 'V0.3 intent', 'V0.3 synopsis');

INSERT INTO shot_groups (id, annotation_id, order_index, title) VALUES
  ('group_v02', 'annotation_v02', 0, 'V0.2 group'),
  ('group_v03', 'annotation_v03', 0, 'V0.3 group');

INSERT INTO shots (
  id, annotation_id, order_index, shot_number, visual_content, shot_group_id
) VALUES
  ('shot_v02', 'annotation_v02', 0, '1', 'V0.2 visual', 'group_v02'),
  ('shot_v03', 'annotation_v03', 0, '1', 'V0.3 visual', 'group_v03');

INSERT INTO annotation_snapshots (
  id, annotation_id, video_id, author_email, author_name, taxonomy_version,
  revision, payload_json, content_hash, snapshot_kind
) VALUES
  ('snapshot_v02', 'annotation_v02', 'video_v02', 'owner@example.com', 'Owner', 'V0.2',
   1, '{"version":"V0.2"}', 'legacy-v02-hash', 'SUBMISSION'),
  ('snapshot_v03', 'annotation_v03', 'video_v03', 'owner@example.com', 'Owner', 'V0.3-PILOT',
   3, '{"version":"V0.3"}', 'legacy-v03-hash', 'WORKING');
