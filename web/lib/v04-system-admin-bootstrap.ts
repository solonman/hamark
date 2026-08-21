import type { DbClient, QueryResultRow } from "@/db";
import type { V04Actor } from "./v04-workspace-service";
import { V04ServiceError } from "./v04-errors";
import { digestV04PreviewToken, previewV04Migration } from "./v04-migration-preview";
import {
  V04_SCHEMA_BUNDLE_HASH,
  V04_SCHEMA_VERSION,
  hashV04SchemaValue,
  v04TargetCodeSha,
} from "./v04-schema-catalog";
import {
  V04_SYSTEM_ADMIN_BOOTSTRAP_CONFIRMATION,
  type V04SystemAdminBootstrapInput,
} from "./v04-schema-admin-contract";

export { V04_SYSTEM_ADMIN_BOOTSTRAP_CONFIRMATION } from "./v04-schema-admin-contract";
export const V04_SYSTEM_ADMIN_BOOTSTRAP_LOCK_KEY =
  "HAMARK:V04:SYSTEM_ADMIN_BOOTSTRAP:V1";

type CandidateRow = QueryResultRow & {
  actor_active: boolean;
  legacy_admin: boolean;
  active_name_count: number | string;
  unique_active_user_id: string | null;
  active_system_admin_count: number | string;
  actor_membership_count: number | string;
};

export type V04SystemAdminBootstrapCandidate = {
  eligible: boolean;
  classification:
    | "UNIQUE"
    | "DISABLED"
    | "MISSING"
    | "AMBIGUOUS"
    | "SYSTEM_ADMIN_EXISTS"
    | "ACTOR_MEMBERSHIP_EXISTS"
    | "SCHEMA_UNAVAILABLE";
  activeSystemAdminCount: number;
};

export type { V04SystemAdminBootstrapInput } from "./v04-schema-admin-contract";

export type V04SystemAdminBootstrapResult = {
  operationId: string;
  status: "APPLIED";
  alreadyApplied: boolean;
  actorUserId: string;
  targetCodeSha: string;
  bundleHash: string;
  schemaState: "TARGET_APPLIED_EXACT";
  schemaFingerprint: string;
  sourceHash: string;
  targetHash: string;
  nonTargetHash: string;
  previewTokenDigest: string;
};

function numeric(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

function requireText(value: string, label: string, min: number, max: number) {
  const normalized = value?.trim() ?? "";
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001f]/.test(normalized)) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", `${label}格式不正确。`);
  }
  return normalized;
}

export async function inspectV04SystemAdminBootstrapCandidate(
  db: DbClient,
  actor: Pick<V04Actor, "userId" | "displayName">,
): Promise<V04SystemAdminBootstrapCandidate> {
  const capabilities = await db.prepare(`SELECT
    to_regclass(current_schema() || '.users') IS NOT NULL AS users_available,
    to_regclass(current_schema() || '.app_admins') IS NOT NULL AS legacy_admins_available,
    to_regclass(current_schema() || '.app_role_memberships') IS NOT NULL AS memberships_available,
    to_regclass(current_schema() || '.schema_migration_operations') IS NOT NULL AS ledger_available,
    to_regclass(current_schema() || '.workflow_contract_versions') IS NOT NULL AS workflow_available`)
    .first<QueryResultRow & {
      users_available: boolean;
      legacy_admins_available: boolean;
      memberships_available: boolean;
      ledger_available: boolean;
      workflow_available: boolean;
    }>();
  if (!capabilities?.users_available || !capabilities.legacy_admins_available
    || !capabilities.memberships_available || !capabilities.ledger_available
    || !capabilities.workflow_available) {
    return { eligible: false, classification: "SCHEMA_UNAVAILABLE", activeSystemAdminCount: 0 };
  }
  const displayName = actor.displayName?.trim() ?? "";
  if (!displayName) {
    return { eligible: false, classification: "MISSING", activeSystemAdminCount: 0 };
  }
  const row = await db.prepare(`SELECT
    EXISTS (SELECT 1 FROM users WHERE id=? AND status='ACTIVE' AND display_name=?) AS actor_active,
    EXISTS (SELECT 1 FROM app_admins WHERE display_name=?) AS legacy_admin,
    (SELECT COUNT(*)::bigint FROM users WHERE status='ACTIVE' AND display_name=?) AS active_name_count,
    (SELECT MIN(id) FROM users WHERE status='ACTIVE' AND display_name=?) AS unique_active_user_id,
    (SELECT COUNT(*)::bigint FROM app_role_memberships
      WHERE role_key='SYSTEM_ADMIN' AND status='ACTIVE') AS active_system_admin_count,
    (SELECT COUNT(*)::bigint FROM app_role_memberships
      WHERE user_id=? AND role_key='SYSTEM_ADMIN') AS actor_membership_count`)
    .bind(actor.userId, displayName, displayName, displayName, displayName, actor.userId)
    .first<CandidateRow>();
  const activeSystemAdminCount = numeric(row?.active_system_admin_count);
  const classification = !row?.actor_active
    ? "DISABLED"
    : !row.legacy_admin
      ? "MISSING"
      : numeric(row.active_name_count) !== 1 || row.unique_active_user_id !== actor.userId
        ? "AMBIGUOUS"
        : activeSystemAdminCount !== 0
          ? "SYSTEM_ADMIN_EXISTS"
          : numeric(row.actor_membership_count) !== 0
            ? "ACTOR_MEMBERSHIP_EXISTS"
            : "UNIQUE";
  return { eligible: classification === "UNIQUE", classification, activeSystemAdminCount };
}

