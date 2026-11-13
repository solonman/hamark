-- 上传查重的指纹表（docs/28_上传查重_实施规格_V0.1.md 四）。
-- 与 db/upload-dedup-schema.ts 中的 UPLOAD_DEDUP_SCHEMA_STATEMENTS 一一对应。
--
-- 生产执行方式：在 Supabase SQL 编辑器里整段执行本文件。
-- 不要用 `npm run db:migrate` 应用到生产（会被 V0.4 契约漂移守卫中止）。
--
-- 本迁移是附加式的：只新增 upload_fingerprints 一张表、两个索引及其 RLS 收口。
-- 不修改、不删除任何既有表、约束或触发器。可重复执行。
-- 执行之前代码也能跑：查重只比字节数，指纹登记静默跳过。

BEGIN;

CREATE TABLE IF NOT EXISTS upload_fingerprints (
  id TEXT PRIMARY KEY,
  library TEXT NOT NULL CONSTRAINT upload_fingerprints_library_check CHECK (library IN ('VIDEO', 'REPORT', 'VISUAL', 'RETRO', 'AUDIO_REVIEW')),
  source TEXT NOT NULL CONSTRAINT upload_fingerprints_source_check CHECK (source IN ('VIDEO', 'REPORT', 'VISUAL_ASSET', 'RETRO_ASSET', 'RETRO_RECORDING', 'AUDIO_REVIEW')),
  target_id TEXT NOT NULL,
  file_size BIGINT NOT NULL CONSTRAINT upload_fingerprints_file_size_check CHECK (file_size > 0),
  sample_sha256 TEXT,
  media_kind TEXT NOT NULL CONSTRAINT upload_fingerprints_media_kind_check CHECK (media_kind IN ('VIDEO', 'IMAGE', 'FILE')),
  frame_hashes TEXT,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  algorithm_version TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT upload_fingerprints_target_uniq UNIQUE (source, target_id)
);

CREATE INDEX IF NOT EXISTS upload_fingerprints_size_idx ON upload_fingerprints (library, file_size);
CREATE INDEX IF NOT EXISTS upload_fingerprints_kind_idx ON upload_fingerprints (library, media_kind) WHERE frame_hashes IS NOT NULL;

ALTER TABLE upload_fingerprints ENABLE ROW LEVEL SECURITY;

DO $upload_dedup_schema_revoke_public_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE upload_fingerprints FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE upload_fingerprints FROM authenticated';
  END IF;
END
$upload_dedup_schema_revoke_public_roles$;

COMMIT;
