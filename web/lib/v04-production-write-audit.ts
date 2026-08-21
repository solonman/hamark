import type { DbClient, QueryResultRow } from "@/db";
import { V04_WORKFLOW_VERSION } from "@/lib/v04-contract";
import { V04ServiceError } from "@/lib/v04-errors";

type CountRow = QueryResultRow & {
  count: number | string;
  first_at: string | null;
  last_at: string | null;
};

type StatusRow = QueryResultRow & {
  status: string;
  count: number | string;
};

type TargetRow = QueryResultRow & {
  target_key: string;
  count: number | string;
};

const count = (value: number | string | null | undefined) => Number(value ?? 0);

export function isV04ThirdModuleTargetKey(targetKey: string) {
  return targetKey === "path.primaryType"
    || targetKey === "path.primaryDetails"
    || targetKey === "path.auxiliaryTypes"
    || targetKey.startsWith("path.primaryDetails.")
    || targetKey.startsWith("path.auxiliary:");
}

export type V04ProductionWriteAudit = {
  generatedAt: string;
  workflowVersion: string;
  workspace: {
    count: number;
    statuses: Array<{ status: string; count: number }>;
    firstCreatedAt: string | null;
    lastUpdatedAt: string | null;
  };
  submission: {
    count: number;
    firstSubmittedAt: string | null;
    lastSubmittedAt: string | null;
    withThirdModuleStructureCount: number;
  };
  revision: {
    count: number;
    firstCreatedAt: string | null;
    lastCreatedAt: string | null;
    thirdModuleCount: number;
    affectedTargetKeys: Array<{ targetKey: string; count: number }>;
  };
  conclusion: "NO_PRODUCTION_V19_WRITES" | "WRITES_WITHOUT_THIRD_MODULE_TARGET" | "THIRD_MODULE_TARGETS_AFFECTED";
};

export async function getV04ProductionWriteAudit(
  db: DbClient,
  actorUserId: string,
): Promise<V04ProductionWriteAudit> {
  const admin = await db.prepare(`SELECT 1 FROM app_role_memberships
    WHERE user_id = ? AND role_key = 'SYSTEM_ADMIN' AND status = 'ACTIVE'`)
    .bind(actorUserId).first();
  if (!admin) throw new V04ServiceError("ADMIN_REQUIRED", "仅稳定系统管理员可查看该脱敏统计。");

  const workspace = await db.prepare(`SELECT COUNT(*) AS count,
      MIN(created_at)::text AS first_at, MAX(updated_at)::text AS last_at
    FROM collaboration_workspaces WHERE workflow_version = ?`)
    .bind(V04_WORKFLOW_VERSION).first<CountRow>();
  const statuses = (await db.prepare(`SELECT status, COUNT(*) AS count
    FROM collaboration_workspaces WHERE workflow_version = ?
    GROUP BY status ORDER BY status`)
    .bind(V04_WORKFLOW_VERSION).all<StatusRow>()).results;
  const submission = await db.prepare(`SELECT COUNT(*) AS count,
      MIN(s.submitted_at)::text AS first_at, MAX(s.submitted_at)::text AS last_at
    FROM annotation_submission_snapshots s
    INNER JOIN collaboration_workspaces w ON w.id = s.workspace_id
    WHERE w.workflow_version = ?`)
    .bind(V04_WORKFLOW_VERSION).first<CountRow>();
  const revisions = await db.prepare(`SELECT COUNT(*) AS count,
      MIN(e.created_at)::text AS first_at, MAX(e.created_at)::text AS last_at
    FROM collaboration_revision_events e
    INNER JOIN collaboration_workspaces w ON w.id = e.workspace_id
    WHERE w.workflow_version = ?`)
    .bind(V04_WORKFLOW_VERSION).first<CountRow>();
  const thirdModuleTargets = (await db.prepare(`SELECT e.target_key, COUNT(*) AS count
    FROM collaboration_revision_events e
    INNER JOIN collaboration_workspaces w ON w.id = e.workspace_id
    WHERE w.workflow_version = ? AND (
      e.target_key IN ('path.primaryType', 'path.primaryDetails', 'path.auxiliaryTypes')
      OR e.target_key LIKE 'path.primaryDetails.%'
      OR e.target_key LIKE 'path.auxiliary:%'
    ) GROUP BY e.target_key ORDER BY e.target_key`)
    .bind(V04_WORKFLOW_VERSION).all<TargetRow>()).results
    .filter((row) => isV04ThirdModuleTargetKey(row.target_key))
    .map((row) => ({ targetKey: row.target_key, count: count(row.count) }));

  const workspaceCount = count(workspace?.count);
  const submissionCount = count(submission?.count);
  const thirdModuleCount = thirdModuleTargets.reduce((total, item) => total + item.count, 0);

  return {
    generatedAt: new Date().toISOString(),
    workflowVersion: V04_WORKFLOW_VERSION,
    workspace: {
      count: workspaceCount,
      statuses: statuses.map((row) => ({ status: row.status, count: count(row.count) })),
      firstCreatedAt: workspace?.first_at ?? null,
      lastUpdatedAt: workspace?.last_at ?? null,
    },
    submission: {
      count: submissionCount,
      firstSubmittedAt: submission?.first_at ?? null,
      lastSubmittedAt: submission?.last_at ?? null,
      // Every immutable V0.4 submission has already passed the server contract,
      // which requires the third module. Report that fact without inspecting payload_json.
      withThirdModuleStructureCount: submissionCount,
    },
    revision: {
      count: count(revisions?.count),
      firstCreatedAt: revisions?.first_at ?? null,
      lastCreatedAt: revisions?.last_at ?? null,
      thirdModuleCount,
      affectedTargetKeys: thirdModuleTargets,
    },
    conclusion: workspaceCount === 0 && submissionCount === 0
      ? "NO_PRODUCTION_V19_WRITES"
      : thirdModuleCount > 0 || submissionCount > 0
        ? "THIRD_MODULE_TARGETS_AFFECTED"
        : "WRITES_WITHOUT_THIRD_MODULE_TARGET",
  };
}
