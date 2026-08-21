import { createHash } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import { V04_SCHEMA_TABLES } from "@/db/v04-schema";
import { V04_SCHEMA_STATEMENTS } from "@/db/v04-schema";
import { V04_WORKFLOW_SCHEMA_STATEMENTS } from "@/db/v04-workflow-schema";
import { ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS } from "@/db/admin-data-operation-schema";
import {
  V04_PAYLOAD_SCHEMA_VERSION,
  V04_PRODUCT_VERSION,
  V04_TAXONOMY_VERSION,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
} from "./v04-contract";
import { V04ServiceError } from "./v04-errors";
import { previewV04AdminMappings } from "./v04-role-preview";
import {
  V04_ADDITIVE_LEGACY_COLUMNS,
  V04_REQUIRED_PRE1A_TABLES,
  V04_SCHEMA_BUNDLE_HASH,
  type V04SchemaState,
  v04ExpectedTargetDataFingerprint,
  v04TargetCodeSha,
} from "./v04-schema-catalog";

export const V04_MIGRATION_PREVIEW_SCHEMA_VERSION = "V04_MIGRATION_PREVIEW_V1" as const;
export const V04_MIGRATION_PREVIEW_SCOPE = "GLOBAL_V04_LEGACY_READ_PREVIEW" as const;
export const V04_MIGRATION_PREVIEW_TTL_MS = 30 * 60 * 1000;

export const V04_MIGRATION_PREVIEW_STAGES = [
  "ADMIN_CAPABILITY",
  "ADMIN_LEGACY_MAPPING",
  "CATALOG_TABLES",
  "CATALOG_COLUMNS",
  "CATALOG_INDEXES",
  "CATALOG_TRIGGERS",
  "CATALOG_POLICIES",
  "SCHEMA_DRIFT",
  "BUSINESS_FACTS",
  "ZERO_WRITE_CHECK",
] as const;

export type V04MigrationPreviewStage = typeof V04_MIGRATION_PREVIEW_STAGES[number];

type CountRow = QueryResultRow & { count: number | string };
type HashRow = QueryResultRow & { row_count: number | string; aggregate_hash: string };
type PreviewAdminCapabilityRow = QueryResultRow & {
  role_memberships_available: boolean;
  users_available: boolean;
  legacy_admins_available: boolean;
};
type TransitionalPreviewAdminRow = QueryResultRow & {
  actor_active: boolean;
  legacy_admin: boolean;
  active_name_count: number | string;
  unique_active_user_id: string | null;
};
type CatalogTableRow = QueryResultRow & { table_name: string; rls_enabled: boolean };
type CatalogColumnRow = QueryResultRow & {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};
type CatalogIndexRow = QueryResultRow & {
  table_name: string;
  object_name: string;
  is_unique: boolean;
  access_method: string;
  key_columns: string;
  include_columns: string;
  predicate: string;
};
type CatalogTriggerRow = QueryResultRow & {
  table_name: string;
  object_name: string;
  timing: string;
  events: string;
  orientation: string;
  update_columns: string;
  function_name: string;
  when_clause: string;
};
type CatalogPolicyRow = QueryResultRow & {
  table_name: string;
  object_name: string;
  permissive: string;
  command: string;
  role_names: string;
  using_expression: string;
  check_expression: string;
};

type CatalogObject = {
  tableName: string;
  objectName: string;
  signature: string;
};

export type V04SchemaObjectExpectation = {
  indexes: CatalogObject[];
  triggers: CatalogObject[];
  policies: CatalogObject[];
};

export type V04MigrationPreviewAnomaly = {
  type: string;
  count: number;
  stableIds: string[];
};

export type V04MigrationPreview = {
  previewSchemaVersion: typeof V04_MIGRATION_PREVIEW_SCHEMA_VERSION;
  scope: typeof V04_MIGRATION_PREVIEW_SCOPE;
  generatedAt: string;
  expiresAt: string;
  environmentKey: string;
  actorUserId: string;
  targetCodeSha: string;
  bundleHash: string;
  schemaState: V04SchemaState;
  stopReasons: string[];
  contract: {
    productVersion: typeof V04_PRODUCT_VERSION;
    taxonomyVersion: typeof V04_TAXONOMY_VERSION;
    workflowVersion: typeof V04_WORKFLOW_VERSION;
    vocabularyVersion: typeof V04_VOCABULARY_VERSION;
    payloadSchemaVersion: typeof V04_PAYLOAD_SCHEMA_VERSION;
    status: string;
    expectedStatus: "DRAFT" | "ACTIVE" | "RETIRED";
  };
  ready: boolean;
  previewToken: string;
  previewTokenDigest: string;
  schemaFingerprint: string;
  sourceHash: string;
  targetHash: string;
  nonTargetHash: string;
  facts: {
    P01: Record<string, number>;
    P02: Record<string, number>;
    P03: { snapshotKinds: Record<string, number>; versionAnomalies: number };
    P04: { promotedCurrentSnapshotCount: number; stableStreamIds: string[] };
    P05: { referenceAnomalyCount: number; stableObjectIds: string[] };
    P06: { ledgerRows: Record<string, number>; ledgerAnomalies: number };
    P07: {
      expected: {
        tables: string[];
        columns: string[];
        indexes: string[];
        triggers: string[];
        policies: string[];
      };
      absent: {
        tables: string[];
        columns: string[];
        indexes: string[];
        triggers: string[];
        policies: string[];
      };
      drift: string[];
      missingTables: string[];
      extraTables: string[];
      missingColumns: string[];
      extraColumns: string[];
      changedColumns: string[];
      missingTriggers: string[];
      extraTriggers: string[];
      changedTriggers: string[];
      missingIndexes: string[];
      extraIndexes: string[];
      changedIndexes: string[];
      missingPolicies: string[];
      extraPolicies: string[];
      changedPolicies: string[];
      unexpectedPolicies: string[];
      rlsDisabledTables: string[];
    };
    P08: {
      legacyCustomMarkers: number;
      pendingMechanisms: number;
      customTextPresent: number;
      structuredLegacyRawValues: number;
      stableAnnotationIds: string[];
    };
    P09: {
      classifications: Record<string, number>;
      mappings: Array<{
        stableReferenceId: string;
        classification: string;
        candidateUserIds: string[];
      }>;
    };
    P10: {
      physicalDeleteAuditCount: number;
      databaseOrphanCount: number;
      objectKeyAnomalyCount: number;
      cosOrphanStatus: "NOT_CONFIRMABLE_FROM_DATABASE";
    };
    P11: { objectCounts: Record<string, number>; totalContentHash: string };
  };
  zeroWrite: {
    beforeHash: string;
    afterHash: string;
    unchanged: boolean;
  };
  anomalies: V04MigrationPreviewAnomaly[];
};

const EXPECTED_TABLES = [...V04_SCHEMA_TABLES, "admin_data_operations"].sort();
const ALL_REQUIRED_TABLES = sortedUnique([
  ...EXPECTED_TABLES,
  ...V04_REQUIRED_PRE1A_TABLES,
]);
const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  annotation_vocabulary_versions: ["vocabulary_version", "taxonomy_version", "content_hash", "status"],
  annotation_vocabulary_options: ["vocabulary_version", "field_key", "option_id", "legacy_aliases_json"],
  workflow_contract_versions: ["workflow_version", "domain_key", "product_version", "payload_schema_version", "contract_hash", "status", "activated_at"],
  app_role_memberships: ["user_id", "role_key", "status"],
  schema_migration_operations: ["operation_key", "operation_type", "status", "preview_token", "source_catalog_hash", "target_catalog_hash", "non_target_hash"],
  annotation_choice_values: ["annotation_id", "target_type", "target_id", "field_key", "value_slot", "selected_option_ids", "custom_text", "advanced_text", "legacy_raw_value"],
  collaboration_workspaces: ["video_id", "workflow_version", "canonical_annotation_id", "active_round_id", "current_working_snapshot_id", "latest_submission_snapshot_id", "active_expert_release_id"],
  collaboration_baselines: ["workspace_id", "source_kind", "payload_json", "content_hash"],
  collaboration_rounds: ["workspace_id", "round_number", "status", "base_type", "base_baseline_id", "base_submission_snapshot_id"],
  annotation_submission_snapshots: ["workspace_id", "round_id", "submission_number", "source_working_snapshot_id", "source_revision", "payload_json", "content_hash"],
  collaboration_revision_events: ["workspace_id", "round_id", "change_set_id", "base_revision", "applied_revision", "target_key", "before_value_json", "after_value_json", "actor_user_id"],
  collaboration_edit_leases: ["workspace_id", "round_id", "holder_user_id", "session_id", "tab_token_hash", "lease_token_hash", "lease_version", "status", "expires_at"],
  expert_analysis_releases: ["workspace_id", "submission_snapshot_id", "grade", "status", "granted_by_user_id"],
  video_asset_cleanup_jobs: ["video_id", "object_key_snapshot", "state", "retention_until"],
  admin_data_operations: ["operation_key", "operation_type", "target_video_id", "status", "preview_token", "source_hash", "target_hash", "non_target_hash"],
};

function splitSqlDefinitions(body: string) {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "'" && body[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      result.push(body.slice(start, index));
      start = index + 1;
    }
  }
  result.push(body.slice(start));
  return result;
}

