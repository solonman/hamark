import type { DbClient, QueryResultRow } from "@/db";
import {
  V04_PAYLOAD_SCHEMA_VERSION,
  V04_PRODUCT_VERSION,
  V04_TAXONOMY_VERSION,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
} from "./v04-contract";
import { V04ServiceError } from "./v04-errors";
import {
  digestV04PreviewToken,
  previewV04Migration,
  type V04MigrationPreview,
} from "./v04-migration-preview";
import {
  V04_SCHEMA_BUNDLE_HASH,
  V04_SCHEMA_VERSION,
  V04_WORKFLOW_CONTRACT_HASH,
  hashV04SchemaValue,
  v04TargetCodeSha,
} from "./v04-schema-catalog";
import {
  V04_CONTRACT_ACTIVATE_CONFIRMATION,
  V04_CONTRACT_RETIRE_CONFIRMATION,
  type V04ContractLifecycleInput,
} from "./v04-schema-admin-contract";
import { V04_VOCABULARY_APPROVED_HASHES } from "./v04-vocabulary";

export {
  V04_CONTRACT_ACTIVATE_CONFIRMATION,
  V04_CONTRACT_RETIRE_CONFIRMATION,
} from "./v04-schema-admin-contract";
export type { V04ContractLifecycleInput } from "./v04-schema-admin-contract";

export const V04_CONTRACT_LIFECYCLE_LOCK_KEY = "HAMARK:V04:CONTRACT_LIFECYCLE:V1";
export const V04_GATE_ONE_BASELINE = {
  verifiedCodeSha: "5fe4e03df46847b9033cb8721f18d233f0642c92",
  bundleHash: "d068f0e422a26162ed90a28c3b36a905e0b80d0ddd2a0c08711af0d62603155c",
  catalogHash: "b13f99779015239d09b8ceef8d7e081272e83d9ff163a590cbf0fd68ef043a64",
  sourceHash: "f2e8865cad80facb737a2b83cd132b1fc123540c37e5dac60475b86f798582fe",
  targetHash: "d20fe2f7c62411ccee4897fc501fc0e7f5b5b9aae380006f2d30a710b8bf8d29",
  nonTargetHash: "734b60057165b03129c405d309e8ac4cdb0f0bbdf4c2264f8a359b835f3f70e7",
  approvalReference: "AI视频创意逆向工程_V0.4_生产三门有条件提前授权记录_V1.0_20260820.md#门二",
} as const;
export type V04GateOneBaseline = {
  verifiedCodeSha: string;
  bundleHash: string;
  catalogHash: string;
  sourceHash: string;
  targetHash: string;
  nonTargetHash: string;
  approvalReference: string;
};

type ContractState = "DRAFT" | "ACTIVE" | "RETIRED";
type LifecycleAction = V04ContractLifecycleInput["action"];

type LedgerRow = QueryResultRow & {
  id: string;
  operation_key: string;
  actor_user_id: string;
  status: "PREVIEWED" | "APPLYING" | "APPLIED" | "FAILED";
  contract_codes_json: Record<string, unknown>;
  result_json: V04ContractLifecycleResult | null;
  error_json: { stage?: string; code?: string } | null;
};

type ContractRows = {
  taxonomy: QueryResultRow & { status: ContractState; workflow_version: string; label: string };
  vocabulary: QueryResultRow & { status: ContractState; taxonomy_version: string; content_hash: string };
  workflow: QueryResultRow & {
    status: ContractState;
    domain_key: string;
    product_version: string;
    taxonomy_version: string;
    vocabulary_version: string;
    payload_schema_version: string;
    contract_hash: string;
    activated_at: string | null;
  };
};

