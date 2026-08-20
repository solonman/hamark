import type { DbClient, QueryResultRow } from "@/db";
import { ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS } from "@/db/admin-data-operation-schema";
import {
  V04_SCHEMA_CONTROL_PLANE_STATEMENTS,
  V04_SCHEMA_STATEMENTS,
} from "@/db/v04-schema";
import { V04_WORKFLOW_SCHEMA_STATEMENTS } from "@/db/v04-workflow-schema";
import { V04ServiceError } from "./v04-errors";
import {
  assertV04PreviewToken,
  previewV04Migration,
  type V04MigrationPreview,
} from "./v04-migration-preview";
import {
  V04_SCHEMA_BUNDLE_HASH,
  V04_SCHEMA_VERSION,
  hashV04SchemaValue,
  v04TargetCodeSha,
} from "./v04-schema-catalog";
import {
  V04_SCHEMA_APPLY_CONFIRMATION,
  type V04SchemaApplyInput,
} from "./v04-schema-admin-contract";

export { V04_SCHEMA_APPLY_CONFIRMATION } from "./v04-schema-admin-contract";
export type { V04SchemaApplyInput } from "./v04-schema-admin-contract";

export const V04_SCHEMA_APPLY_LOCK_KEY = "HAMARK:V04:SCHEMA_APPLY:V1";
export const V04_SCHEMA_APPLY_STALE_MS = 5 * 60 * 1000;

export type V04SchemaApplyResult = {
  operationId: string;
  operationKey: string;
  status: "APPLIED" | "FAILED";
  alreadyApplied: boolean;
  schemaVersion: typeof V04_SCHEMA_VERSION;
  bundleHash: string;
  targetCodeSha: string;
  previewToken: string;
  postPreview?: V04MigrationPreview;
  failure?: { stage: string; code: string };
};

type OperationRow = QueryResultRow & {
  id: string;
  operation_key: string;
  status: "PREVIEWED" | "APPLYING" | "APPLIED" | "FAILED";
  preview_token: string;
  idempotency_key: string;
  result_json: V04SchemaApplyResult | null;
  error_json: { stage?: string; code?: string } | null;
  started_at: string | null;
};

type ApplyOptions = {
  now?: Date;
  environmentKey?: string;
  targetCodeSha?: string;
  failAt?: "AFTER_LEDGER" | "AFTER_SCHEMA" | "AFTER_MEMBERSHIP" | "AFTER_POSTCHECK";
};

function requireText(value: string, label: string, min: number, max: number) {
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001f]/.test(normalized)) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", `${label}格式不正确。`);
  }
  return normalized;
}

function validateApplyInput(input: V04SchemaApplyInput, now: Date, expectedCodeSha: string) {
  if (input.action !== "APPLY_SCHEMA" || input.confirmation !== V04_SCHEMA_APPLY_CONFIRMATION) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "schema APPLY 确认语句不正确。");
  }
  const previewToken = requireText(input.previewToken, "PREVIEW token", 32, 256);
  const idempotencyKey = requireText(input.idempotencyKey, "幂等键", 16, 128);
  const approvalReference = requireText(input.approvalReference, "审批引用", 8, 512);
  const backupReference = requireText(input.backupReference, "恢复点引用", 8, 512);
  const targetCodeSha = requireText(input.targetCodeSha, "目标代码 SHA", 7, 64);
  if (targetCodeSha !== expectedCodeSha) {
    throw new V04ServiceError("STALE_PREVIEW", "目标代码版本已经变化，请重新执行 PREVIEW。", {
      reason: "TARGET_CODE_SHA_CHANGED",
    });
  }
  const backupVerifiedAtMs = Date.parse(input.backupVerifiedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(backupVerifiedAtMs)
    || backupVerifiedAtMs > nowMs + 5 * 60 * 1000
    || nowMs - backupVerifiedAtMs > 24 * 60 * 60 * 1000) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "恢复点验证时间无效或已经过期。");
  }
  return {
    previewToken,
    idempotencyKey,
    approvalReference,
    backupReference,
    backupVerifiedAt: new Date(backupVerifiedAtMs).toISOString(),
    targetCodeSha,
  };
}

function operationIdentity(input: {
  idempotencyKey: string;
  targetCodeSha: string;
  actorUserId: string;
}) {
  const digest = hashV04SchemaValue({
    schemaVersion: V04_SCHEMA_VERSION,
    bundleHash: V04_SCHEMA_BUNDLE_HASH,
    targetCodeSha: input.targetCodeSha,
    actorUserId: input.actorUserId,
    idempotencyKey: input.idempotencyKey,
  });
  return {
    operationId: `schema_operation_${digest.slice(0, 32)}`,
    operationKey: `V04_SCHEMA_APPLY:${V04_SCHEMA_BUNDLE_HASH}:${digest.slice(0, 24)}`,
  };
}