function expectedColumnsFromFrozenDdl() {
  const result = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    result.set(table, result.get(table) ?? new Set());
    result.get(table)!.add(column);
  };
  for (const statement of [
    ...V04_SCHEMA_STATEMENTS,
    ...V04_WORKFLOW_SCHEMA_STATEMENTS,
    ...ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS,
  ]) {
    const create = statement.match(/^CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)\s*\(([\s\S]*)\)$/i);
    if (create) {
      for (const definition of splitSqlDefinitions(create[2])) {
        const normalized = definition.trim();
        if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(normalized)) continue;
        const column = normalized.match(/^([a-z_][a-z0-9_]*)\s+/i)?.[1];
        if (column) add(create[1], column);
      }
    }
    for (const match of statement.matchAll(/ALTER TABLE\s+([a-z0-9_]+)\s+ADD COLUMN IF NOT EXISTS\s+([a-z0-9_]+)/gi)) {
      add(match[1], match[2]);
    }
  }
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    columns.forEach((column) => add(table, column));
  }
  return result;
}

const EXPECTED_COLUMN_MAP = expectedColumnsFromFrozenDdl();

const FROZEN_SCHEMA_STATEMENTS = [
  ...V04_SCHEMA_STATEMENTS,
  ...V04_WORKFLOW_SCHEMA_STATEMENTS,
  ...ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS,
];

function stripBalancedOuterParentheses(value: string) {
  let result = value.trim();
  while (result.startsWith("(") && result.endsWith(")")) {
    let depth = 0;
    let wrapsWholeValue = true;
    for (let index = 0; index < result.length; index += 1) {
      if (result[index] === "(") depth += 1;
      if (result[index] === ")") depth -= 1;
      if (depth === 0 && index < result.length - 1) {
        wrapsWholeValue = false;
        break;
      }
    }
    if (!wrapsWholeValue) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function normalizeCatalogExpression(value: string) {
  return stripBalancedOuterParentheses(value)
    .replace(/::(?:text|character varying|bpchar)\b/gi, "")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=])\s*/g, "$1")
    .trim()
    .toLowerCase();
}

function normalizeColumnType(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalized === "timestamptz") return "timestamp with time zone";
  if (normalized === "int" || normalized === "int4") return "integer";
  if (normalized === "bool") return "boolean";
  return normalized;
}

function normalizeColumnDefault(value: string | null | undefined) {
  const withoutTextCast = stripBalancedOuterParentheses(value ?? "")
    .replace(/::(?:text|character varying|bpchar)\b/gi, "");
  return stripBalancedOuterParentheses(withoutTextCast)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function columnSignature(input: {
  dataType: string;
  nullable: boolean;
  defaultValue: string | null | undefined;
}) {
  return canonicalV04PreviewValue({
    dataType: normalizeColumnType(input.dataType),
    nullable: input.nullable,
    defaultValue: normalizeColumnDefault(input.defaultValue),
  });
}

function expectedColumnSignaturesFromFrozenDdl() {
  const signatures = new Map<string, string>();
  const add = (table: string, column: string, definition: string) => {
    const dataType = definition.trim().match(/^([a-z]+(?:\s+with\s+time\s+zone)?)/i)?.[1] ?? "";
    const defaultValue = definition.match(/\bDEFAULT\s+([\s\S]+?)(?=\s+(?:NOT\s+NULL|NULL|REFERENCES|CHECK|PRIMARY|UNIQUE)\b|$)/i)?.[1] ?? "";
    signatures.set(`${table}.${column}`, columnSignature({
      dataType,
      nullable: !/\bNOT\s+NULL\b|\bPRIMARY\s+KEY\b/i.test(definition),
      defaultValue,
    }));
  };
  for (const statement of FROZEN_SCHEMA_STATEMENTS) {
    const create = statement.match(/^CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)\s*\(([\s\S]*)\)$/i);
    if (create) {
      for (const definition of splitSqlDefinitions(create[2])) {
        const normalized = definition.trim();
        if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(normalized)) continue;
        const match = normalized.match(/^([a-z_][a-z0-9_]*)\s+([\s\S]+)$/i);
        if (match) add(create[1], match[1], match[2]);
      }
    }
    const alter = statement.match(/^ALTER TABLE\s+([a-z0-9_]+)\s+ADD COLUMN IF NOT EXISTS\s+([a-z0-9_]+)\s+([\s\S]+)$/i);
    if (alter) add(alter[1], alter[2], alter[3]);
  }
  return signatures;
}

const EXPECTED_COLUMN_SIGNATURES = expectedColumnSignaturesFromFrozenDdl();

function catalogKey(object: Pick<CatalogObject, "tableName" | "objectName">) {
  return `${object.tableName}.${object.objectName}`;
}

function indexSignature(input: {
  unique: boolean;
  accessMethod: string;
  keyColumns: readonly string[];
  includeColumns: readonly string[];
  predicate: string;
}) {
  return canonicalV04PreviewValue({
    unique: input.unique,
    accessMethod: input.accessMethod.toLowerCase(),
    keyColumns: input.keyColumns.map(normalizeCatalogExpression),
    includeColumns: input.includeColumns.map(normalizeCatalogExpression),
    predicate: normalizeCatalogExpression(input.predicate),
  });
}

function triggerSignature(input: {
  timing: string;
  events: readonly string[];
  orientation: string;
  updateColumns: readonly string[];
  functionName: string;
  whenClause: string;
}) {
  return canonicalV04PreviewValue({
    timing: input.timing.toUpperCase(),
    events: [...input.events].map((event) => event.toUpperCase()).sort(),
    orientation: input.orientation.toUpperCase(),
    updateColumns: [...input.updateColumns].map(normalizeCatalogExpression).sort(),
    functionName: input.functionName.replace(/^.*\./, "").toLowerCase(),
    whenClause: normalizeCatalogExpression(input.whenClause),
  });
}

function policySignature(input: {
  permissive: string;
  command: string;
  roles: readonly string[];
  usingExpression: string;
  checkExpression: string;
}) {
  return canonicalV04PreviewValue({
    permissive: input.permissive.toUpperCase(),
    command: input.command.toUpperCase(),
    roles: [...input.roles].map((role) => role.toLowerCase()).sort(),
    usingExpression: normalizeCatalogExpression(input.usingExpression),
    checkExpression: normalizeCatalogExpression(input.checkExpression),
  });
}

function expectedSchemaObjectsFromFrozenDdl(): V04SchemaObjectExpectation {
  const indexes: CatalogObject[] = [];
  const triggers: CatalogObject[] = [];
  const policies: CatalogObject[] = [];
  for (const statement of FROZEN_SCHEMA_STATEMENTS) {
    const index = statement.match(/CREATE\s+(UNIQUE\s+)?INDEX\s+IF NOT EXISTS\s+([a-z0-9_]+)\s+ON\s+([a-z0-9_]+)\s*\(([\s\S]*?)\)(?:\s+WHERE\s+([\s\S]+))?\s*$/i);
    if (index) {
      indexes.push({
        tableName: index[3],
        objectName: index[2],
        signature: indexSignature({
          unique: Boolean(index[1]),
          accessMethod: "btree",
          keyColumns: splitSqlDefinitions(index[4]),
          includeColumns: [],
          predicate: index[5] ?? "",
        }),
      });
    }
    const trigger = statement.match(/CREATE TRIGGER\s+([a-z0-9_]+)\s+(BEFORE|AFTER|INSTEAD OF)\s+([\s\S]+?)\s+ON\s+([a-z0-9_]+)\s+FOR EACH\s+(ROW|STATEMENT)\s+EXECUTE FUNCTION\s+([a-z0-9_.]+)\s*\(\s*\)/i);
    if (trigger) {
      const eventParts = trigger[3].split(/\s+OR\s+/i);
      triggers.push({
        tableName: trigger[4],
        objectName: trigger[1],
        signature: triggerSignature({
          timing: trigger[2],
          events: eventParts.map((event) => event.replace(/\s+OF\s+[\s\S]*$/i, "")),
          orientation: trigger[5],
          updateColumns: eventParts.flatMap((event) =>
            event.match(/^UPDATE\s+OF\s+([\s\S]+)$/i)?.[1].split(",").map((column) => column.trim()) ?? []),
          functionName: trigger[6],
          whenClause: "",
        }),
      });
    }
    const policy = statement.match(/CREATE POLICY\s+([a-z0-9_]+)\s+ON\s+([a-z0-9_]+)([\s\S]*)$/i);
    if (policy) {
      const tail = policy[3];
      const roles = tail.match(/\bTO\s+([\s\S]+?)(?=\s+USING\b|\s+WITH CHECK\b|$)/i)?.[1]
        .split(",").map((role) => role.trim()) ?? ["public"];
      policies.push({
        tableName: policy[2],
        objectName: policy[1],
        signature: policySignature({
          permissive: tail.match(/\bAS\s+(PERMISSIVE|RESTRICTIVE)\b/i)?.[1] ?? "PERMISSIVE",
          command: tail.match(/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i)?.[1] ?? "ALL",
          roles,
          usingExpression: tail.match(/\bUSING\s*\(([\s\S]*?)\)(?=\s+WITH CHECK\b|$)/i)?.[1] ?? "",
          checkExpression: tail.match(/\bWITH CHECK\s*\(([\s\S]*?)\)\s*$/i)?.[1] ?? "",
        }),
      });
    }
  }
  return { indexes, triggers, policies };
}

export const V04_FROZEN_SCHEMA_OBJECT_EXPECTATION = expectedSchemaObjectsFromFrozenDdl();

