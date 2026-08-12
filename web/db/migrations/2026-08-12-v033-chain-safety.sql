-- V0.3.3 adds explicit test isolation, version identity and revision lineage.
-- All changes are additive; existing snapshots and release payloads stay untouched.

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS data_scope TEXT NOT NULL DEFAULT 'BUSINESS';
ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS test_run_id TEXT;
CREATE INDEX IF NOT EXISTS videos_data_scope_idx ON videos(data_scope, created_at);

ALTER TABLE annotations
  ADD COLUMN IF NOT EXISTS base_release_id TEXT REFERENCES approved_analysis_releases(id);
ALTER TABLE annotations
  ADD COLUMN IF NOT EXISTS base_snapshot_id TEXT REFERENCES annotation_snapshots(id);
ALTER TABLE annotations
  ADD COLUMN IF NOT EXISTS source_public_snapshot_id TEXT REFERENCES annotation_snapshots(id);

ALTER TABLE annotation_snapshots
  ADD COLUMN IF NOT EXISTS base_release_id TEXT REFERENCES approved_analysis_releases(id);
ALTER TABLE annotation_snapshots
  ADD COLUMN IF NOT EXISTS source_public_snapshot_id TEXT REFERENCES annotation_snapshots(id);

ALTER TABLE analysis_revision_events
  ADD COLUMN IF NOT EXISTS change_set_id TEXT;
CREATE INDEX IF NOT EXISTS analysis_revision_events_change_set_idx
  ON analysis_revision_events(review_round_id, change_set_id, created_at);
