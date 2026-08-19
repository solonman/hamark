export const ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS admin_data_operations (
    operation_key TEXT PRIMARY KEY,
    operation_type TEXT NOT NULL,
    target_video_id TEXT NOT NULL,
    status TEXT NOT NULL,
    actor_identity TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    preview_token TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    target_hash TEXT NOT NULL,
    non_target_hash TEXT NOT NULL,
    backup_json JSONB NOT NULL,
    result_json JSONB,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
    completed_at TEXT,
    CHECK (status IN ('RUNNING', 'COMPLETED'))
  )`,
  `ALTER TABLE admin_data_operations ENABLE ROW LEVEL SECURITY`,
  `CREATE OR REPLACE FUNCTION protect_admin_data_operation()
  RETURNS trigger AS $operation_guard$
  BEGIN
    IF OLD.operation_key LIKE 'TEST_ONLY_%' THEN
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'completed administrator data operations are immutable';
    END IF;
    IF NEW.operation_key IS DISTINCT FROM OLD.operation_key
      OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
      OR NEW.target_video_id IS DISTINCT FROM OLD.target_video_id
      OR NEW.actor_identity IS DISTINCT FROM OLD.actor_identity
      OR NEW.actor_name IS DISTINCT FROM OLD.actor_name
      OR NEW.preview_token IS DISTINCT FROM OLD.preview_token
      OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
      OR NEW.target_hash IS DISTINCT FROM OLD.target_hash
      OR NEW.non_target_hash IS DISTINCT FROM OLD.non_target_hash
      OR NEW.backup_json IS DISTINCT FROM OLD.backup_json
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'administrator data operation backup and identity are immutable';
    END IF;
    IF OLD.status = 'COMPLETED' AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.result_json IS DISTINCT FROM OLD.result_json
      OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    ) THEN
      RAISE EXCEPTION 'completed administrator data operations are permanently locked';
    END IF;
    IF OLD.status = 'RUNNING' AND NEW.status <> 'COMPLETED' THEN
      RAISE EXCEPTION 'administrator data operations can only transition to completed';
    END IF;
    RETURN NEW;
  END;
  $operation_guard$ LANGUAGE plpgsql`,
  `DO $install_guard$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'admin_data_operations_immutable'
        AND tgrelid = 'admin_data_operations'::regclass
    ) THEN
      CREATE TRIGGER admin_data_operations_immutable
      BEFORE UPDATE OR DELETE ON admin_data_operations
      FOR EACH ROW EXECUTE FUNCTION protect_admin_data_operation();
    END IF;
  END
  $install_guard$`,
] as const;