const V04_TABLE_PREFIXES = [
  "annotation_vocabulary_",
  "workflow_contract_",
  "app_role_memberships",
  "schema_migration_operations",
  "annotation_choice_values",
  "collaboration_",
  "annotation_submission_snapshots",
  "expert_analysis_releases",
  "video_asset_cleanup_jobs",
  "admin_data_operations",
];

const SOURCE_HASH_QUERIES: Array<[string, string]> = [
  ["annotations:legacy", `SELECT to_jsonb(a) - ARRAY['vocabulary_version','payload_schema_version','content_hash','updated_by_user_id'] AS row
    FROM annotations a WHERE COALESCE(workflow_version, '') <> '${V04_WORKFLOW_VERSION}'`],
  ["annotation_snapshots:legacy", `SELECT to_jsonb(s) - ARRAY['workflow_version','vocabulary_version','payload_schema_version','created_by_user_id'] AS row
    FROM annotation_snapshots s WHERE COALESCE(to_jsonb(s)->>'workflow_version', '') <> '${V04_WORKFLOW_VERSION}'`],
  ["shots:legacy", `SELECT to_jsonb(s) - 'subtitle_effect' AS row FROM shots s
    JOIN annotations a ON a.id=s.annotation_id WHERE COALESCE(a.workflow_version, '') <> '${V04_WORKFLOW_VERSION}'`],
  ["shot_groups:legacy", `SELECT g.* FROM shot_groups g JOIN annotations a ON a.id=g.annotation_id WHERE COALESCE(a.workflow_version, '') <> '${V04_WORKFLOW_VERSION}'`],
  ["field_answers:legacy", `SELECT f.* FROM field_answers f JOIN annotations a ON a.id=f.annotation_id WHERE COALESCE(a.workflow_version, '') <> '${V04_WORKFLOW_VERSION}'`],
  ["annotation_creative_structures:legacy", `SELECT c.* FROM annotation_creative_structures c JOIN annotations a ON a.id=c.annotation_id WHERE COALESCE(a.workflow_version, '') <> '${V04_WORKFLOW_VERSION}'`],
  ["approved_analysis_releases", "SELECT * FROM approved_analysis_releases"],
  ["analysis_review_rounds", "SELECT * FROM analysis_review_rounds"],
  ["analysis_comments", "SELECT * FROM analysis_comments"],
  ["analysis_revision_suggestions", "SELECT * FROM analysis_revision_suggestions"],
  ["analysis_revision_events", "SELECT * FROM analysis_revision_events"],
  ["v03_collaboration_streams", "SELECT * FROM v03_collaboration_streams"],
  ["v03_collaboration_sources", "SELECT * FROM v03_collaboration_sources"],
  ["v03_collaboration_baselines", "SELECT * FROM v03_collaboration_baselines"],
  ["v03_collaboration_rounds", "SELECT * FROM v03_collaboration_rounds"],
  ["v03_collaboration_revision_events", "SELECT * FROM v03_collaboration_revision_events"],
];

const TARGET_HASH_QUERIES: Array<[string, string]> = [
  ["annotations:v04", `SELECT * FROM annotations WHERE workflow_version='${V04_WORKFLOW_VERSION}'`],
  ["annotation_snapshots:v04", `SELECT * FROM annotation_snapshots s
    WHERE COALESCE(to_jsonb(s)->>'workflow_version', '')='${V04_WORKFLOW_VERSION}'`],
  ["annotation_choice_values:v04", `SELECT c.* FROM annotation_choice_values c JOIN annotations a ON a.id=c.annotation_id WHERE a.workflow_version='${V04_WORKFLOW_VERSION}'`],
  ["collaboration_workspaces", "SELECT * FROM collaboration_workspaces"],
  ["collaboration_baselines", "SELECT * FROM collaboration_baselines"],
  ["collaboration_rounds", "SELECT * FROM collaboration_rounds"],
  ["annotation_submission_snapshots", "SELECT * FROM annotation_submission_snapshots"],
  ["collaboration_revision_events", "SELECT * FROM collaboration_revision_events"],
  ["collaboration_edit_leases", "SELECT * FROM collaboration_edit_leases"],
  ["expert_analysis_releases", "SELECT * FROM expert_analysis_releases"],
  ["video_asset_cleanup_jobs", "SELECT * FROM video_asset_cleanup_jobs"],
];

const NON_TARGET_HASH_QUERIES: Array<[string, string]> = [
  ["videos", `SELECT to_jsonb(v) - ARRAY['created_by_user_id','deleted_by_user_id','delete_reason',
    'restore_until','deletion_state','restored_at','restored_by_user_id'] AS row FROM videos v`],
  ["users", `SELECT id,status,to_jsonb(u)->>'identity_key' AS identity_key,
    display_name,to_jsonb(u)->>'email' AS email FROM users u`],
  ["app_admins", "SELECT * FROM app_admins"],
  ["audit_logs", `SELECT to_jsonb(a) - ARRAY['actor_user_id','request_id','workflow_version'] AS row FROM audit_logs a`],
  ["annotation_taxonomy_versions", `SELECT * FROM annotation_taxonomy_versions
    WHERE taxonomy_version<>'${V04_TAXONOMY_VERSION}'`],
];

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function canonicalV04PreviewValue(value: unknown) {
  return JSON.stringify(stableValue(value));
}

export function hashV04PreviewValue(value: unknown) {
  return createHash("sha256").update(canonicalV04PreviewValue(value), "utf8").digest("hex");
}

export function digestV04PreviewToken(previewToken: string) {
  return hashV04PreviewValue({ previewToken });
}

function numeric(value: number | string | null | undefined) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

async function inPreviewStage<T>(
  stage: V04MigrationPreviewStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof V04ServiceError) throw error;
    throw new V04ServiceError(
      "INTERNAL_ERROR",
      "只读 PREVIEW 暂时无法完成，请稍后重试。",
      { stage },
    );
  }
}

function tableFromQuery(query: string) {
  return query.match(/\bFROM\s+([a-z0-9_]+)/i)?.[1] ?? "";
}

async function tableHash(db: DbClient, query: string): Promise<{ count: number; hash: string }> {
  const row = await db.prepare(`SELECT COUNT(*)::bigint AS row_count,
    COALESCE(md5(string_agg(md5(to_jsonb(scope_row)::text), ''
      ORDER BY md5(to_jsonb(scope_row)::text))), md5('')) AS aggregate_hash
    FROM (${query}) scope_row`).first<HashRow>();
  return { count: numeric(row?.row_count), hash: row?.aggregate_hash ?? "" };
}

async function scopedHash(
  db: DbClient,
  catalogTables: Set<string>,
  queries: Array<[string, string]>,
  options: { missingAsEmpty?: boolean } = {},
) {
  const rows: Array<{ scope: string; count: number; hash: string }> = [];
  for (const [scope, query] of queries) {
    const table = tableFromQuery(query);
    if (!catalogTables.has(table)) {
      rows.push({
        scope,
        count: 0,
        hash: options.missingAsEmpty ? "d41d8cd98f00b204e9800998ecf8427e" : "MISSING_TABLE",
      });
      continue;
    }
    rows.push({ scope, ...(await tableHash(db, query)) });
  }
  return { hash: hashV04PreviewValue(rows), rows };
}