function resultFromEvidence(row: QueryResultRow & {
  id: string;
  actor_user_id: string;
  contract_codes_json: V04SystemAdminBootstrapResult;
}) {
  return { ...row.contract_codes_json, operationId: row.id, actorUserId: row.actor_user_id, alreadyApplied: true };
}

export async function bootstrapV04SystemAdmin(
  db: DbClient,
  actor: V04Actor,
  input: V04SystemAdminBootstrapInput,
  options: { targetCodeSha?: string; now?: Date } = {},
): Promise<V04SystemAdminBootstrapResult> {
  const targetCodeSha = v04TargetCodeSha(options.targetCodeSha);
  const now = options.now ?? new Date();
  const idempotencyKey = requireText(input.idempotencyKey, "幂等键", 16, 128);
  const approvalReference = requireText(input.approvalReference, "审批引用", 8, 512);
  if (input.action !== "BOOTSTRAP_SYSTEM_ADMIN"
    || input.confirmation !== V04_SYSTEM_ADMIN_BOOTSTRAP_CONFIRMATION
    || requireText(input.targetCodeSha, "目标代码 SHA", 7, 64) !== targetCodeSha) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "SYSTEM_ADMIN bootstrap 请求不正确。");
  }

  return db.withTransaction(async (tx) => {
    await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?,0))")
      .bind(V04_SYSTEM_ADMIN_BOOTSTRAP_LOCK_KEY).run();
    const existing = await tx.prepare(`SELECT id,actor_user_id,contract_codes_json
      FROM schema_migration_operations WHERE idempotency_key=?`)
      .bind(idempotencyKey).first<QueryResultRow & {
        id: string;
        actor_user_id: string;
        contract_codes_json: V04SystemAdminBootstrapResult;
      }>();
    if (existing) {
      if (existing.actor_user_id !== actor.userId
        || existing.contract_codes_json?.targetCodeSha !== targetCodeSha) {
        throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "幂等键已绑定其他操作。", {});
      }
      return resultFromEvidence(existing);
    }

    const candidate = await inspectV04SystemAdminBootstrapCandidate(tx, actor);
    if (!candidate.eligible) {
      throw new V04ServiceError("ADMIN_REQUIRED", "当前身份不满足唯一 SYSTEM_ADMIN 自锁恢复条件。", {
        classification: candidate.classification,
      });
    }

    await tx.prepare(`INSERT INTO app_role_memberships (
      user_id,role_key,status,granted_by_user_id,granted_at
    ) VALUES (?,'SYSTEM_ADMIN','ACTIVE',?,?)`)
      .bind(actor.userId, actor.userId, now.toISOString()).run();

    const preview = await previewV04Migration(tx, actor, { now, targetCodeSha });
    if (!preview.ready || preview.schemaState !== "TARGET_APPLIED_EXACT"
      || preview.contract.status !== "DRAFT"
      || preview.stopReasons.length !== 0
      || preview.facts.P11.objectCounts["contract:actorSystemAdmin"] !== 1
      || !preview.zeroWrite.unchanged) {
      throw new V04ServiceError("TRANSACTION_ROLLED_BACK", "安装后 schema 不满足精确自锁恢复条件。", {
        schemaState: preview.schemaState,
        stopReasons: preview.stopReasons,
      });
    }

    const identityHash = hashV04SchemaValue({
      action: "SYSTEM_ADMIN_BOOTSTRAP",
      actorUserId: actor.userId,
      targetCodeSha,
      bundleHash: V04_SCHEMA_BUNDLE_HASH,
      idempotencyKey,
    });
    const operationId = `schema_bootstrap_${identityHash.slice(0, 32)}`;
    const result: V04SystemAdminBootstrapResult = {
      operationId,
      status: "APPLIED",
      alreadyApplied: false,
      actorUserId: actor.userId,
      targetCodeSha,
      bundleHash: V04_SCHEMA_BUNDLE_HASH,
      schemaState: "TARGET_APPLIED_EXACT",
      schemaFingerprint: preview.schemaFingerprint,
      sourceHash: preview.sourceHash,
      targetHash: preview.targetHash,
      nonTargetHash: preview.nonTargetHash,
      previewTokenDigest: digestV04PreviewToken(preview.previewToken),
    };
    await tx.prepare(`INSERT INTO schema_migration_operations (
      id,operation_key,operation_type,schema_version,contract_codes_json,status,
      preview_token,source_catalog_hash,target_catalog_hash,non_target_hash,
      actor_user_id,idempotency_key,approval_reference
    ) VALUES (?,?, 'SCHEMA_PREVIEW', ?, ?::jsonb, 'PREVIEWED', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(operationId, `V04_SYSTEM_ADMIN_BOOTSTRAP:${identityHash}`, V04_SCHEMA_VERSION,
        JSON.stringify(result), result.previewTokenDigest, preview.sourceHash,
        preview.schemaFingerprint, preview.nonTargetHash, actor.userId,
        idempotencyKey, JSON.stringify({ approvalReference, action: "SYSTEM_ADMIN_BOOTSTRAP" }))
      .run();
    return result;
  });
}
