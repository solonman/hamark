import { createHash } from "node:crypto";
import { ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS } from "@/db/admin-data-operation-schema";
import { V04_SCHEMA_STATEMENTS } from "@/db/v04-schema";
import { V04_WORKFLOW_SCHEMA_STATEMENTS } from "@/db/v04-workflow-schema";
import {
  V04_PAYLOAD_SCHEMA_VERSION,
  V04_PRODUCT_VERSION,
  V04_TAXONOMY_VERSION,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
} from "./v04-contract";
import {
  V04_VOCABULARY_APPROVED_HASHES,
  V04_VOCABULARY_OPTIONS,
} from "./v04-vocabulary";

export const V04_SCHEMA_VERSION = "V04_SCHEMA_1A_V1" as const;
export const V04_WORKFLOW_CONTRACT_HASH = "437476f470b8cca0d6f21819ec0a16f72ed900192fb8748dd1d7873c91a79d45";

export const V04_SCHEMA_BUNDLE = {
  schemaVersion: V04_SCHEMA_VERSION,
  adminDataOperationStatements: ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS,
  contractStatements: V04_SCHEMA_STATEMENTS,
  workflowStatements: V04_WORKFLOW_SCHEMA_STATEMENTS,
} as const;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function canonicalV04SchemaValue(value: unknown) {
  return JSON.stringify(stableValue(value));
}

export function hashV04SchemaValue(value: unknown) {
  return createHash("sha256").update(canonicalV04SchemaValue(value), "utf8").digest("hex");
}

export const V04_SCHEMA_BUNDLE_HASH = hashV04SchemaValue(V04_SCHEMA_BUNDLE);

export function v04TargetCodeSha(explicit?: string) {
  return explicit?.trim()
    || process.env.VERCEL_GIT_COMMIT_SHA?.trim()
    || process.env.GITHUB_SHA?.trim()
    || "LOCAL_UNVERSIONED";
}

export function v04ExpectedTargetDataFingerprint(input: {
  actorUserId: string;
  targetBusinessHash: string;
}) {
  return hashV04SchemaValue({
    bundleHash: V04_SCHEMA_BUNDLE_HASH,
    workflowContract: {
      productVersion: V04_PRODUCT_VERSION,
      taxonomyVersion: V04_TAXONOMY_VERSION,
      workflowVersion: V04_WORKFLOW_VERSION,
      vocabularyVersion: V04_VOCABULARY_VERSION,
      payloadSchemaVersion: V04_PAYLOAD_SCHEMA_VERSION,
      workflowContractHash: V04_WORKFLOW_CONTRACT_HASH,
      vocabularyHash: V04_VOCABULARY_APPROVED_HASHES.combined,
      optionCount: V04_VOCABULARY_OPTIONS.length,
      status: "DRAFT",
    },
    bootstrapMembership: {
      userId: input.actorUserId,
      roleKey: "SYSTEM_ADMIN",
      status: "ACTIVE",
    },
    targetBusinessHash: input.targetBusinessHash,
  });
}

export const V04_ADDITIVE_LEGACY_COLUMNS = [
  "videos.created_by_user_id",
  "videos.deleted_by_user_id",
  "videos.delete_reason",
  "videos.restore_until",
  "videos.deletion_state",
  "videos.restored_at",
  "videos.restored_by_user_id",
  "annotations.vocabulary_version",
  "annotations.payload_schema_version",
  "annotations.content_hash",
  "annotations.updated_by_user_id",
  "shots.subtitle_effect",
  "annotation_snapshots.workflow_version",
  "annotation_snapshots.vocabulary_version",
  "annotation_snapshots.payload_schema_version",
  "annotation_snapshots.created_by_user_id",
  "audit_logs.actor_user_id",
  "audit_logs.request_id",
  "audit_logs.workflow_version",
] as const;

export const V04_REQUIRED_PRE1A_TABLES = [
  "users",
  "app_admins",
  "videos",
  "annotations",
  "shots",
  "shot_groups",
  "field_answers",
  "annotation_creative_structures",
  "annotation_snapshots",
  "audit_logs",
] as const;

export type V04SchemaState =
  | "PRE_1A_EXACT"
  | "CONTROL_LEDGER_ONLY_EXACT"
  | "TARGET_APPLIED_EXACT"
  | "DRIFT_OR_PARTIAL";
