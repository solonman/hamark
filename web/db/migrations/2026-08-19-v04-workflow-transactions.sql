-- Stage 1 batch 1B compatibility: a vocabulary field can occur in distinct
-- primary and auxiliary semantic slots on the same annotation/shot group.
-- The DRAFT contract has not been activated, so this is schema-only and does
-- not rewrite any V0.2/V0.3 or V0.4 business payload.
BEGIN;

ALTER TABLE annotation_choice_values
    ADD COLUMN IF NOT EXISTS value_slot TEXT NOT NULL DEFAULT 'PRIMARY';

ALTER TABLE annotation_choice_values
    DROP CONSTRAINT IF EXISTS annotation_choice_values_annotation_id_target_type_target_id_field_key_key;

ALTER TABLE annotation_choice_values
    DROP CONSTRAINT IF EXISTS annotation_choice_values_annotation_id_target_type_target_i_key;

DO $v04_choice_slot_constraints$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'annotation_choice_values_slot_check'
        AND conrelid = 'annotation_choice_values'::regclass
    ) THEN
      ALTER TABLE annotation_choice_values
        ADD CONSTRAINT annotation_choice_values_slot_check
        CHECK (value_slot IN ('PRIMARY', 'AUXILIARY'));
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'annotation_choice_values_target_slot_key'
        AND conrelid = 'annotation_choice_values'::regclass
    ) THEN
      ALTER TABLE annotation_choice_values
        ADD CONSTRAINT annotation_choice_values_target_slot_key
        UNIQUE (annotation_id, target_type, target_id, field_key, value_slot);
    END IF;
  END
  $v04_choice_slot_constraints$;

COMMIT;