async function executeStatements(db: DbClient, statements: readonly string[]) {
  for (const statement of statements) await db.prepare(statement).run();
}

function sanitizedFailure(stage: string, error: unknown) {
  return {
    stage,
    code: error instanceof V04ServiceError ? error.code : "SCHEMA_APPLY_FAILED",
  };
}

function resultFromRow(row: OperationRow): V04SchemaApplyResult {
  if (row.result_json) return { ...row.result_json, alreadyApplied: true };
  return {
    operationId: row.id,
    operationKey: row.operation_key,
    status: row.status === "APPLIED" ? "APPLIED" : "FAILED",
    alreadyApplied: true,
    schemaVersion: V04_SCHEMA_VERSION,
    bundleHash: V04_SCHEMA_BUNDLE_HASH,
    targetCodeSha: "UNKNOWN",
    previewToken: row.preview_token,
    failure: row.error_json?.stage
      ? { stage: row.error_json.stage, code: row.error_json.code ?? "SCHEMA_APPLY_FAILED" }
      : undefined,
  };
}

async function currentOperationByIdempotency(db: DbClient, idempotencyKey: string) {
  return db.prepare(`SELECT id,operation_key,status,preview_token,idempotency_key,
      result_json,error_json,started_at
    FROM schema_migration_operations WHERE idempotency_key=?`)
    .bind(idempotencyKey).first<OperationRow>();
}

async function alreadyAppliedOperation(db: DbClient) {
  return db.prepare(`SELECT id,operation_key,status,preview_token,idempotency_key,
      result_json,error_json,started_at
    FROM schema_migration_operations
    WHERE operation_type='SCHEMA_APPLY' AND schema_version=? AND status='APPLIED'
      AND contract_codes_json->>'bundleHash'=?
    ORDER BY completed_at DESC LIMIT 1`)
    .bind(V04_SCHEMA_VERSION, V04_SCHEMA_BUNDLE_HASH).first<OperationRow>();
}

async function failStaleApplyingIfSafe(
  db: DbClient,
  row: OperationRow,
  preview: V04MigrationPreview,
  now: Date,
  targetCodeSha: string,
): Promise<V04SchemaApplyResult> {
  if (row.status !== "APPLYING") {
    throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "schema 操作不在可补偿状态。", {
      operationId: row.id,
    });
  }
  const startedAtMs = Date.parse(row.started_at ?? "");
  if (!Number.isFinite(startedAtMs) || now.getTime() - startedAtMs < V04_SCHEMA_APPLY_STALE_MS) {
    throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "相同 schema 操作仍在执行。", {
      operationId: row.id,
    });
  }
  if (preview.schemaState !== "CONTROL_LEDGER_ONLY_EXACT") {
    throw new V04ServiceError("TRANSACTION_ROLLED_BACK", "超时操作的 catalog 状态不能安全补偿。", {
      stage: "STALE_APPLYING_RECONCILIATION",
    });
  }
  await db.prepare(`UPDATE schema_migration_operations SET status='FAILED',
      error_json=?::jsonb,completed_at=? WHERE id=? AND status='APPLYING'`)
    .bind(JSON.stringify({ stage: "STALE_APPLYING_RECONCILIATION", code: "STALE_APPLYING" }),
      now.toISOString(), row.id).run();
  return {
    operationId: row.id,
    operationKey: row.operation_key,
    status: "FAILED",
    alreadyApplied: false,
    schemaVersion: V04_SCHEMA_VERSION,
    bundleHash: V04_SCHEMA_BUNDLE_HASH,
    targetCodeSha,
    previewToken: row.preview_token,
    failure: { stage: "STALE_APPLYING_RECONCILIATION", code: "STALE_APPLYING" },
  };
}

