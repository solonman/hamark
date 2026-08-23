/**
 * 只读审计：V1.9（AD_VIDEO_WORKFLOW_V1）保存链路的数据不变量。
 *
 * 保存链路的正确性最终落在这些库内事实上；任何一条被破坏，都意味着保存、
 * 恢复或提交在某处撒了谎。脚本全程 READ ONLY，只打印聚合结果与主键，
 * 不打印任何草稿正文。所有不变量通过时退出码为 0，否则为 1，可直接接入
 * 定时巡检。
 *
 *   npm run audit:v19-save
 */
import pg from "pg";
import { assertV04PayloadContract, hashV04Payload } from "../lib/v04-domain";
import type { V04DraftPayloadV1 } from "../lib/v04-contract";

const WORKFLOW = "AD_VIDEO_WORKFLOW_V1";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL");
console.log("数据库主机：", new URL(connectionString).host);

const pool = new pg.Pool({
  connectionString,
  ssl: process.env.SUPABASE_DB_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 1,
});
const client = await pool.connect();
await client.query("BEGIN READ ONLY");

let failures = 0;

async function invariant(label: string, sql: string, params: unknown[] = []) {
  const result = await client.query(sql, params);
  if (result.rowCount === 0) {
    console.log(`✔ ${label}`);
  } else {
    failures += 1;
    console.log(`✘ ${label}（${result.rowCount} 处违反）`);
    console.table(result.rows);
  }
  return result.rows as Record<string, unknown>[];
}

try {
  await invariant("指针一致：工作稿指针与其当前快照的修订、哈希一致（空稿仅允许 revision 0）", `
    SELECT w.video_id, a.revision AS pointer_rev, s.revision AS snapshot_rev,
      left(a.content_hash, 8) AS pointer_hash, left(s.content_hash, 8) AS snapshot_hash
    FROM collaboration_workspaces w
    INNER JOIN annotations a ON a.id = w.canonical_annotation_id
    LEFT JOIN annotation_snapshots s ON s.id = w.current_working_snapshot_id
    WHERE w.workflow_version = $1 AND (
      (s.id IS NULL AND a.revision > 0)
      OR (s.id IS NOT NULL AND (s.revision <> a.revision OR s.content_hash <> a.content_hash))
    )`, [WORKFLOW]);

  await invariant("指针不落后：指针修订等于该血统 WORKING 快照的最大修订", `
    SELECT w.video_id, a.revision AS pointer_rev, m.max_rev
    FROM collaboration_workspaces w
    INNER JOIN annotations a ON a.id = w.canonical_annotation_id
    INNER JOIN (
      SELECT annotation_id, MAX(revision) AS max_rev
      FROM annotation_snapshots
      WHERE snapshot_kind = 'WORKING' AND workflow_version = $1
      GROUP BY annotation_id
    ) m ON m.annotation_id = a.id
    WHERE m.max_rev <> a.revision`, [WORKFLOW]);

  await invariant("修订连续：每条血统的 WORKING 修订从 1 起且无空洞、无重复", `
    SELECT s.annotation_id, COUNT(*) AS cnt, MIN(s.revision) AS min_rev, MAX(s.revision) AS max_rev
    FROM annotation_snapshots s
    WHERE s.snapshot_kind = 'WORKING' AND s.workflow_version = $1
    GROUP BY s.annotation_id
    HAVING COUNT(*) <> MAX(s.revision) OR MIN(s.revision) <> 1`, [WORKFLOW]);

  await invariant("事件覆盖：每个 WORKING 修订都有对应的修订事件（保存或历史恢复）", `
    SELECT s.video_id, s.revision
    FROM annotation_snapshots s
    INNER JOIN collaboration_workspaces w
      ON w.canonical_annotation_id = s.annotation_id AND w.workflow_version = $1
    WHERE s.snapshot_kind = 'WORKING' AND s.workflow_version = $1
      AND NOT EXISTS (
        SELECT 1 FROM collaboration_revision_events e
        WHERE e.annotation_id = s.annotation_id AND e.applied_revision = s.revision
      )`, [WORKFLOW]);

  await invariant("归属一致：快照的 video_id 与其工作稿的 video_id 一致", `
    SELECT s.id, s.video_id AS snapshot_video, w.video_id AS workspace_video
    FROM annotation_snapshots s
    INNER JOIN collaboration_workspaces w
      ON w.canonical_annotation_id = s.annotation_id AND w.workflow_version = $1
    WHERE s.snapshot_kind = 'WORKING' AND s.video_id <> w.video_id`, [WORKFLOW]);

  await invariant("单一编辑权：每个工作稿至多一个 ACTIVE 租约", `
    SELECT workspace_id, COUNT(*) AS active_leases
    FROM collaboration_edit_leases
    WHERE status = 'ACTIVE'
    GROUP BY workspace_id HAVING COUNT(*) > 1`);

  await invariant("提交指针：latest_submission_snapshot_id 指向编号最大的提交", `
    SELECT w.video_id, w.latest_submission_snapshot_id, x.id AS actual_latest
    FROM collaboration_workspaces w
    INNER JOIN LATERAL (
      SELECT id FROM annotation_submission_snapshots
      WHERE workspace_id = w.id ORDER BY submission_number DESC LIMIT 1
    ) x ON TRUE
    WHERE w.workflow_version = $1
      AND w.latest_submission_snapshot_id IS DISTINCT FROM x.id`, [WORKFLOW]);

  // 内容级复核：当前指针快照的 payload 必须可解析、符合冻结契约，
  // 且重算哈希与存储哈希一致。内容只在内存中校验，不输出。
  const heads = await client.query(`
    SELECT w.video_id, s.id, s.payload_json, s.content_hash
    FROM collaboration_workspaces w
    INNER JOIN annotation_snapshots s ON s.id = w.current_working_snapshot_id
    WHERE w.workflow_version = $1`, [WORKFLOW]);
  const badHeads: Array<{ video_id: string; problem: string }> = [];
  for (const row of heads.rows as Array<{ video_id: string; payload_json: unknown; content_hash: string }>) {
    try {
      const payload = (typeof row.payload_json === "string"
        ? JSON.parse(row.payload_json)
        : row.payload_json) as V04DraftPayloadV1;
      assertV04PayloadContract(payload);
      if (hashV04Payload(payload) !== row.content_hash) {
        badHeads.push({ video_id: row.video_id, problem: "重算哈希与存储哈希不一致" });
      }
    } catch (error) {
      badHeads.push({
        video_id: row.video_id,
        problem: error instanceof Error ? error.message : "payload 解析失败",
      });
    }
  }
  if (badHeads.length === 0) {
    console.log(`✔ 内容复核：${heads.rowCount} 个当前工作稿快照全部契约合法、哈希一致`);
  } else {
    failures += 1;
    console.log(`✘ 内容复核（${badHeads.length} 处违反）`);
    console.table(badHeads);
  }
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}

if (failures > 0) {
  console.log(`\n结论：${failures} 项不变量被破坏，保存链路存在数据级异常。`);
  process.exit(1);
}
console.log("\n结论：全部不变量成立，V1.9 保存链路的数据是自洽的。");
