// 上传查重的指纹表。见 docs/28_上传查重_实施规格_V0.1.md 四。
// 附加式：只新增 upload_fingerprints 一张表，不动任何既有表。
//
// 一行对应「某张业务表的某一行」现在那份文件：source + target_id 唯一，视频换片时整行
// 更新成新文件。指纹由上传人的浏览器算好登记进来，服务端只存、只比，不读对象存储。
// 不建外键：source 指向六张不同的表，且查重只在读的时候按各表的「还在库里」条件过滤。

export const UPLOAD_DEDUP_SCHEMA_TABLES = ["upload_fingerprints"] as const;

export const UPLOAD_DEDUP_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS upload_fingerprints (
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
  )`,
  // 初查按「同库 + 字节数」；内容相似按「同库 + 媒体类型」把整库的帧哈希拉出来在内存里比。
  `CREATE INDEX IF NOT EXISTS upload_fingerprints_size_idx ON upload_fingerprints (library, file_size)`,
  `CREATE INDEX IF NOT EXISTS upload_fingerprints_kind_idx ON upload_fingerprints (library, media_kind) WHERE frame_hashes IS NOT NULL`,
  `ALTER TABLE upload_fingerprints ENABLE ROW LEVEL SECURITY`,
  // 运行时只走服务端 BYPASSRLS 连接；开启 RLS 且不建策略，等于关掉
  // anon/authenticated 的 PostgREST 通道。与 db/agent-token-schema.ts 末尾的守卫一致。
  `DO $upload_dedup_schema_revoke_public_roles$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${UPLOAD_DEDUP_SCHEMA_TABLES.join(", ")} FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${UPLOAD_DEDUP_SCHEMA_TABLES.join(", ")} FROM authenticated';
    END IF;
  END
  $upload_dedup_schema_revoke_public_roles$`,
] as const;