export async function applyV04Schema(
  db: DbClient,
  actor: { userId: string; displayName?: string },
  input: V04SchemaApplyInput,
  options: ApplyOptions = {},
): Promise<V04SchemaApplyResult> {
  const now = options.now ?? new Date();
  const targetCodeSha = v04TargetCodeSha(options.targetCodeSha);
  const validated = validateApplyInput(input, now, targetCodeSha);

  return db.withTransaction(async (tx) => {
    // The transaction-wide advisory lock is the serialization boundary. READ COMMITTED
    // deliberately takes its catalog snapshot after a waiter acquires that lock, so a
    // concurrent retry observes the first install instead of a stale pre-DDL snapshot.
    await tx.prepare("SET TRANSACTION ISOLATION LEVEL READ COMMITTED").run();
    await tx.prepare("SET LOCAL lock_timeout = '5s'").run();
    await tx.prepare("SET LOCAL statement_timeout = '55s'").run();
    await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?,0))")
      .bind(V04_SCHEMA_APPLY_LOCK_KEY).run();

    let currentPreview = await previewV04Migration(tx, actor, {
      now,
      environmentKey: options.environmentKey,
      targetCodeSha,
    });
    if (currentPreview.schemaState !== "PRE_1A_EXACT") {
      const sameExisting = await currentOperationByIdempotency(tx, validated.idempotencyKey);
      if (sameExisting) {
        if (sameExisting.preview_token !== validated.previewToken) {
          throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "幂等键已绑定另一份 PREVIEW 事实。", {
            operationId: sameExisting.id,
          });
        }
        if (sameExisting.preview_token === validated.previewToken
          && ["APPLIED", "FAILED"].includes(sameExisting.status)) {
          return resultFromRow(sameExisting);
        }
        if (sameExisting.status === "APPLYING") {
          return failStaleApplyingIfSafe(tx, sameExisting, currentPreview, now, targetCodeSha);
        }
        throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "幂等键已绑定另一份 PREVIEW 事实。", {
          operationId: sameExisting.id,
        });
      }
      const existingApplied = await alreadyAppliedOperation(tx);
      if (existingApplied) return resultFromRow(existingApplied);
      if (currentPreview.schemaState === "TARGET_APPLIED_EXACT") {
        throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "目标 schema 已存在但没有可匹配的完成账本。", {
          stage: "TARGET_WITHOUT_LEDGER",
        });
      }
    }
    assertV04PreviewToken(currentPreview, validated.previewToken, now);
    if (!currentPreview.ready
      || !["PRE_1A_EXACT", "CONTROL_LEDGER_ONLY_EXACT", "TARGET_APPLIED_EXACT"].includes(currentPreview.schemaState)) {
      throw new V04ServiceError("STALE_PREVIEW", "当前事实不满足 schema APPLY 条件。", {
        schemaState: currentPreview.schemaState,
        stopReasons: currentPreview.stopReasons,
      });
    }

    if (currentPreview.schemaState === "PRE_1A_EXACT") {
      await executeStatements(tx, V04_SCHEMA_CONTROL_PLANE_STATEMENTS);
      currentPreview = await previewV04Migration(tx, actor, {
        now,
        environmentKey: options.environmentKey,
        targetCodeSha,
      });
      if (currentPreview.schemaState !== "CONTROL_LEDGER_ONLY_EXACT") {
        throw new V04ServiceError("TRANSACTION_ROLLED_BACK", "schema 控制平面未达到精确状态。", {
          stage: "CONTROL_PLANE_INSTALL",
        });
      }
    }

    const sameRequest = await currentOperationByIdempotency(tx, validated.idempotencyKey);
    if (sameRequest) throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "幂等键已经存在。", {
      operationId: sameRequest.id,
    });
    const applied = await alreadyAppliedOperation(tx);
    if (applied) return resultFromRow(applied);

    const identity = operationIdentity({
      idempotencyKey: validated.idempotencyKey,
      targetCodeSha,
      actorUserId: actor.userId,
    });
    const approvalReference = JSON.stringify({
      approvalReference: validated.approvalReference,
      backupReference: validated.backupReference,
      backupVerifiedAt: validated.backupVerifiedAt,
    });
    await tx.prepare(`INSERT INTO schema_migration_operations (
      id,operation_key,operation_type,schema_version,contract_codes_json,status,
      preview_token,source_catalog_hash,target_catalog_hash,non_target_hash,
      actor_user_id,idempotency_key,approval_reference
    ) VALUES (?,?, 'SCHEMA_APPLY', ?, ?::jsonb, 'PREVIEWED', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(identity.operationId, identity.operationKey, V04_SCHEMA_VERSION,
        JSON.stringify({ bundleHash: V04_SCHEMA_BUNDLE_HASH, targetCodeSha }),
        validated.previewToken, currentPreview.sourceHash, currentPreview.targetHash,
        currentPreview.nonTargetHash, actor.userId, validated.idempotencyKey,
        approvalReference).run();
    await tx.prepare(`UPDATE schema_migration_operations
      SET status='APPLYING',started_at=? WHERE id=? AND status='PREVIEWED'`)
      .bind(now.toISOString(), identity.operationId).run();

    let stage = "AFTER_LEDGER";
    await tx.prepare("SAVEPOINT v04_schema_apply_body").run();
    try {
      if (options.failAt === "AFTER_LEDGER") throw new Error("TEST_ONLY_FAILURE");
      stage = "SCHEMA_DDL";
      await executeStatements(tx, ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS);
      await executeStatements(tx, V04_SCHEMA_STATEMENTS);
      await executeStatements(tx, V04_WORKFLOW_SCHEMA_STATEMENTS);
      if (options.failAt === "AFTER_SCHEMA") throw new Error("TEST_ONLY_FAILURE");

      stage = "SYSTEM_ADMIN_BOOTSTRAP";
      await tx.prepare(`INSERT INTO app_role_memberships (
        user_id,role_key,status,granted_by_user_id
      ) VALUES (?,'SYSTEM_ADMIN','ACTIVE',?)
      ON CONFLICT (user_id,role_key) DO NOTHING`).bind(actor.userId, actor.userId).run();
      const activeAdminCount = await tx.prepare(`SELECT COUNT(*)::bigint AS count
        FROM app_role_memberships WHERE role_key='SYSTEM_ADMIN' AND status='ACTIVE'`)
        .first<{ count: number | string } & QueryResultRow>();
      const actorAdmin = await tx.prepare(`SELECT 1 FROM app_role_memberships
        WHERE user_id=? AND role_key='SYSTEM_ADMIN' AND status='ACTIVE'`)
        .bind(actor.userId).first();
      if (Number(activeAdminCount?.count ?? 0) !== 1 || !actorAdmin) {
        throw new V04ServiceError("ADMIN_REQUIRED", "SYSTEM_ADMIN 安全配置不是唯一稳定映射。", {
          stage,
        });
      }
      if (options.failAt === "AFTER_MEMBERSHIP") throw new Error("TEST_ONLY_FAILURE");

      stage = "POSTCHECK";
      const postPreview = await previewV04Migration(tx, actor, {
        now,
        environmentKey: options.environmentKey,
        targetCodeSha,
      });
      if (options.failAt === "AFTER_POSTCHECK") throw new Error("TEST_ONLY_FAILURE");
      if (!postPreview.ready || postPreview.schemaState !== "TARGET_APPLIED_EXACT"
        || postPreview.sourceHash !== currentPreview.sourceHash
        || postPreview.targetHash !== currentPreview.targetHash
        || postPreview.nonTargetHash !== currentPreview.nonTargetHash
        || !postPreview.zeroWrite.unchanged) {
        throw new V04ServiceError("TRANSACTION_ROLLED_BACK", "schema APPLY 写后不变量未通过。", {
          stage,
          schemaState: postPreview.schemaState,
          stopReasons: postPreview.stopReasons,
        });
      }
      await tx.prepare("RELEASE SAVEPOINT v04_schema_apply_body").run();
      const result: V04SchemaApplyResult = {
        operationId: identity.operationId,
        operationKey: identity.operationKey,
        status: "APPLIED",
        alreadyApplied: false,
        schemaVersion: V04_SCHEMA_VERSION,
        bundleHash: V04_SCHEMA_BUNDLE_HASH,
        targetCodeSha,
        previewToken: validated.previewToken,
        postPreview,
      };
      await tx.prepare(`UPDATE schema_migration_operations SET status='APPLIED',
        result_json=?::jsonb,error_json=NULL,completed_at=? WHERE id=? AND status='APPLYING'`)
        .bind(JSON.stringify(result), now.toISOString(), identity.operationId).run();
      return result;
    } catch (error) {
      await tx.prepare("ROLLBACK TO SAVEPOINT v04_schema_apply_body").run();
      const failure = sanitizedFailure(stage, error);
      await tx.prepare(`UPDATE schema_migration_operations SET status='FAILED',
        result_json=NULL,error_json=?::jsonb,completed_at=? WHERE id=? AND status='APPLYING'`)
        .bind(JSON.stringify(failure), now.toISOString(), identity.operationId).run();
      return {
        operationId: identity.operationId,
        operationKey: identity.operationKey,
        status: "FAILED",
        alreadyApplied: false,
        schemaVersion: V04_SCHEMA_VERSION,
        bundleHash: V04_SCHEMA_BUNDLE_HASH,
        targetCodeSha,
        previewToken: validated.previewToken,
        failure,
      };
    }
  });
}