export type V04ContractLifecycleResult = {
  operationId: string;
  operationKey: string;
  action: LifecycleAction;
  status: "APPLIED" | "FAILED";
  alreadyApplied: boolean;
  actorUserId: string;
  targetCodeSha: string;
  bundleHash: string;
  fromStatus: ContractState;
  toStatus: ContractState;
  previewTokenDigest: string;
  sourceHash: string;
  targetHash: string;
  nonTargetHash: string;
  contractEvidenceHash: string;
  completedAt?: string;
  failure?: { stage: string; code: string };
};

type LifecycleOptions = {
  now?: Date;
  environmentKey?: string;
  targetCodeSha?: string;
  gateOneBaseline?: V04GateOneBaseline;
  failAt?: "AFTER_LEDGER" | "AFTER_FIRST_CONTRACT" | "AFTER_ALL_CONTRACTS" | "AFTER_POSTCHECK";
};

function requireText(value: string, label: string, min: number, max: number) {
  const normalized = value?.trim() ?? "";
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001f]/.test(normalized)) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", `${label}格式不正确。`);
  }
  return normalized;
}

function validateInput(
  input: V04ContractLifecycleInput,
  expectedCodeSha: string,
  gateOneBaseline: V04GateOneBaseline,
) {
  const action = input.action;
  const expectedConfirmation = action === "ACTIVATE_CONTRACTS"
    ? V04_CONTRACT_ACTIVATE_CONFIRMATION
    : V04_CONTRACT_RETIRE_CONFIRMATION;
  if (!['ACTIVATE_CONTRACTS', 'RETIRE_CONTRACTS'].includes(action)
    || input.confirmation !== expectedConfirmation) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "合同生命周期确认语句不正确。");
  }
  const targetCodeSha = requireText(input.targetCodeSha, "目标代码 SHA", 7, 64);
  if (targetCodeSha !== expectedCodeSha) {
    throw new V04ServiceError("STALE_PREVIEW", "目标代码版本已经变化。", {
      reason: "TARGET_CODE_SHA_CHANGED",
    });
  }
  const gateOneEvidenceReference = requireText(input.gateOneEvidenceReference, "门一证据引用", 12, 512);
  if (!gateOneEvidenceReference.includes(gateOneBaseline.verifiedCodeSha.slice(0, 12))) {
    throw new V04ServiceError("STALE_PREVIEW", "门一证据没有绑定已验收基线。", {
      reason: "GATE_ONE_EVIDENCE_MISMATCH",
    });
  }
  return {
    action,
    targetCodeSha,
    idempotencyKey: requireText(input.idempotencyKey, "幂等键", 16, 128),
    approvalReference: requireText(input.approvalReference, "批准引用", 12, 512),
    gateOneEvidenceReference,
  };
}

function statesFor(action: LifecycleAction): { from: ContractState; to: ContractState } {
  return action === "ACTIVATE_CONTRACTS"
    ? { from: "DRAFT", to: "ACTIVE" }
    : { from: "ACTIVE", to: "RETIRED" };
}

function safePreview(preview: V04MigrationPreview) {
  return {
    ready: preview.ready,
    schemaState: preview.schemaState,
    stopReasons: preview.stopReasons,
    contract: preview.contract,
    schemaFingerprint: preview.schemaFingerprint,
    sourceHash: preview.sourceHash,
    targetHash: preview.targetHash,
    nonTargetHash: preview.nonTargetHash,
    previewTokenDigest: preview.previewTokenDigest,
    facts: preview.facts,
  };
}

function gateOneMatches(preview: V04MigrationPreview, baseline: V04GateOneBaseline) {
  return preview.bundleHash === baseline.bundleHash
    && preview.schemaFingerprint === baseline.catalogHash
    && preview.sourceHash === baseline.sourceHash
    && preview.targetHash === baseline.targetHash
    && preview.nonTargetHash === baseline.nonTargetHash;
}

