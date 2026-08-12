-- V0.3.2 adds vocabulary provenance and typed review values without rewriting
-- any V0.2/V0.3.1 snapshot payload or historical physical label.

ALTER TABLE annotation_creative_structures
  ADD COLUMN IF NOT EXISTS vocabulary_version TEXT NOT NULL DEFAULT 'V0.3.1';

ALTER TABLE analysis_revision_events
  ADD COLUMN IF NOT EXISTS value_type TEXT NOT NULL DEFAULT 'TEXT';

ALTER TABLE analysis_revision_events
  ADD COLUMN IF NOT EXISTS original_value_json TEXT;

ALTER TABLE analysis_revision_events
  ADD COLUMN IF NOT EXISTS replacement_value_json TEXT;

ALTER TABLE analysis_revision_events
  ADD COLUMN IF NOT EXISTS vocabulary_version TEXT NOT NULL DEFAULT 'V0.3.1';

CREATE INDEX IF NOT EXISTS analysis_revision_events_value_type_idx
  ON analysis_revision_events(review_round_id, value_type, created_at);