async function loadCatalog(db: DbClient) {
  const tables = await inPreviewStage("CATALOG_TABLES", async () => (await db.prepare(`SELECT c.relname AS table_name,
      c.relrowsecurity AS rls_enabled
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')
    ORDER BY c.relname`).all<CatalogTableRow>()).results);
  const columns = await inPreviewStage("CATALOG_COLUMNS", async () => (await db.prepare(`SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema=current_schema()
    ORDER BY table_name,ordinal_position`).all<CatalogColumnRow>()).results);
  const indexes = await inPreviewStage("CATALOG_INDEXES", async () => (await db.prepare(`SELECT table_class.relname AS table_name,
      index_class.relname AS object_name,
      idx.indisunique AS is_unique,
      access_method.amname AS access_method,
      COALESCE((
        SELECT string_agg(pg_get_indexdef(idx.indexrelid, key_number, TRUE), E'\\x1f'
          ORDER BY key_number)
        FROM generate_series(1, idx.indnkeyatts) key_number
      ), '') AS key_columns,
      COALESCE((
        SELECT string_agg(pg_get_indexdef(idx.indexrelid, include_number, TRUE), E'\\x1f'
          ORDER BY include_number)
        FROM generate_series(idx.indnkeyatts + 1, idx.indnatts) include_number
      ), '') AS include_columns,
      COALESCE(pg_get_expr(idx.indpred, idx.indrelid, TRUE), '') AS predicate
    FROM pg_index idx
    JOIN pg_class index_class ON index_class.oid=idx.indexrelid
    JOIN pg_class table_class ON table_class.oid=idx.indrelid
    JOIN pg_namespace namespace ON namespace.oid=table_class.relnamespace
    JOIN pg_am access_method ON access_method.oid=index_class.relam
    WHERE namespace.nspname=current_schema()
      AND NOT EXISTS (SELECT 1 FROM pg_constraint constraint_row
        WHERE constraint_row.conindid=idx.indexrelid)
    ORDER BY table_class.relname,index_class.relname`).all<CatalogIndexRow>()).results);
  const triggers = await inPreviewStage("CATALOG_TRIGGERS", async () => (await db.prepare(`SELECT table_class.relname AS table_name,
      trigger_row.tgname AS object_name,
      CASE WHEN (trigger_row.tgtype & 2) <> 0 THEN 'BEFORE'
           WHEN (trigger_row.tgtype & 64) <> 0 THEN 'INSTEAD OF'
           ELSE 'AFTER' END AS timing,
      concat_ws(E'\\x1f',
        CASE WHEN (trigger_row.tgtype & 4) <> 0 THEN 'INSERT' END,
        CASE WHEN (trigger_row.tgtype & 8) <> 0 THEN 'DELETE' END,
        CASE WHEN (trigger_row.tgtype & 16) <> 0 THEN 'UPDATE' END,
        CASE WHEN (trigger_row.tgtype & 32) <> 0 THEN 'TRUNCATE' END) AS events,
      CASE WHEN (trigger_row.tgtype & 1) <> 0 THEN 'ROW' ELSE 'STATEMENT' END AS orientation,
      COALESCE((
        SELECT string_agg(attribute_row.attname, E'\\x1f' ORDER BY update_column.ordinality)
        FROM unnest(trigger_row.tgattr::smallint[]) WITH ORDINALITY update_column(attnum, ordinality)
        JOIN pg_attribute attribute_row
          ON attribute_row.attrelid=trigger_row.tgrelid AND attribute_row.attnum=update_column.attnum
      ), '') AS update_columns,
      procedure_row.proname AS function_name,
      COALESCE(pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid, TRUE), '') AS when_clause
    FROM pg_trigger trigger_row
    JOIN pg_class table_class ON table_class.oid=trigger_row.tgrelid
    JOIN pg_namespace namespace ON namespace.oid=table_class.relnamespace
    JOIN pg_proc procedure_row ON procedure_row.oid=trigger_row.tgfoid
    WHERE namespace.nspname=current_schema() AND NOT trigger_row.tgisinternal
    ORDER BY table_class.relname,trigger_row.tgname`).all<CatalogTriggerRow>()).results);
  const policies = await inPreviewStage("CATALOG_POLICIES", async () => (await db.prepare(`SELECT tablename AS table_name,policyname AS object_name,
      permissive,cmd AS command,array_to_string(roles,E'\\x1f') AS role_names,
      COALESCE(qual,'') AS using_expression,COALESCE(with_check,'') AS check_expression
    FROM pg_policies WHERE schemaname=current_schema() ORDER BY tablename,policyname`)
    .all<CatalogPolicyRow>()).results);
  return { tables, columns, indexes, triggers, policies };
}

function actualSchemaObjects(catalog: Awaited<ReturnType<typeof loadCatalog>>): V04SchemaObjectExpectation {
  return {
    indexes: catalog.indexes.map((row) => ({
      tableName: row.table_name,
      objectName: row.object_name,
      signature: indexSignature({
        unique: row.is_unique,
        accessMethod: row.access_method,
        keyColumns: row.key_columns ? row.key_columns.split("\x1f") : [],
        includeColumns: row.include_columns ? row.include_columns.split("\x1f") : [],
        predicate: row.predicate,
      }),
    })),
    triggers: catalog.triggers.map((row) => ({
      tableName: row.table_name,
      objectName: row.object_name,
      signature: triggerSignature({
        timing: row.timing,
        events: row.events ? row.events.split("\x1f") : [],
        orientation: row.orientation,
        updateColumns: row.update_columns ? row.update_columns.split("\x1f") : [],
        functionName: row.function_name,
        whenClause: row.when_clause,
      }),
    })),
    policies: catalog.policies.map((row) => ({
      tableName: row.table_name,
      objectName: row.object_name,
      signature: policySignature({
        permissive: row.permissive,
        command: row.command,
        roles: row.role_names ? row.role_names.split("\x1f") : [],
        usingExpression: row.using_expression,
        checkExpression: row.check_expression,
      }),
    })),
  };
}

export async function inspectV04SchemaObjects(db: DbClient) {
  return actualSchemaObjects(await loadCatalog(db));
}

function compareCatalogObjects(actual: readonly CatalogObject[], expected: readonly CatalogObject[]) {
  const actualMap = new Map(actual.map((object) => [catalogKey(object), object]));
  const expectedMap = new Map(expected.map((object) => [catalogKey(object), object]));
  return {
    missing: [...expectedMap.keys()].filter((key) => !actualMap.has(key)).sort(),
    extra: [...actualMap.keys()].filter((key) => !expectedMap.has(key)).sort(),
    changed: [...expectedMap.keys()].filter((key) => {
      const actualObject = actualMap.get(key);
      return actualObject && actualObject.signature !== expectedMap.get(key)?.signature;
    }).sort(),
  };
}

export function compareV04SchemaObjects(
  actual: V04SchemaObjectExpectation,
  expected: V04SchemaObjectExpectation = V04_FROZEN_SCHEMA_OBJECT_EXPECTATION,
) {
  return {
    indexes: compareCatalogObjects(actual.indexes, expected.indexes),
    triggers: compareCatalogObjects(actual.triggers, expected.triggers),
    policies: compareCatalogObjects(actual.policies, expected.policies),
  };
}

function schemaDrift(catalog: Awaited<ReturnType<typeof loadCatalog>>) {
  const existingTables = new Set(catalog.tables.map((row) => row.table_name));
  const relevantTables = catalog.tables.map((row) => row.table_name)
    .filter((name) => V04_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix)));
  const missingTables = ALL_REQUIRED_TABLES.filter((name) => !existingTables.has(name));
  const extraTables = relevantTables.filter((name) => !EXPECTED_TABLES.includes(name as typeof EXPECTED_TABLES[number]));
  const columnNames = new Set(catalog.columns.map((row) => `${row.table_name}.${row.column_name}`));
  const missingColumns = [...EXPECTED_COLUMN_MAP].flatMap(([table, columns]) =>
    [...columns].filter((column) => !columnNames.has(`${table}.${column}`)).map((column) => `${table}.${column}`));
  const extraColumns = catalog.columns.filter((row) => {
    if (!EXPECTED_TABLES.includes(row.table_name as typeof EXPECTED_TABLES[number])) return false;
    const expected = EXPECTED_COLUMN_MAP.get(row.table_name);
    return expected && !expected.has(row.column_name);
  }).map((row) => `${row.table_name}.${row.column_name}`);
  const expectedObjects = V04_FROZEN_SCHEMA_OBJECT_EXPECTATION;
  const relatedIndexTables = new Set([
    ...EXPECTED_TABLES,
    ...expectedObjects.indexes.map((object) => object.tableName),
  ]);
  const relatedTriggerTables = new Set([
    ...EXPECTED_TABLES,
    ...expectedObjects.triggers.map((object) => object.tableName),
  ]);
  const relatedPolicyTables = new Set([
    ...EXPECTED_TABLES,
    ...expectedObjects.policies.map((object) => object.tableName),
  ]);
  const actualObjects = actualSchemaObjects(catalog);
  const objectDrift = compareV04SchemaObjects({
    indexes: actualObjects.indexes.filter((object) => relatedIndexTables.has(object.tableName)),
    triggers: actualObjects.triggers.filter((object) => relatedTriggerTables.has(object.tableName)),
    policies: actualObjects.policies.filter((object) => relatedPolicyTables.has(object.tableName)),
  }, expectedObjects);
  const rlsDisabledTables = catalog.tables
    .filter((row) => EXPECTED_TABLES.includes(row.table_name as typeof EXPECTED_TABLES[number]) && !row.rls_enabled)
    .map((row) => row.table_name);
  const expected = {
    tables: ALL_REQUIRED_TABLES,
    columns: sortedUnique([...EXPECTED_COLUMN_MAP].flatMap(([table, columns]) =>
      [...columns].map((column) => `${table}.${column}`))),
    indexes: expectedObjects.indexes.map(catalogKey).sort(),
    triggers: expectedObjects.triggers.map(catalogKey).sort(),
    policies: expectedObjects.policies.map(catalogKey).sort(),
  };
  const absent = {
    tables: sortedUnique(missingTables),
    columns: sortedUnique(missingColumns),
    indexes: objectDrift.indexes.missing,
    triggers: objectDrift.triggers.missing,
    policies: objectDrift.policies.missing,
  };
  const actualColumnSignatures = new Map(catalog.columns.map((row) => [
    `${row.table_name}.${row.column_name}`,
    columnSignature({
      dataType: row.data_type,
      nullable: row.is_nullable === "YES",
      defaultValue: row.column_default,
    }),
  ]));
  const changedColumns = sortedUnique([...EXPECTED_COLUMN_SIGNATURES].flatMap(([key, expectedSignature]) => {
    const actualSignature = actualColumnSignatures.get(key);
    return actualSignature && actualSignature !== expectedSignature ? [key] : [];
  }));
  const driftItems = sortedUnique([
    ...extraTables.map((value) => `EXTRA_TABLE:${value}`),
    ...extraColumns.map((value) => `EXTRA_COLUMN:${value}`),
    ...changedColumns.map((value) => `CHANGED_COLUMN:${value}`),
    ...objectDrift.indexes.extra.map((value) => `EXTRA_INDEX:${value}`),
    ...objectDrift.indexes.changed.map((value) => `CHANGED_INDEX:${value}`),
    ...objectDrift.triggers.extra.map((value) => `EXTRA_TRIGGER:${value}`),
    ...objectDrift.triggers.changed.map((value) => `CHANGED_TRIGGER:${value}`),
    ...objectDrift.policies.extra.map((value) => `EXTRA_POLICY:${value}`),
    ...objectDrift.policies.changed.map((value) => `CHANGED_POLICY:${value}`),
  ]);
  return {
    expected,
    absent,
    drift: driftItems,
    missingTables: sortedUnique(missingTables),
    extraTables: sortedUnique(extraTables),
    missingColumns: sortedUnique(missingColumns),
    extraColumns,
    changedColumns,
    missingTriggers: objectDrift.triggers.missing,
    extraTriggers: objectDrift.triggers.extra,
    changedTriggers: objectDrift.triggers.changed,
    missingIndexes: objectDrift.indexes.missing,
    extraIndexes: objectDrift.indexes.extra,
    changedIndexes: objectDrift.indexes.changed,
    missingPolicies: objectDrift.policies.missing,
    extraPolicies: objectDrift.policies.extra,
    changedPolicies: objectDrift.policies.changed,
    unexpectedPolicies: objectDrift.policies.extra,
    rlsDisabledTables: sortedUnique(rlsDisabledTables),
  };
}