function gateOneMismatchKeys(preview: V04MigrationPreview, baseline: V04GateOneBaseline) {
  return [
    ["bundleHash", preview.bundleHash, baseline.bundleHash],
    ["catalogHash", preview.schemaFingerprint, baseline.catalogHash],
    ["sourceHash", preview.sourceHash, baseline.sourceHash],
    ["targetHash", preview.targetHash, baseline.targetHash],
    ["nonTargetHash", preview.nonTargetHash, baseline.nonTargetHash],
  ].filter(([, current, expected]) => current !== expected).map(([key]) => key);
}

function assertExactPreflight(
  preview: V04MigrationPreview,
  expectedStatus: ContractState,
  gateOneBaseline: V04GateOneBaseline,
) {
  const counts = preview.facts.P11.objectCounts;
  const suffix = `${expectedStatus[0]}${expectedStatus.slice(1).toLowerCase()}`;
  const expectedCounts = [
    counts[`contract:taxonomy${suffix}`],
    counts[`contract:vocabulary${suffix}`],
    counts[`contract:workflow${suffix}`],
  ];
  if (!preview.ready || preview.schemaState !== "TARGET_APPLIED_EXACT"
    || preview.contract.status !== expectedStatus
    || preview.contract.expectedStatus !== expectedStatus
    || preview.facts.P07.drift.length !== 0
    || preview.facts.P07.rlsDisabledTables.length !== 0
    || preview.facts.P11.objectCounts["contract:vocabularyOptions"] !== 60
    || preview.facts.P11.objectCounts["contract:actorSystemAdmin"] !== 1
    || expectedCounts.some((count) => count !== 1)
    || !preview.zeroWrite.unchanged
    || !gateOneMatches(preview, gateOneBaseline)) {
    throw new V04ServiceError("STALE_PREVIEW", "合同生命周期前置事实与门一基线不一致。", {
      schemaState: preview.schemaState,
      contractStatus: preview.contract.status,
      stopReasons: preview.stopReasons,
      gateOneMismatchKeys: gateOneMismatchKeys(preview, gateOneBaseline),
    });
  }
}

async function lockAndReadContracts(db: DbClient): Promise<ContractRows> {
  const taxonomy = await db.prepare(`SELECT status,workflow_version,label
    FROM annotation_taxonomy_versions WHERE taxonomy_version=? FOR UPDATE`)
    .bind(V04_TAXONOMY_VERSION).first<ContractRows["taxonomy"]>();
  const vocabulary = await db.prepare(`SELECT status,taxonomy_version,content_hash
    FROM annotation_vocabulary_versions WHERE vocabulary_version=? FOR UPDATE`)
    .bind(V04_VOCABULARY_VERSION).first<ContractRows["vocabulary"]>();
  const workflow = await db.prepare(`SELECT status,domain_key,product_version,taxonomy_version,
      vocabulary_version,payload_schema_version,contract_hash,activated_at
    FROM workflow_contract_versions WHERE workflow_version=? FOR UPDATE`)
    .bind(V04_WORKFLOW_VERSION).first<ContractRows["workflow"]>();
  if (!taxonomy || !vocabulary || !workflow
    || taxonomy.workflow_version !== V04_WORKFLOW_VERSION
    || vocabulary.taxonomy_version !== V04_TAXONOMY_VERSION
    || vocabulary.content_hash !== V04_VOCABULARY_APPROVED_HASHES.combined
    || workflow.domain_key !== "AD_VIDEO"
    || workflow.product_version !== V04_PRODUCT_VERSION
    || workflow.taxonomy_version !== V04_TAXONOMY_VERSION
    || workflow.vocabulary_version !== V04_VOCABULARY_VERSION
    || workflow.payload_schema_version !== V04_PAYLOAD_SCHEMA_VERSION
    || workflow.contract_hash !== V04_WORKFLOW_CONTRACT_HASH) {
    throw new V04ServiceError("STALE_PREVIEW", "冻结合同内容或身份发生变化。", {
      reason: "CONTRACT_IDENTITY_OR_HASH_DRIFT",
    });
  }
  return { taxonomy, vocabulary, workflow };
}

