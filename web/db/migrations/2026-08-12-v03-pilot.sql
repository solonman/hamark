-- V0.3-PILOT is additive at the data level. V0.2 rows and snapshots remain unchanged.
ALTER TABLE annotations ADD COLUMN IF NOT EXISTS workflow_version TEXT NOT NULL DEFAULT 'REVERSE-WORKFLOW-V0.2';
ALTER TABLE annotations ADD COLUMN IF NOT EXISTS source_snapshot_id TEXT;
DROP INDEX IF EXISTS annotations_video_author_idx;
CREATE UNIQUE INDEX IF NOT EXISTS annotations_video_author_taxonomy_idx
  ON annotations(video_id, author_email, taxonomy_version);

CREATE TABLE IF NOT EXISTS annotation_taxonomy_versions (
  taxonomy_version TEXT PRIMARY KEY,
  workflow_version TEXT NOT NULL,
  status TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
INSERT INTO annotation_taxonomy_versions (taxonomy_version, workflow_version, status, label)
VALUES
  ('V0.2', 'REVERSE-WORKFLOW-V0.2', 'ACTIVE', '原19项标注体系 V0.2'),
  ('V0.3-PILOT', 'REVERSE-WORKFLOW-V0.3-PILOT', 'PILOT', '人机工作流 V0.3-PILOT')
ON CONFLICT (taxonomy_version) DO NOTHING;

CREATE TABLE IF NOT EXISTS shot_groups (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL REFERENCES annotations(id),
  order_index INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  primary_role_id TEXT NOT NULL DEFAULT '',
  primary_role_name_snapshot TEXT NOT NULL DEFAULT '',
  auxiliary_roles_json TEXT NOT NULL DEFAULT '[]',
  custom_role TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  taxonomy_version TEXT NOT NULL DEFAULT 'V0.3-PILOT',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE UNIQUE INDEX IF NOT EXISTS shot_groups_annotation_order_idx
  ON shot_groups(annotation_id, order_index);

ALTER TABLE shots ADD COLUMN IF NOT EXISTS shot_group_id TEXT REFERENCES shot_groups(id);
ALTER TABLE field_answers ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'HUMAN_ORIGINAL';

CREATE TABLE IF NOT EXISTS annotation_creative_structures (
  annotation_id TEXT PRIMARY KEY REFERENCES annotations(id),
  creative_button TEXT NOT NULL DEFAULT '',
  mechanism_statement TEXT NOT NULL DEFAULT '',
  mechanism_primary TEXT NOT NULL DEFAULT '',
  mechanism_auxiliary_json TEXT NOT NULL DEFAULT '[]',
  mechanism_custom TEXT NOT NULL DEFAULT '',
  realization_skeleton TEXT NOT NULL DEFAULT '',
  brand_product_landing TEXT NOT NULL DEFAULT '',
  story_reference_type TEXT NOT NULL DEFAULT '',
  story_archetype TEXT NOT NULL DEFAULT '',
  primary_creative_path TEXT NOT NULL DEFAULT '',
  auxiliary_creative_paths_json TEXT NOT NULL DEFAULT '[]',
  composite_state_reason TEXT NOT NULL DEFAULT '',
  formation_primary TEXT NOT NULL DEFAULT '',
  formation_auxiliary_json TEXT NOT NULL DEFAULT '[]',
  formation_statement TEXT NOT NULL DEFAULT '',
  formation_related_group_ids_json TEXT NOT NULL DEFAULT '[]',
  creative_carriers TEXT NOT NULL DEFAULT '',
  establishment_conditions TEXT NOT NULL DEFAULT '',
  strength_sources TEXT NOT NULL DEFAULT '',
  acceptance_contract TEXT NOT NULL DEFAULT '',
  audiovisual_mechanism TEXT NOT NULL DEFAULT '',
  information_release_turning TEXT NOT NULL DEFAULT '',
  creative_grade TEXT NOT NULL DEFAULT '',
  creative_grade_reason TEXT NOT NULL DEFAULT '',
  creative_grade_version TEXT NOT NULL DEFAULT 'CREATIVE-GRADE-V0.1',
  main_path_payload_json TEXT NOT NULL DEFAULT '{}',
  auxiliary_path_notes_json TEXT NOT NULL DEFAULT '{}',
  condition_flags_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