function v04SchemaDriftCount(drift: ReturnType<typeof schemaDrift>) {
  return [
    drift.missingTables,
    drift.extraTables,
    drift.missingColumns,
    drift.extraColumns,
    drift.changedColumns,
    drift.missingTriggers,
    drift.extraTriggers,
    drift.changedTriggers,
    drift.missingIndexes,
    drift.extraIndexes,
    drift.changedIndexes,
    drift.missingPolicies,
    drift.extraPolicies,
    drift.changedPolicies,
    drift.rlsDisabledTables,
  ].reduce((sum, values) => sum + values.length, 0);
}

function classifyV04SchemaState(
  catalog: Awaited<ReturnType<typeof loadCatalog>>,
  drift: ReturnType<typeof schemaDrift>,
): V04SchemaState {
  const tables = new Set(catalog.tables.map((row) => row.table_name));
  const columns = new Set(catalog.columns.map((row) => `${row.table_name}.${row.column_name}`));
  const presentV04Tables = V04_SCHEMA_TABLES.filter((table) => tables.has(table));
  const additiveColumnsPresent = V04_ADDITIVE_LEGACY_COLUMNS.some((column) => columns.has(column));
  const baselineComplete = V04_REQUIRED_PRE1A_TABLES.every((table) => tables.has(table));
  if (baselineComplete && presentV04Tables.length === 0 && !additiveColumnsPresent
    && drift.extraTables.length === 0 && drift.drift.length === 0) {
    return "PRE_1A_EXACT";
  }
  if (baselineComplete && presentV04Tables.length === 1
    && presentV04Tables[0] === "schema_migration_operations"
    && !additiveColumnsPresent
    && !drift.rlsDisabledTables.includes("schema_migration_operations")
    && drift.missingColumns.every((column) => !column.startsWith("schema_migration_operations."))
    && drift.extraColumns.every((column) => !column.startsWith("schema_migration_operations."))
    && drift.changedColumns.every((column) => !column.startsWith("schema_migration_operations."))
    && drift.missingTriggers.every((trigger) => !trigger.startsWith("schema_migration_operations."))
    && drift.changedTriggers.every((trigger) => !trigger.startsWith("schema_migration_operations."))
    && drift.drift.length === 0) {
    return "CONTROL_LEDGER_ONLY_EXACT";
  }
  if (v04SchemaDriftCount(drift) === 0) return "TARGET_APPLIED_EXACT";
  return "DRIFT_OR_PARTIAL";
}

function anomaly(type: string, stableIds: string[]): V04MigrationPreviewAnomaly {
  const ids = sortedUnique(stableIds);
  return { type, count: ids.length, stableIds: ids };
}

async function ids(db: DbClient, query: string): Promise<string[]> {
  return (await db.prepare(query).all<{ id: string } & QueryResultRow>()).results.map((row) => row.id).sort();
}

async function count(db: DbClient, query: string) {
  return numeric((await db.prepare(query).first<CountRow>())?.count);
}

function hasCatalogTables(catalogTables: Set<string>, required: readonly string[]) {
  return required.every((table) => catalogTables.has(table));
}

async function countIf(
  db: DbClient,
  catalogTables: Set<string>,
  required: readonly string[],
  query: string,
) {
  return hasCatalogTables(catalogTables, required) ? count(db, query) : 0;
}

async function idsIf(
  db: DbClient,
  catalogTables: Set<string>,
  required: readonly string[],
  query: string,
) {
  return hasCatalogTables(catalogTables, required) ? ids(db, query) : [];
}

function stableEnvironmentKey() {
  return process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown";
}

export function v04PreviewTimeWindow(now: Date) {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError("PREVIEW time must be valid");
  const startsAtMs = Math.floor(timestamp / V04_MIGRATION_PREVIEW_TTL_MS) * V04_MIGRATION_PREVIEW_TTL_MS;
  return {
    startsAt: new Date(startsAtMs).toISOString(),
    expiresAt: new Date(startsAtMs + V04_MIGRATION_PREVIEW_TTL_MS).toISOString(),
  };
}

export function assertV04PreviewToken(
  current: V04MigrationPreview,
  suppliedToken: string,
  now: Date = new Date(),
) {
  const expiresAtMs = Date.parse(current.expiresAt);
  const expired = !Number.isFinite(expiresAtMs) || now.getTime() >= expiresAtMs;
  if (expired || !suppliedToken || suppliedToken !== current.previewToken) {
    throw new V04ServiceError("STALE_PREVIEW", "PREVIEW 事实已变化，请重新执行只读 PREVIEW。", {
      currentPreviewTokenDigest: current.previewTokenDigest,
      expiresAt: current.expiresAt,
      reason: expired ? "EXPIRED" : "FACTS_CHANGED",
    });
  }
}