function contractEvidenceHash(rows: ContractRows) {
  return hashV04SchemaValue({
    taxonomy: rows.taxonomy,
    vocabulary: rows.vocabulary,
    workflow: rows.workflow,
  });
}

function operationIdentity(input: {
  action: LifecycleAction;
  actorUserId: string;
  targetCodeSha: string;
  idempotencyKey: string;
}) {
  const digest = hashV04SchemaValue({
    schemaVersion: V04_SCHEMA_VERSION,
    bundleHash: V04_SCHEMA_BUNDLE_HASH,
    ...input,
  });
  return {
    operationId: `contract_operation_${digest.slice(0, 32)}`,
    operationKey: `V04_CONTRACT_${input.action}:${digest.slice(0, 32)}`,
  };
}

function resultFromRow(row: LedgerRow): V04ContractLifecycleResult {
  if (row.result_json) return { ...row.result_json, alreadyApplied: true };
  const action = row.contract_codes_json.action as LifecycleAction;
  const states = statesFor(action);
  return {
    operationId: row.id,
    operationKey: row.operation_key,
    action,
    status: "FAILED",
    alreadyApplied: true,
    actorUserId: row.actor_user_id,
    targetCodeSha: String(row.contract_codes_json.targetCodeSha ?? "UNKNOWN"),
    bundleHash: V04_SCHEMA_BUNDLE_HASH,
    fromStatus: states.from,
    toStatus: states.to,
    previewTokenDigest: "REDACTED",
    sourceHash: "REDACTED",
    targetHash: "REDACTED",
    nonTargetHash: "REDACTED",
    contractEvidenceHash: "REDACTED",
    failure: {
      stage: row.error_json?.stage ?? "UNKNOWN",
      code: row.error_json?.code ?? "CONTRACT_LIFECYCLE_FAILED",
    },
  };
}

async function existingByIdempotency(db: DbClient, key: string) {
  return db.prepare(`SELECT id,operation_key,actor_user_id,status,contract_codes_json,
      result_json,error_json FROM schema_migration_operations WHERE idempotency_key=?`)
    .bind(key).first<LedgerRow>();
}

function sanitizedFailure(stage: string, error: unknown) {
  return {
    stage,
    code: error instanceof V04ServiceError ? error.code : "CONTRACT_LIFECYCLE_FAILED",
  };
}

