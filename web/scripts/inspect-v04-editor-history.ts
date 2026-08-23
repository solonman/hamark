/**
 * 只读诊断：某位同事的 V0.4 工作稿历史是否还在。
 *
 * 全程在 READ ONLY 事务里执行，只读取版本号、时间、作者、内容体积等元数据，
 * 不读取也不打印任何草稿正文。用法：
 *
 *   node --env-file=.env.local --import tsx scripts/inspect-v04-editor-history.ts 张学磊
 *   node --env-file=.env.local --import tsx scripts/inspect-v04-editor-history.ts --video video_xxx
 */
import pg from "pg";

const args = process.argv.slice(2);
const videoFlag = args.indexOf("--video");
const videoId = videoFlag >= 0 ? args[videoFlag + 1] : "";
const name = videoFlag >= 0 ? "" : args[0] ?? "";
if (!name && !videoId) {
  throw new Error("用法：inspect-v04-editor-history.ts <姓名> 或 --video <video_id>");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL");
console.log("数据库主机：", new URL(connectionString).host);

const pool = new pg.Pool({
  connectionString,
  ssl: process.env.SUPABASE_DB_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 1,
});
const client = await pool.connect();
// 只读事务：即使脚本被改错，也无法写入生产数据。
await client.query("BEGIN READ ONLY");

async function show(label: string, sql: string, params: unknown[] = []) {
  const result = await client.query(sql, params);
  console.log(`\n=== ${label}（${result.rowCount} 行）===`);
  if (result.rowCount) console.table(result.rows);
  return result.rows as Record<string, unknown>[];
}

try {
  const videoIds: string[] = [];
  if (videoId) {
    videoIds.push(videoId);
  } else {
    const users = await show("匹配到的账号", `
      SELECT id, display_name, status, last_login_at
      FROM users WHERE display_name LIKE $1`, [`%${name}%`]);
    const userIds = users.map((row) => String(row.id));

    await show("该同事上传的案例", `
      SELECT id, title, status, deleted_at, deletion_state, created_at
      FROM videos WHERE created_by_name LIKE $1
      ORDER BY created_at DESC LIMIT 30`, [`%${name}%`]);

    const cases = await show("该同事写过工作稿的案例", `
      SELECT s.video_id, v.title, v.deleted_at, v.deletion_state,
        COUNT(*) AS 他的修订数,
        MIN(s.revision) AS 最早修订, MAX(s.revision) AS 最新修订,
        MIN(s.created_at) AS 首次保存, MAX(s.created_at) AS 末次保存,
        MAX(length(s.payload_json)) AS 最大体积字节
      FROM annotation_snapshots s
      LEFT JOIN videos v ON v.id = s.video_id
      WHERE s.snapshot_kind = 'WORKING'
        AND (s.author_name LIKE $1 OR s.created_by_user_id = ANY($2::text[]))
      GROUP BY s.video_id, v.title, v.deleted_at, v.deletion_state
      ORDER BY MAX(s.created_at) DESC`, [`%${name}%`, userIds]);
    videoIds.push(...cases.map((row) => String(row.video_id)));
  }

  for (const id of videoIds) {
    await show(`案例 ${id} 的工作稿指针与提交`, `
      SELECT w.id AS workspace_id, a.revision AS 当前指针修订,
        left(a.content_hash, 8) AS 指针哈希,
        (SELECT COUNT(*) FROM annotation_submission_snapshots x WHERE x.workspace_id = w.id) AS 提交数,
        v.title, v.deleted_at, v.deletion_state
      FROM collaboration_workspaces w
      INNER JOIN annotations a ON a.id = w.canonical_annotation_id
      LEFT JOIN videos v ON v.id = w.video_id
      WHERE w.video_id = $1`, [id]);

    await show(`案例 ${id} 的全部工作稿修订（最近 80 条）`, `
      SELECT s.revision, s.author_name, s.created_at,
        length(s.payload_json) AS 体积字节, left(s.content_hash, 8) AS 哈希
      FROM annotation_snapshots s
      WHERE s.video_id = $1 AND s.snapshot_kind = 'WORKING'
      ORDER BY s.revision DESC LIMIT 80`, [id]);

    await show(`案例 ${id} 的历史恢复记录`, `
      SELECT e.applied_revision, e.source_object_type, e.source_object_id,
        e.actor_name_snapshot, e.created_at
      FROM collaboration_revision_events e
      INNER JOIN collaboration_workspaces w ON w.id = e.workspace_id
      WHERE w.video_id = $1 AND e.source_kind = 'HISTORY_RESTORE'
      ORDER BY e.created_at DESC LIMIT 20`, [id]);
  }
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}