export function isV04PreviewSameOrigin(request: Request, appUrl: string) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  try {
    const expectedOrigin = new URL(appUrl).origin;
    if (new URL(request.url).origin !== expectedOrigin) return false;
    const suppliedOrigin = request.headers.get("origin");
    return !suppliedOrigin || new URL(suppliedOrigin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

export async function assertV04PreviewAdmin(
  db: DbClient,
  actor: { userId: string; displayName?: string },
) {
  const capabilities = await inPreviewStage("ADMIN_CAPABILITY", () => db.prepare(`SELECT
    to_regclass(current_schema() || '.app_role_memberships') IS NOT NULL
      AS role_memberships_available,
    to_regclass(current_schema() || '.users') IS NOT NULL AS users_available,
    to_regclass(current_schema() || '.app_admins') IS NOT NULL AS legacy_admins_available`)
    .first<PreviewAdminCapabilityRow>());
  if (!capabilities) {
    throw new V04ServiceError("ADMIN_REQUIRED", "仅稳定系统管理员可查看 V0.4 迁移 PREVIEW。");
  }

  if (capabilities.role_memberships_available) {
    const stableAdmin = await inPreviewStage("ADMIN_LEGACY_MAPPING", () => db.prepare(`SELECT 1 FROM app_role_memberships
      WHERE user_id=? AND role_key='SYSTEM_ADMIN' AND status='ACTIVE'`)
      .bind(actor.userId).first());
    if (!stableAdmin) {
      throw new V04ServiceError("ADMIN_REQUIRED", "仅稳定系统管理员可查看 V0.4 迁移 PREVIEW。", {
        authorizationMode: "STABLE_MEMBERSHIP_REQUIRED",
      });
    }
    return "STABLE_MEMBERSHIP" as const;
  }

  const displayName = actor.displayName?.trim() ?? "";
  if (!capabilities.users_available || !capabilities.legacy_admins_available || !displayName) {
    throw new V04ServiceError("ADMIN_REQUIRED", "当前管理员身份无法唯一确认。", {
      authorizationMode: "PRE_1A_PREVIEW_ONLY",
      classification: "MISSING",
    });
  }
  const transitional = await inPreviewStage("ADMIN_LEGACY_MAPPING", () => db.prepare(`SELECT
    EXISTS (
      SELECT 1 FROM users
      WHERE id=? AND status='ACTIVE' AND display_name=?
    ) AS actor_active,
    EXISTS (
      SELECT 1 FROM app_admins WHERE display_name=?
    ) AS legacy_admin,
    (
      SELECT COUNT(*)::bigint FROM users
      WHERE status='ACTIVE' AND display_name=?
    ) AS active_name_count,
    (
      SELECT MIN(id) FROM users
      WHERE status='ACTIVE' AND display_name=?
    ) AS unique_active_user_id`)
    .bind(actor.userId, displayName, displayName, displayName, displayName)
    .first<TransitionalPreviewAdminRow>());
  const activeNameCount = numeric(transitional?.active_name_count);
  const classification = !transitional?.actor_active
    ? "DISABLED"
    : !transitional.legacy_admin
      ? "MISSING"
      : activeNameCount !== 1
        ? "AMBIGUOUS"
        : transitional.unique_active_user_id !== actor.userId
          ? "MISSING"
          : "UNIQUE";
  if (classification !== "UNIQUE") {
    throw new V04ServiceError("ADMIN_REQUIRED", "当前管理员身份无法唯一确认。", {
      authorizationMode: "PRE_1A_PREVIEW_ONLY",
      classification,
    });
  }
  return "PRE_1A_PREVIEW_ONLY" as const;
}

export async function previewV04Migration(
  db: DbClient,
  actor: { userId: string; displayName?: string },
  options: {
    now?: Date;
    environmentKey?: string;
    targetCodeSha?: string;
    expectedContractStatus?: "DRAFT" | "ACTIVE" | "RETIRED";
  } = {},
): Promise<V04MigrationPreview> {
  await assertV04PreviewAdmin(db, actor);

  const now = options.now ?? new Date();
  const previewWindow = v04PreviewTimeWindow(now);
  const environmentKey = options.environmentKey ?? stableEnvironmentKey();
  const catalog = await loadCatalog(db);
  const catalogTableSet = new Set(catalog.tables.map((row) => row.table_name));
  const { drift, schemaFingerprint } = await inPreviewStage("SCHEMA_DRIFT", () => ({
    drift: schemaDrift(catalog),
    schemaFingerprint: hashV04PreviewValue({
      tables: catalog.tables,
      columns: catalog.columns,
      indexes: catalog.indexes,
      triggers: catalog.triggers,
      policies: catalog.policies,
    }),
  }));
  const schemaState = classifyV04SchemaState(catalog, drift);
  const targetCodeSha = v04TargetCodeSha(options.targetCodeSha);
  const catalogColumnSet = new Set(catalog.columns.map((row) => `${row.table_name}.${row.column_name}`));
  const expectedContractStatus = options.expectedContractStatus ?? "DRAFT";
  const contractStatuses = await inPreviewStage("SCHEMA_DRIFT", async () => {
    const unavailable = {
      taxonomy: "MISSING",
      vocabulary: "MISSING",
      workflow: "MISSING",
    };
    if (!catalogTableSet.has("annotation_taxonomy_versions")
      || !catalogTableSet.has("annotation_vocabulary_versions")
      || !catalogTableSet.has("workflow_contract_versions")
      || !catalogColumnSet.has("annotation_taxonomy_versions.status")
      || !catalogColumnSet.has("annotation_vocabulary_versions.status")
      || !catalogColumnSet.has("workflow_contract_versions.status")) return unavailable;
    const [taxonomy, vocabulary, workflow] = await Promise.all([
      db.prepare("SELECT status FROM annotation_taxonomy_versions WHERE taxonomy_version=?")
        .bind(V04_TAXONOMY_VERSION).first<{ status: string } & QueryResultRow>(),
      db.prepare("SELECT status FROM annotation_vocabulary_versions WHERE vocabulary_version=?")
        .bind(V04_VOCABULARY_VERSION).first<{ status: string } & QueryResultRow>(),
      db.prepare("SELECT status FROM workflow_contract_versions WHERE workflow_version=?")
        .bind(V04_WORKFLOW_VERSION).first<{ status: string } & QueryResultRow>(),
    ]);
    return {
      taxonomy: taxonomy?.status ?? "MISSING",
      vocabulary: vocabulary?.status ?? "MISSING",
      workflow: workflow?.status ?? "MISSING",
    };
  });
  const contractStatus = new Set(Object.values(contractStatuses)).size === 1
    ? contractStatuses.workflow
    : "MIXED";
  const source = await inPreviewStage("BUSINESS_FACTS", () =>
    scopedHash(db, catalogTableSet, SOURCE_HASH_QUERIES));
  const targetBusiness = await inPreviewStage("BUSINESS_FACTS", () =>
    scopedHash(db, catalogTableSet, TARGET_HASH_QUERIES, { missingAsEmpty: true }));
  const targetHash = v04ExpectedTargetDataFingerprint({
    actorUserId: actor.userId,
    targetBusinessHash: targetBusiness.hash,
  });
  const nonTarget = await inPreviewStage("BUSINESS_FACTS", () =>
    scopedHash(db, catalogTableSet, NON_TARGET_HASH_QUERIES));
  const beforeReadHash = hashV04PreviewValue({
    sourceHash: source.hash,
    targetBusinessHash: targetBusiness.hash,
    nonTargetHash: nonTarget.hash,
  });

  const businessVideos = await countIf(db, catalogTableSet, ["videos"],
    "SELECT COUNT(*) AS count FROM videos WHERE data_scope='BUSINESS'");
  const annotationRows = !hasCatalogTables(catalogTableSet, ["annotations", "videos"])
    ? []
    : (await db.prepare(`SELECT COALESCE(a.workflow_version,'UNKNOWN') AS key,
      COUNT(*)::bigint AS count FROM annotations a JOIN videos v ON v.id=a.video_id
      WHERE v.data_scope='BUSINESS'
      GROUP BY COALESCE(a.workflow_version,'UNKNOWN') ORDER BY key`)
      .all<{ key: string; count: number | string } & QueryResultRow>()).results;
  const p01: Record<string, number> = { businessVideos, v02Annotations: 0, v03Annotations: 0, v04Annotations: 0 };
  for (const row of annotationRows) {
    if (row.key === V04_WORKFLOW_VERSION) p01.v04Annotations += numeric(row.count);
    else if (row.key.includes("V0.3")) p01.v03Annotations += numeric(row.count);
    else p01.v02Annotations += numeric(row.count);
  }

  const p02 = {
    v03Streams: await countIf(db, catalogTableSet, ["v03_collaboration_streams"],
      "SELECT COUNT(*) AS count FROM v03_collaboration_streams"),
    v04Workspaces: await countIf(db, catalogTableSet, ["collaboration_workspaces"],
      "SELECT COUNT(*) AS count FROM collaboration_workspaces"),
    canonicalAnnotations: await countIf(db, catalogTableSet, ["collaboration_workspaces"],
      "SELECT COUNT(DISTINCT canonical_annotation_id) AS count FROM collaboration_workspaces"),
    activeRounds: await countIf(db, catalogTableSet, ["collaboration_rounds"],
      "SELECT COUNT(*) AS count FROM collaboration_rounds WHERE status='ACTIVE'"),
    logicalEmptyBusinessVideos: await countIf(db, catalogTableSet, ["videos"], `SELECT COUNT(*) AS count FROM videos v
      WHERE v.data_scope='BUSINESS' AND v.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM ${catalogTableSet.has("collaboration_workspaces") ? "collaboration_workspaces" : "videos"} w
        WHERE ${catalogTableSet.has("collaboration_workspaces") ? "w.video_id=v.id AND w.workflow_version='" + V04_WORKFLOW_VERSION + "'" : "FALSE"}
      )`),
  };

  const snapshotRows = !catalogTableSet.has("annotation_snapshots")
    ? []
    : (await db.prepare(`SELECT COALESCE(snapshot_kind,'UNKNOWN') AS key,
      COUNT(*)::bigint AS count FROM annotation_snapshots GROUP BY COALESCE(snapshot_kind,'UNKNOWN') ORDER BY key`)
      .all<{ key: string; count: number | string } & QueryResultRow>()).results;
  const snapshotKinds = Object.fromEntries(snapshotRows.map((row) => [row.key, numeric(row.count)]));
  const versionAnomalyIds = await idsIf(db, catalogTableSet, ["annotation_snapshots"], `SELECT id FROM annotation_snapshots s WHERE
      (s.version_number IS NOT NULL AND s.version_number <= 0)
      OR (s.version_number IS NOT NULL AND EXISTS (
        SELECT 1 FROM annotation_snapshots x WHERE x.annotation_id=s.annotation_id
          AND x.version_number=s.version_number AND x.id<>s.id
      )) ORDER BY id`);
  const promotedStreamIds = await idsIf(db, catalogTableSet,
    ["v03_collaboration_streams", "annotation_snapshots"], `SELECT stream.id FROM v03_collaboration_streams stream
    JOIN annotation_snapshots snapshot ON snapshot.id=stream.current_snapshot_id
    WHERE snapshot.snapshot_kind IN ('CANDIDATE','APPROVED','SUBMISSION')
      OR snapshot.workflow_status IN ('APPROVED','CANDIDATE') ORDER BY stream.id`);

  const referenceIds = sortedUnique([
    ...(await idsIf(db, catalogTableSet,
      ["approved_analysis_releases", "annotation_snapshots", "analysis_review_rounds"],
      `SELECT 'release:'||r.id AS id FROM approved_analysis_releases r
      LEFT JOIN annotation_snapshots approved ON approved.id=r.approved_snapshot_id
      LEFT JOIN annotation_snapshots source ON source.id=r.source_snapshot_id
      LEFT JOIN analysis_review_rounds review ON review.id=r.source_review_round_id
      WHERE approved.id IS NULL OR source.id IS NULL OR review.id IS NULL
        OR approved.annotation_id<>r.annotation_id OR source.annotation_id<>r.annotation_id
        OR review.annotation_id<>r.annotation_id`)),
    ...(await idsIf(db, catalogTableSet,
      ["v03_collaboration_streams", "annotations", "v03_collaboration_rounds", "approved_analysis_releases"],
      `SELECT 'stream:'||s.id AS id FROM v03_collaboration_streams s
      LEFT JOIN annotations a ON a.id=s.canonical_annotation_id
      LEFT JOIN v03_collaboration_rounds round ON round.id=s.active_round_id
      LEFT JOIN approved_analysis_releases release ON release.id=s.active_release_id
      WHERE a.id IS NULL OR a.video_id<>s.video_id
        OR (s.active_round_id IS NOT NULL AND (round.id IS NULL OR round.stream_id<>s.id))
        OR (s.active_release_id IS NOT NULL AND (release.id IS NULL OR release.video_id<>s.video_id))`)),
    ...(await idsIf(db, catalogTableSet,
      ["collaboration_workspaces", "annotations", "collaboration_rounds", "annotation_submission_snapshots", "expert_analysis_releases"],
      `SELECT 'workspace:'||w.id AS id FROM collaboration_workspaces w
      LEFT JOIN annotations a ON a.id=w.canonical_annotation_id
      LEFT JOIN collaboration_rounds round ON round.id=w.active_round_id
      LEFT JOIN annotation_submission_snapshots submission ON submission.id=w.latest_submission_snapshot_id
      LEFT JOIN expert_analysis_releases release ON release.id=w.active_expert_release_id
      WHERE a.id IS NULL OR a.video_id<>w.video_id OR a.workflow_version<>w.workflow_version
        OR (w.active_round_id IS NOT NULL AND (round.id IS NULL OR round.workspace_id<>w.id))
        OR (w.latest_submission_snapshot_id IS NOT NULL AND (submission.id IS NULL OR submission.workspace_id<>w.id))
        OR (w.active_expert_release_id IS NOT NULL AND (release.id IS NULL OR release.workspace_id<>w.id))`)),
  ]);

  const ledgerSummaryRows: Array<{ key: string; count: number | string }> = [];
  if (catalogTableSet.has("admin_data_operations")) {
    ledgerSummaryRows.push(...(await db.prepare(`SELECT 'admin:'||status AS key,COUNT(*)::bigint AS count
      FROM admin_data_operations GROUP BY status ORDER BY key`)
      .all<{ key: string; count: number | string } & QueryResultRow>()).results);
  }
  if (catalogTableSet.has("schema_migration_operations")) {
    ledgerSummaryRows.push(...(await db.prepare(`SELECT 'schema:'||operation_type||':'||status AS key,
      COUNT(*)::bigint AS count FROM schema_migration_operations
      GROUP BY operation_type,status ORDER BY key`)
      .all<{ key: string; count: number | string } & QueryResultRow>()).results);
  }
  const ledgerRows = Object.fromEntries(ledgerSummaryRows
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((row) => [row.key, numeric(row.count)]));
  const ledgerAnomalyIds = await idsIf(db, catalogTableSet, ["schema_migration_operations"], `SELECT id FROM schema_migration_operations
    WHERE (operation_type='SCHEMA_PREVIEW' AND status<>'PREVIEWED')
      OR (operation_type IN ('SCHEMA_APPLY','CONTRACT_ACTIVATE') AND status NOT IN ('PREVIEWED','APPLYING','APPLIED','FAILED'))
    ORDER BY id`);

  const p08Ids = await idsIf(db, catalogTableSet, ["annotation_creative_structures"], `SELECT annotation_id AS id FROM annotation_creative_structures
    WHERE mechanism_primary IN ('__CUSTOM__','其他','其他（自定义机制）')
      OR story_reference_type IN ('__CUSTOM__','其他','其他（自定义参照类型）')
      OR mechanism_auxiliary_json LIKE '%待形成新机制%'
      OR mechanism_custom<>''`);
  const p08 = {
    legacyCustomMarkers: await countIf(db, catalogTableSet, ["annotation_creative_structures"], `SELECT COUNT(*) AS count FROM annotation_creative_structures
      WHERE mechanism_primary IN ('__CUSTOM__','其他','其他（自定义机制）')
        OR story_reference_type IN ('__CUSTOM__','其他','其他（自定义参照类型）')`),
    pendingMechanisms: await countIf(db, catalogTableSet, ["annotation_creative_structures"], `SELECT COUNT(*) AS count FROM annotation_creative_structures
      WHERE mechanism_primary='现有词表不适用／待形成新机制'
        OR mechanism_auxiliary_json LIKE '%待形成新机制%'`),
    customTextPresent: await countIf(db, catalogTableSet, ["annotation_creative_structures"],
      "SELECT COUNT(*) AS count FROM annotation_creative_structures WHERE mechanism_custom<>''"),
    structuredLegacyRawValues: await countIf(db, catalogTableSet, ["annotation_choice_values"],
      "SELECT COUNT(*) AS count FROM annotation_choice_values WHERE legacy_raw_value IS NOT NULL"),
    stableAnnotationIds: p08Ids,
  };

  const users = (await db.prepare(`SELECT id,to_jsonb(u)->>'email' AS email,
      display_name,status FROM users u ORDER BY id`)
    .all<{ id: string; email: string | null; display_name: string; status: "ACTIVE" | "DISABLED" } & QueryResultRow>()).results;
  const admins = (await db.prepare("SELECT display_name FROM app_admins ORDER BY display_name")
    .all<{ display_name: string } & QueryResultRow>()).results;
  const adminMappings = previewV04AdminMappings(
    users.map((user) => ({ id: user.id, email: user.email, displayName: user.display_name, status: user.status })),
    admins.map((admin) => ({
      stableReferenceId: `legacy-admin:${hashV04PreviewValue(admin.display_name).slice(0, 20)}`,
      displayName: admin.display_name,
    })),
  );
  const p09 = {
    classifications: Object.fromEntries(["UNIQUE", "AMBIGUOUS", "MISSING", "DISABLED"].map((classification) => [
      classification,
      adminMappings.filter((mapping) => mapping.classification === classification).length,
    ])),
    mappings: adminMappings,
  };

  const physicalDeleteIds = await idsIf(db, catalogTableSet, ["audit_logs"], `SELECT id FROM audit_logs WHERE
    action ILIKE '%PHYSICAL%DELETE%' OR action ILIKE '%PURGE%' OR action ILIKE '%ASSET%DELETE%' ORDER BY id`);
  const orphanIds = sortedUnique([
    ...(await idsIf(db, catalogTableSet, ["annotations", "videos"],
      "SELECT 'annotation:'||a.id AS id FROM annotations a LEFT JOIN videos v ON v.id=a.video_id WHERE v.id IS NULL")),
    ...(await idsIf(db, catalogTableSet, ["annotation_snapshots", "annotations", "videos"],
      "SELECT 'snapshot:'||s.id AS id FROM annotation_snapshots s LEFT JOIN annotations a ON a.id=s.annotation_id LEFT JOIN videos v ON v.id=s.video_id WHERE a.id IS NULL OR v.id IS NULL")),
    ...(await idsIf(db, catalogTableSet, ["shots", "annotations"],
      "SELECT 'shot:'||s.id AS id FROM shots s LEFT JOIN annotations a ON a.id=s.annotation_id WHERE a.id IS NULL")),
    ...(await idsIf(db, catalogTableSet, ["audit_logs", "videos"],
      "SELECT 'audit-video:'||a.id AS id FROM audit_logs a LEFT JOIN videos v ON v.id=a.object_id WHERE a.object_type='VIDEO' AND v.id IS NULL")),
  ]);
  const objectKeyIds = await idsIf(db, catalogTableSet, ["videos"], `SELECT id FROM videos WHERE object_key='' OR object_key IS NULL
    OR EXISTS (SELECT 1 FROM videos other WHERE other.id<>videos.id AND other.object_key=videos.object_key)
    OR thumbnail_key=object_key ORDER BY id`);

  const historyScopes = source.rows.filter((row) => [
    "annotation_snapshots:legacy", "approved_analysis_releases", "v03_collaboration_baselines",
  ].includes(row.scope));
  const contractCounts = {
    taxonomyDraft: await countIf(db, catalogTableSet, ["annotation_taxonomy_versions"],
      `SELECT COUNT(*) AS count FROM annotation_taxonomy_versions
        WHERE taxonomy_version='${V04_TAXONOMY_VERSION}' AND status='DRAFT'`),
    vocabularyDraft: await countIf(db, catalogTableSet, ["annotation_vocabulary_versions"],
      `SELECT COUNT(*) AS count FROM annotation_vocabulary_versions
        WHERE vocabulary_version='${V04_VOCABULARY_VERSION}' AND status='DRAFT'`),
    vocabularyOptions: await countIf(db, catalogTableSet, ["annotation_vocabulary_options"],
      `SELECT COUNT(*) AS count FROM annotation_vocabulary_options
        WHERE vocabulary_version='${V04_VOCABULARY_VERSION}'`),
    workflowDraft: await countIf(db, catalogTableSet, ["workflow_contract_versions"],
      `SELECT COUNT(*) AS count FROM workflow_contract_versions
        WHERE workflow_version='${V04_WORKFLOW_VERSION}' AND status='DRAFT'`),
    taxonomyActive: await countIf(db, catalogTableSet, ["annotation_taxonomy_versions"],
      `SELECT COUNT(*) AS count FROM annotation_taxonomy_versions
        WHERE taxonomy_version='${V04_TAXONOMY_VERSION}' AND status='ACTIVE'`),
    vocabularyActive: await countIf(db, catalogTableSet, ["annotation_vocabulary_versions"],
      `SELECT COUNT(*) AS count FROM annotation_vocabulary_versions
        WHERE vocabulary_version='${V04_VOCABULARY_VERSION}' AND status='ACTIVE'`),
    workflowActive: await countIf(db, catalogTableSet, ["workflow_contract_versions"],
      `SELECT COUNT(*) AS count FROM workflow_contract_versions
        WHERE workflow_version='${V04_WORKFLOW_VERSION}' AND status='ACTIVE'`),
    taxonomyRetired: await countIf(db, catalogTableSet, ["annotation_taxonomy_versions"],
      `SELECT COUNT(*) AS count FROM annotation_taxonomy_versions
        WHERE taxonomy_version='${V04_TAXONOMY_VERSION}' AND status='RETIRED'`),
    vocabularyRetired: await countIf(db, catalogTableSet, ["annotation_vocabulary_versions"],
      `SELECT COUNT(*) AS count FROM annotation_vocabulary_versions
        WHERE vocabulary_version='${V04_VOCABULARY_VERSION}' AND status='RETIRED'`),
    workflowRetired: await countIf(db, catalogTableSet, ["workflow_contract_versions"],
      `SELECT COUNT(*) AS count FROM workflow_contract_versions
        WHERE workflow_version='${V04_WORKFLOW_VERSION}' AND status='RETIRED'`),
    actorSystemAdmin: catalogTableSet.has("app_role_memberships")
      ? numeric((await db.prepare(`SELECT COUNT(*) AS count FROM app_role_memberships
          WHERE user_id=? AND role_key='SYSTEM_ADMIN' AND status='ACTIVE'`)
        .bind(actor.userId).first<CountRow>())?.count)
      : 0,
  };
  const p11Counts = {
    ...Object.fromEntries(historyScopes.map((row) => [row.scope, row.count])),
    ...Object.fromEntries(targetBusiness.rows.map((row) => [`target:${row.scope}`, row.count])),
    ...Object.fromEntries(Object.entries(contractCounts).map(([key, value]) => [`contract:${key}`, value])),
  };
  const totalContentHash = hashV04PreviewValue({
    historyScopes,
    targetBusinessRows: targetBusiness.rows,
    contractCounts,
  });

  const anomalies = [
    anomaly("SNAPSHOT_VERSION_ANOMALY", versionAnomalyIds),
    anomaly("PROMOTED_CURRENT_SNAPSHOT", promotedStreamIds),
    anomaly("REFERENCE_INCONSISTENCY", referenceIds),
    anomaly("SCHEMA_LEDGER_STATE_ANOMALY", ledgerAnomalyIds),
    anomaly("LEGACY_CHOICE_COMBINATION", p08Ids),
    anomaly("LEGACY_ADMIN_AMBIGUOUS", adminMappings.filter((row) => row.classification === "AMBIGUOUS").map((row) => row.stableReferenceId)),
    anomaly("LEGACY_ADMIN_MISSING", adminMappings.filter((row) => row.classification === "MISSING").map((row) => row.stableReferenceId)),
    anomaly("LEGACY_ADMIN_DISABLED", adminMappings.filter((row) => row.classification === "DISABLED").map((row) => row.stableReferenceId)),
    anomaly("PHYSICAL_DELETE_AUDIT", physicalDeleteIds),
    anomaly("DATABASE_ORPHAN", orphanIds),
    anomaly("OBJECT_KEY_ANOMALY", objectKeyIds),
  ].filter((item) => item.count > 0);

  const afterSource = await inPreviewStage("ZERO_WRITE_CHECK", () =>
    scopedHash(db, catalogTableSet, SOURCE_HASH_QUERIES));
  const afterTargetBusiness = await inPreviewStage("ZERO_WRITE_CHECK", () =>
    scopedHash(db, catalogTableSet, TARGET_HASH_QUERIES, { missingAsEmpty: true }));
  const afterNonTarget = await inPreviewStage("ZERO_WRITE_CHECK", () =>
    scopedHash(db, catalogTableSet, NON_TARGET_HASH_QUERIES));
  const afterReadHash = hashV04PreviewValue({
    sourceHash: afterSource.hash,
    targetBusinessHash: afterTargetBusiness.hash,
    nonTargetHash: afterNonTarget.hash,
  });
  const zeroWrite = {
    beforeHash: beforeReadHash,
    afterHash: afterReadHash,
    unchanged: beforeReadHash === afterReadHash,
  };
  const targetBusinessRowCount = targetBusiness.rows.reduce((sum, row) => sum + row.count, 0);
  const stopReasons = sortedUnique([
    ...(schemaState === "DRIFT_OR_PARTIAL" ? ["SCHEMA_DRIFT_OR_PARTIAL"] : []),
    ...(versionAnomalyIds.length ? ["SNAPSHOT_VERSION_ANOMALY"] : []),
    ...(referenceIds.length ? ["REFERENCE_INCONSISTENCY"] : []),
    ...(ledgerAnomalyIds.length ? ["SCHEMA_LEDGER_STATE_ANOMALY"] : []),
    ...(targetBusinessRowCount ? ["V04_BUSINESS_ROWS_PRESENT"] : []),
    ...(!zeroWrite.unchanged ? ["PREVIEW_NOT_ZERO_WRITE"] : []),
    ...(schemaState === "TARGET_APPLIED_EXACT" && contractStatus !== expectedContractStatus
      ? [`V04_CONTRACT_NOT_${expectedContractStatus}`] : []),
    ...(schemaState === "TARGET_APPLIED_EXACT" && (
      contractCounts[`taxonomy${expectedContractStatus[0]}${expectedContractStatus.slice(1).toLowerCase()}` as keyof typeof contractCounts] !== 1
      || contractCounts[`vocabulary${expectedContractStatus[0]}${expectedContractStatus.slice(1).toLowerCase()}` as keyof typeof contractCounts] !== 1
      || contractCounts.vocabularyOptions !== 60
      || contractCounts[`workflow${expectedContractStatus[0]}${expectedContractStatus.slice(1).toLowerCase()}` as keyof typeof contractCounts] !== 1
      || contractCounts.actorSystemAdmin !== 1
    ) ? ["TARGET_SECURITY_OR_CONTRACT_DRIFT"] : []),
  ]);
  const driftIds = schemaState === "DRIFT_OR_PARTIAL"
    ? sortedUnique([
      ...drift.missingTables.map((value) => `missingTable:${value}`),
      ...drift.missingColumns.map((value) => `missingColumn:${value}`),
      ...drift.missingIndexes.map((value) => `missingIndex:${value}`),
      ...drift.missingTriggers.map((value) => `missingTrigger:${value}`),
      ...drift.missingPolicies.map((value) => `missingPolicy:${value}`),
      ...drift.drift,
    ])
    : [];
  if (driftIds.length) anomalies.unshift(anomaly("SCHEMA_DRIFT", driftIds));
  const contract = {
    productVersion: V04_PRODUCT_VERSION,
    taxonomyVersion: V04_TAXONOMY_VERSION,
    workflowVersion: V04_WORKFLOW_VERSION,
    vocabularyVersion: V04_VOCABULARY_VERSION,
    payloadSchemaVersion: V04_PAYLOAD_SCHEMA_VERSION,
    status: contractStatus,
    expectedStatus: expectedContractStatus,
  };
  const tokenFacts = {
    previewSchemaVersion: V04_MIGRATION_PREVIEW_SCHEMA_VERSION,
    scope: V04_MIGRATION_PREVIEW_SCOPE,
    environmentKey,
    actorUserId: actor.userId,
    targetCodeSha,
    bundleHash: V04_SCHEMA_BUNDLE_HASH,
    schemaState,
    contract,
    schemaFingerprint,
    sourceHash: source.hash,
    targetHash,
    nonTargetHash: nonTarget.hash,
    previewWindow,
    p01, p02, snapshotKinds, versionAnomalyIds, promotedStreamIds, referenceIds,
    ledgerRows, ledgerAnomalyIds, drift, p08, p09, physicalDeleteIds, orphanIds, objectKeyIds,
    p11Counts, totalContentHash, zeroWrite, stopReasons,
  };
  const previewToken = `v04_preview_${hashV04PreviewValue(tokenFacts)}`;
  const previewTokenDigest = digestV04PreviewToken(previewToken);
  return {
    previewSchemaVersion: V04_MIGRATION_PREVIEW_SCHEMA_VERSION,
    scope: V04_MIGRATION_PREVIEW_SCOPE,
    generatedAt: now.toISOString(),
    expiresAt: previewWindow.expiresAt,
    environmentKey,
    actorUserId: actor.userId,
    targetCodeSha,
    bundleHash: V04_SCHEMA_BUNDLE_HASH,
    schemaState,
    stopReasons,
    contract,
    ready: stopReasons.length === 0,
    previewToken,
    previewTokenDigest,
    schemaFingerprint,
    sourceHash: source.hash,
    targetHash,
    nonTargetHash: nonTarget.hash,
    facts: {
      P01: p01,
      P02: p02,
      P03: { snapshotKinds, versionAnomalies: versionAnomalyIds.length },
      P04: { promotedCurrentSnapshotCount: promotedStreamIds.length, stableStreamIds: promotedStreamIds },
      P05: { referenceAnomalyCount: referenceIds.length, stableObjectIds: referenceIds },
      P06: { ledgerRows, ledgerAnomalies: ledgerAnomalyIds.length },
      P07: drift,
      P08: p08,
      P09: p09,
      P10: {
        physicalDeleteAuditCount: physicalDeleteIds.length,
        databaseOrphanCount: orphanIds.length,
        objectKeyAnomalyCount: objectKeyIds.length,
        cosOrphanStatus: "NOT_CONFIRMABLE_FROM_DATABASE",
      },
      P11: { objectCounts: p11Counts, totalContentHash },
    },
    zeroWrite,
    anomalies,
  };
}