export async function executeV04ContractLifecycle(
  db: DbClient,
  actor: { userId: string; displayName?: string },
  input: V04ContractLifecycleInput,
  options: LifecycleOptions = {},
): Promise<V04ContractLifecycleResult> {
  const now = options.now ?? new Date();
  const targetCodeSha = v04TargetCodeSha(options.targetCodeSha);
  const gateOneBaseline = options.gateOneBaseline ?? V04_GATE_ONE_BASELINE;
  const validated = validateInput(input, targetCodeSha, gateOneBaseline);
  const states = statesFor(validated.action);

  return db.withTransaction(async (tx) => {
    await tx.prepare("SET TRANSACTION ISOLATION LEVEL READ COMMITTED").run();
    await tx.prepare("SET LOCAL lock_timeout = '5s'").run();
    await tx.prepare("SET LOCAL statement_timeout = '55s'").run();
    await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?,0))")
      .bind(V04_CONTRACT_LIFECYCLE_LOCK_KEY).run();

    const existing = await existingByIdempotency(tx, validated.idempotencyKey);
    if (existing) {
      if (existing.actor_user_id !== actor.userId
        || existing.contract_codes_json.action !== validated.action
        || existing.contract_codes_json.targetCodeSha !== targetCodeSha) {
        throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "幂等键已经绑定另一项合同操作。", {
          operationId: existing.id,
        });
      }
      if (["APPLIED", "FAILED"].includes(existing.status)) return resultFromRow(existing);
      throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "相同合同操作仍在执行。", {
        operationId: existing.id,
      });
    }

    const beforePreview = await previewV04Migration(tx, actor, {
      now,
      environmentKey: options.environmentKey,
      targetCodeSha,
      expectedContractStatus: states.from,
    });
    assertExactPreflight(beforePreview, states.from, gateOneBaseline);
    const rows = await lockAndReadContracts(tx);
    if ([rows.taxonomy.status, rows.vocabulary.status, rows.workflow.status]
      .some((status) => status !== states.from)) {
      throw new V04ServiceError("STALE_PREVIEW", "三份合同不处于同一预期状态。", {
        expectedStatus: states.from,
      });
    }
    const beforeContractEvidenceHash = contractEvidenceHash(rows);
    const identity = operationIdentity({
      action: validated.action,
      actorUserId: actor.userId,
      targetCodeSha,
      idempotencyKey: validated.idempotencyKey,
    });
    const previewTokenDigest = digestV04PreviewToken(beforePreview.previewToken);
    const contractCodes = {
      action: validated.action,
      targetCodeSha,
      gateOneVerifiedCodeSha: gateOneBaseline.verifiedCodeSha,
      bundleHash: V04_SCHEMA_BUNDLE_HASH,
      workflowContractHash: V04_WORKFLOW_CONTRACT_HASH,
      vocabularyHash: V04_VOCABULARY_APPROVED_HASHES.combined,
      taxonomyVersion: V04_TAXONOMY_VERSION,
      vocabularyVersion: V04_VOCABULARY_VERSION,
      workflowVersion: V04_WORKFLOW_VERSION,
      fromStatus: states.from,
      toStatus: states.to,
      beforeContractEvidenceHash,
    };
    await tx.prepare(`INSERT INTO schema_migration_operations (
      id,operation_key,operation_type,schema_version,contract_codes_json,status,
      preview_token,source_catalog_hash,target_catalog_hash,non_target_hash,
      actor_user_id,idempotency_key,approval_reference
    ) VALUES (?,?, 'CONTRACT_ACTIVATE', ?, ?::jsonb, 'PREVIEWED', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(identity.operationId, identity.operationKey, V04_SCHEMA_VERSION,
        JSON.stringify(contractCodes), previewTokenDigest, beforePreview.sourceHash,
        beforePreview.targetHash, beforePreview.nonTargetHash, actor.userId,
        validated.idempotencyKey, JSON.stringify({
          approvalReference: validated.approvalReference,
          gateOneEvidenceReference: validated.gateOneEvidenceReference,
          frozenApprovalReference: gateOneBaseline.approvalReference,
        })).run();
    await tx.prepare(`UPDATE schema_migration_operations SET status='APPLYING',started_at=?
      WHERE id=? AND status='PREVIEWED'`).bind(now.toISOString(), identity.operationId).run();

    let stage = "AFTER_LEDGER";
    await tx.prepare("SAVEPOINT v04_contract_lifecycle_body").run();
    try {
      if (options.failAt === "AFTER_LEDGER") throw new Error("TEST_ONLY_FAILURE");
      stage = "TAXONOMY_STATUS";
      await tx.prepare(`UPDATE annotation_taxonomy_versions SET status=?
        WHERE taxonomy_version=? AND status=?`)
        .bind(states.to, V04_TAXONOMY_VERSION, states.from).run();
      if (options.failAt === "AFTER_FIRST_CONTRACT") throw new Error("TEST_ONLY_FAILURE");
      stage = "VOCABULARY_STATUS";
      await tx.prepare(`UPDATE annotation_vocabulary_versions SET status=?
        WHERE vocabulary_version=? AND status=?`)
        .bind(states.to, V04_VOCABULARY_VERSION, states.from).run();
      stage = "WORKFLOW_STATUS";
      if (validated.action === "ACTIVATE_CONTRACTS") {
        await tx.prepare(`UPDATE workflow_contract_versions SET status='ACTIVE',activated_at=?
          WHERE workflow_version=? AND status='DRAFT' AND activated_at IS NULL`)
          .bind(now.toISOString(), V04_WORKFLOW_VERSION).run();
      } else {
        await tx.prepare(`UPDATE workflow_contract_versions SET status='RETIRED'
          WHERE workflow_version=? AND status='ACTIVE'`)
          .bind(V04_WORKFLOW_VERSION).run();
      }
      if (options.failAt === "AFTER_ALL_CONTRACTS") throw new Error("TEST_ONLY_FAILURE");

      stage = "POSTCHECK";
      const afterRows = await lockAndReadContracts(tx);
      if ([afterRows.taxonomy.status, afterRows.vocabulary.status, afterRows.workflow.status]
        .some((status) => status !== states.to)
        || (states.to === "ACTIVE" && !afterRows.workflow.activated_at)) {
        throw new V04ServiceError("TRANSACTION_ROLLED_BACK", "三份合同没有原子进入目标状态。", { stage });
      }
      const afterPreview = await previewV04Migration(tx, actor, {
        now,
        environmentKey: options.environmentKey,
        targetCodeSha,
        expectedContractStatus: states.to,
      });
      if (options.failAt === "AFTER_POSTCHECK") throw new Error("TEST_ONLY_FAILURE");
      assertExactPreflight(afterPreview, states.to, gateOneBaseline);
      if (afterPreview.sourceHash !== beforePreview.sourceHash
        || afterPreview.targetHash !== beforePreview.targetHash
        || afterPreview.nonTargetHash !== beforePreview.nonTargetHash) {
        throw new V04ServiceError("TRANSACTION_ROLLED_BACK", "合同变更影响了业务语义指纹。", { stage });
      }
      await tx.prepare("RELEASE SAVEPOINT v04_contract_lifecycle_body").run();
      const result: V04ContractLifecycleResult = {
        operationId: identity.operationId,
        operationKey: identity.operationKey,
        action: validated.action,
        status: "APPLIED",
        alreadyApplied: false,
        actorUserId: actor.userId,
        targetCodeSha,
        bundleHash: V04_SCHEMA_BUNDLE_HASH,
        fromStatus: states.from,
        toStatus: states.to,
        previewTokenDigest,
        sourceHash: afterPreview.sourceHash,
        targetHash: afterPreview.targetHash,
        nonTargetHash: afterPreview.nonTargetHash,
        contractEvidenceHash: contractEvidenceHash(afterRows),
        completedAt: now.toISOString(),
      };
      await tx.prepare(`UPDATE schema_migration_operations SET status='APPLIED',
        result_json=?::jsonb,error_json=NULL,completed_at=? WHERE id=? AND status='APPLYING'`)
        .bind(JSON.stringify({ ...result, preflight: safePreview(beforePreview), postcheck: safePreview(afterPreview) }),
          now.toISOString(), identity.operationId).run();
      return result;
    } catch (error) {
      await tx.prepare("ROLLBACK TO SAVEPOINT v04_contract_lifecycle_body").run();
      const failure = sanitizedFailure(stage, error);
      await tx.prepare(`UPDATE schema_migration_operations SET status='FAILED',result_json=NULL,
        error_json=?::jsonb,completed_at=? WHERE id=? AND status='APPLYING'`)
        .bind(JSON.stringify(failure), now.toISOString(), identity.operationId).run();
      return {
        operationId: identity.operationId,
        operationKey: identity.operationKey,
        action: validated.action,
        status: "FAILED",
        alreadyApplied: false,
        actorUserId: actor.userId,
        targetCodeSha,
        bundleHash: V04_SCHEMA_BUNDLE_HASH,
        fromStatus: states.from,
        toStatus: states.to,
        previewTokenDigest,
        sourceHash: beforePreview.sourceHash,
        targetHash: beforePreview.targetHash,
        nonTargetHash: beforePreview.nonTargetHash,
        contractEvidenceHash: beforeContractEvidenceHash,
        failure,
      };
    }
  });
}
