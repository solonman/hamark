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

export const V04_MIGRATION_PREVIEW_SCHEMA_VERSION = "V04_MIGRATION_PREVIEW_V1" as const;
export const V04_MIGRATION_PREVIEW_SCOPE = "GLOBAL_V04_LEGACY_READ_PREVIEW" as const;
export const V04_MIGRATION_PREVIEW_TTL_MS = 30 * 60 * 1000;

type CountRow = QueryResultRow & { count: number | string };
type HashRow = QueryResultRow & { row_count: number | string; aggregate_hash: string };
type CatalogTableRow = QueryResultRow & { table_name: string; rls_enabled: boolean };
type CatalogColumnRow = QueryResultRow & {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};
type CatalogNamedRow = QueryResultRow & { table_name: string; object_name: string; definition?: string };

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
  contract: {
    productVersion: typeof V04_PRODUCT_VERSION;
    taxonomyVersion: typeof V04_TAXONOMY_VERSION;
    workflowVersion: typeof V04_WORKFLOW_VERSION;
    vocabularyVersion: typeof V04_VOCABULARY_VERSION;
    payloadSchemaVersion: typeof V04_PAYLOAD_SCHEMA_VERSION;
    status: string;
  };
  ready: boolean;
  previewToken: string;
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
      missingTables: string[];
      extraTables: string[];
      missingColumns: string[];
      extraColumns: string[];
      missingTriggers: string[];
      extraTriggers: string[];
      missingIndexes: string[];
      extraIndexes: string[];
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
  anomalies: V04MigrationPreviewAnomaly[];
};

const EXPECTED_TABLES = [...V04_SCHEMA_TABLES, "admin_data_operations"].sort();
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
    if (!EXPECTED_TABLES.includes(table as typeof EXPECTED_TABLES[number])) return;
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

const EXPECTED_INDEXES = [
  "collaboration_rounds_one_active_idx",
  "collaboration_revision_events_round_idx",
  "collaboration_revision_events_target_idx",
  "collaboration_edit_leases_one_active_idx",
  "expert_analysis_releases_one_active_idx",
].sort();

const EXPECTED_TRIGGERS = [
  "admin_data_operations_immutable",
  "annotation_choice_values_validate",
  "collaboration_workspaces_relation_guard",
  "collaboration_baselines_relation_guard",
  "collaboration_rounds_relation_guard",
  "annotation_submission_snapshots_relation_guard",
  "collaboration_revision_events_relation_guard",
  "collaboration_edit_leases_relation_guard",
  "expert_analysis_releases_relation_guard",
  "collaboration_baselines_immutable",
  "annotation_submission_snapshots_immutable",
  "collaboration_revision_events_immutable",
  "annotation_snapshots_v04_working_immutable",
  "expert_analysis_releases_immutable",
  "schema_migration_operations_immutable",
  "annotation_taxonomy_versions_v04_immutable",
  "annotation_vocabulary_versions_immutable",
  "workflow_contract_versions_immutable",
  "annotation_vocabulary_options_immutable",
].sort();

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
  ["annotations:legacy", `SELECT * FROM annotations WHERE COALESCE(workflow_version, '') <> '${V04_WORKFLOW_VERSION}'`],
  ["annotation_snapshots:legacy", `SELECT * FROM annotation_snapshots WHERE COALESCE(workflow_version, '') <> '${V04_WORKFLOW_VERSION}'`],
  ["shots:legacy", `SELECT s.* FROM shots s JOIN annotations a ON a.id=s.annotation_id WHERE COALESCE(a.workflow_version, '') <> '${V04_WORKFLOW_VERSION}'`],
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
  ["annotation_snapshots:v04", `SELECT * FROM annotation_snapshots WHERE workflow_version='${V04_WORKFLOW_VERSION}'`],
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
  ["videos", "SELECT * FROM videos"],
  ["users", "SELECT id,status,identity_key,display_name,email FROM users"],
  ["app_admins", "SELECT * FROM app_admins"],
  ["audit_logs", "SELECT * FROM audit_logs"],
  ["admin_data_operations", "SELECT * FROM admin_data_operations"],
  ["schema_migration_operations", "SELECT * FROM schema_migration_operations"],
  ["annotation_taxonomy_versions", "SELECT * FROM annotation_taxonomy_versions"],
  ["annotation_vocabulary_versions", "SELECT * FROM annotation_vocabulary_versions"],
  ["annotation_vocabulary_options", "SELECT * FROM annotation_vocabulary_options"],
  ["workflow_contract_versions", "SELECT * FROM workflow_contract_versions"],
  ["app_role_memberships", "SELECT * FROM app_role_memberships"],
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

function numeric(value: number | string | null | undefined) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values.filter(Boolean))].sort();
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
) {
  const rows: Array<{ scope: string; count: number; hash: string }> = [];
  for (const [scope, query] of queries) {
    const table = tableFromQuery(query);
    if (!catalogTables.has(table)) {
      rows.push({ scope, count: 0, hash: "MISSING_TABLE" });
      continue;
    }
    rows.push({ scope, ...(await tableHash(db, query)) });
  }
  return { hash: hashV04PreviewValue(rows), rows };
}

async function loadCatalog(db: DbClient) {
  const tables = (await db.prepare(`SELECT c.relname AS table_name,
      c.relrowsecurity AS rls_enabled
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')
    ORDER BY c.relname`).all<CatalogTableRow>()).results;
  const columns = (await db.prepare(`SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema=current_schema()
    ORDER BY table_name,ordinal_position`).all<CatalogColumnRow>()).results;
  const indexes = (await db.prepare(`SELECT tablename AS table_name,indexname AS object_name,indexdef AS definition
    FROM pg_indexes WHERE schemaname=current_schema() ORDER BY tablename,indexname`)
    .all<CatalogNamedRow>()).results;
  const triggers = (await db.prepare(`SELECT c.relname AS table_name,t.tgname AS object_name,
      pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND NOT t.tgisinternal
    ORDER BY c.relname,t.tgname`).all<CatalogNamedRow>()).results;
  const policies = (await db.prepare(`SELECT tablename AS table_name,policyname AS object_name,
      COALESCE(cmd,'') || ':' || COALESCE(qual,'') || ':' || COALESCE(with_check,'') AS definition
    FROM pg_policies WHERE schemaname=current_schema() ORDER BY tablename,policyname`)
    .all<CatalogNamedRow>()).results;
  return { tables, columns, indexes, triggers, policies };
}

function schemaDrift(catalog: Awaited<ReturnType<typeof loadCatalog>>) {
  const existingTables = new Set(catalog.tables.map((row) => row.table_name));
  const relevantTables = catalog.tables.map((row) => row.table_name)
    .filter((name) => V04_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix)));
  const missingTables = EXPECTED_TABLES.filter((name) => !existingTables.has(name));
  const extraTables = relevantTables.filter((name) => !EXPECTED_TABLES.includes(name as typeof EXPECTED_TABLES[number]));
  const columnNames = new Set(catalog.columns.map((row) => `${row.table_name}.${row.column_name}`));
  const missingColumns = [...EXPECTED_COLUMN_MAP].flatMap(([table, columns]) =>
    [...columns].filter((column) => !columnNames.has(`${table}.${column}`)).map((column) => `${table}.${column}`));
  const extraColumns = catalog.columns.filter((row) => {
    const expected = EXPECTED_COLUMN_MAP.get(row.table_name);
    return expected && !expected.has(row.column_name);
  }).map((row) => `${row.table_name}.${row.column_name}`);
  const relevantIndexes = catalog.indexes.filter((row) => EXPECTED_TABLES.includes(row.table_name as typeof EXPECTED_TABLES[number]));
  const actualIndexNames = relevantIndexes.map((row) => row.object_name);
  const missingIndexes = EXPECTED_INDEXES.filter((name) => !actualIndexNames.includes(name));
  const extraIndexes = actualIndexNames.filter((name) =>
    (name.endsWith("_idx") || name.includes("_one_active_")) && !EXPECTED_INDEXES.includes(name));
  const relevantTriggers = catalog.triggers.filter((row) =>
    EXPECTED_TABLES.includes(row.table_name as typeof EXPECTED_TABLES[number]) || row.table_name === "annotation_snapshots" || row.table_name === "annotation_taxonomy_versions");
  const actualTriggerNames = relevantTriggers.map((row) => row.object_name);
  const missingTriggers = EXPECTED_TRIGGERS.filter((name) => !actualTriggerNames.includes(name));
  const extraTriggers = actualTriggerNames.filter((name) =>
    (name.includes("v04") || name.includes("collaboration") || name.includes("schema_migration") || name.includes("vocabulary") || name === "admin_data_operations_immutable") &&
    !EXPECTED_TRIGGERS.includes(name));
  const unexpectedPolicies = catalog.policies
    .filter((row) => EXPECTED_TABLES.includes(row.table_name as typeof EXPECTED_TABLES[number]))
    .map((row) => `${row.table_name}.${row.object_name}`);
  const rlsDisabledTables = catalog.tables
    .filter((row) => EXPECTED_TABLES.includes(row.table_name as typeof EXPECTED_TABLES[number]) && !row.rls_enabled)
    .map((row) => row.table_name);
  return {
    missingTables: sortedUnique(missingTables),
    extraTables: sortedUnique(extraTables),
    missingColumns: sortedUnique(missingColumns),
    extraColumns,
    missingTriggers: sortedUnique(missingTriggers),
    extraTriggers: sortedUnique(extraTriggers),
    missingIndexes: sortedUnique(missingIndexes),
    extraIndexes: sortedUnique(extraIndexes),
    unexpectedPolicies: sortedUnique(unexpectedPolicies),
    rlsDisabledTables: sortedUnique(rlsDisabledTables),
  };
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

function stableEnvironmentKey() {
  return process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown";
}

export function assertV04PreviewToken(current: V04MigrationPreview, suppliedToken: string) {
  if (!suppliedToken || suppliedToken !== current.previewToken) {
    throw new V04ServiceError("STALE_PREVIEW", "PREVIEW 事实已变化，请重新执行只读 PREVIEW。", {
      currentPreviewToken: current.previewToken,
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

export async function previewV04Migration(
  db: DbClient,
  actor: { userId: string },
  options: { now?: Date; environmentKey?: string } = {},
): Promise<V04MigrationPreview> {
  const admin = await db.prepare(`SELECT 1 FROM app_role_memberships
    WHERE user_id=? AND role_key='SYSTEM_ADMIN' AND status='ACTIVE'`).bind(actor.userId).first();
  if (!admin) throw new V04ServiceError("ADMIN_REQUIRED", "仅稳定系统管理员可查看 V0.4 迁移 PREVIEW。");

  const now = options.now ?? new Date();
  const environmentKey = options.environmentKey ?? stableEnvironmentKey();
  const catalog = await loadCatalog(db);
  const catalogTableSet = new Set(catalog.tables.map((row) => row.table_name));
  const drift = schemaDrift(catalog);
  const schemaFingerprint = hashV04PreviewValue({
    tables: catalog.tables,
    columns: catalog.columns,
    indexes: catalog.indexes,
    triggers: catalog.triggers,
    policies: catalog.policies,
  });
  const schemaDriftCount = Object.values(drift).reduce((sum, values) => sum + values.length, 0);
  if (schemaDriftCount > 0) {
    const contractStatus = catalogTableSet.has("workflow_contract_versions")
      ? (await db.prepare(`SELECT status FROM workflow_contract_versions WHERE workflow_version=?`)
        .bind(V04_WORKFLOW_VERSION).first<{ status: string } & QueryResultRow>())?.status ?? "MISSING"
      : "MISSING";
    const unavailableHash = hashV04PreviewValue({ schemaFingerprint, status: "SCHEMA_DRIFT" });
    const driftIds = sortedUnique(Object.entries(drift).flatMap(([kind, values]) =>
      values.map((value) => `${kind}:${value}`)));
    const contract = {
      productVersion: V04_PRODUCT_VERSION,
      taxonomyVersion: V04_TAXONOMY_VERSION,
      workflowVersion: V04_WORKFLOW_VERSION,
      vocabularyVersion: V04_VOCABULARY_VERSION,
      payloadSchemaVersion: V04_PAYLOAD_SCHEMA_VERSION,
      status: contractStatus,
    };
    const previewToken = `v04_preview_${hashV04PreviewValue({
      previewSchemaVersion: V04_MIGRATION_PREVIEW_SCHEMA_VERSION,
      scope: V04_MIGRATION_PREVIEW_SCOPE,
      environmentKey,
      actorUserId: actor.userId,
      contract,
      schemaFingerprint,
      drift,
    })}`;
    return {
      previewSchemaVersion: V04_MIGRATION_PREVIEW_SCHEMA_VERSION,
      scope: V04_MIGRATION_PREVIEW_SCOPE,
      generatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + V04_MIGRATION_PREVIEW_TTL_MS).toISOString(),
      environmentKey,
      actorUserId: actor.userId,
      contract,
      ready: false,
      previewToken,
      schemaFingerprint,
      sourceHash: unavailableHash,
      targetHash: unavailableHash,
      nonTargetHash: unavailableHash,
      facts: {
        P01: { businessVideos: 0, v02Annotations: 0, v03Annotations: 0, v04Annotations: 0 },
        P02: { v03Streams: 0, v04Workspaces: 0, canonicalAnnotations: 0, activeRounds: 0, logicalEmptyBusinessVideos: 0 },
        P03: { snapshotKinds: {}, versionAnomalies: 0 },
        P04: { promotedCurrentSnapshotCount: 0, stableStreamIds: [] },
        P05: { referenceAnomalyCount: 0, stableObjectIds: [] },
        P06: { ledgerRows: {}, ledgerAnomalies: 0 },
        P07: drift,
        P08: { legacyCustomMarkers: 0, pendingMechanisms: 0, customTextPresent: 0, structuredLegacyRawValues: 0, stableAnnotationIds: [] },
        P09: { classifications: { UNIQUE: 0, AMBIGUOUS: 0, MISSING: 0, DISABLED: 0 }, mappings: [] },
        P10: { physicalDeleteAuditCount: 0, databaseOrphanCount: 0, objectKeyAnomalyCount: 0, cosOrphanStatus: "NOT_CONFIRMABLE_FROM_DATABASE" },
        P11: { objectCounts: {}, totalContentHash: hashV04PreviewValue([]) },
      },
      anomalies: [{ type: "SCHEMA_DRIFT", count: driftIds.length, stableIds: driftIds }],
    };
  }
  const source = await scopedHash(db, catalogTableSet, SOURCE_HASH_QUERIES);
  const target = await scopedHash(db, catalogTableSet, TARGET_HASH_QUERIES);
  const nonTarget = await scopedHash(db, catalogTableSet, NON_TARGET_HASH_QUERIES);

  const businessVideos = await count(db, "SELECT COUNT(*) AS count FROM videos WHERE data_scope='BUSINESS'");
  const annotationRows = (await db.prepare(`SELECT COALESCE(a.workflow_version,'UNKNOWN') AS key,
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
    v03Streams: await count(db, "SELECT COUNT(*) AS count FROM v03_collaboration_streams"),
    v04Workspaces: await count(db, "SELECT COUNT(*) AS count FROM collaboration_workspaces"),
    canonicalAnnotations: await count(db, "SELECT COUNT(DISTINCT canonical_annotation_id) AS count FROM collaboration_workspaces"),
    activeRounds: await count(db, "SELECT COUNT(*) AS count FROM collaboration_rounds WHERE status='ACTIVE'"),
    logicalEmptyBusinessVideos: await count(db, `SELECT COUNT(*) AS count FROM videos v
      WHERE v.data_scope='BUSINESS' AND v.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM collaboration_workspaces w WHERE w.video_id=v.id AND w.workflow_version='${V04_WORKFLOW_VERSION}'
      )`),
  };

  const snapshotRows = (await db.prepare(`SELECT COALESCE(snapshot_kind,'UNKNOWN') AS key,
      COUNT(*)::bigint AS count FROM annotation_snapshots GROUP BY COALESCE(snapshot_kind,'UNKNOWN') ORDER BY key`)
    .all<{ key: string; count: number | string } & QueryResultRow>()).results;
  const snapshotKinds = Object.fromEntries(snapshotRows.map((row) => [row.key, numeric(row.count)]));
  const versionAnomalyIds = await ids(db, `SELECT id FROM annotation_snapshots s WHERE
      (s.version_number IS NOT NULL AND s.version_number <= 0)
      OR (s.version_number IS NOT NULL AND EXISTS (
        SELECT 1 FROM annotation_snapshots x WHERE x.annotation_id=s.annotation_id
          AND x.version_number=s.version_number AND x.id<>s.id
      )) ORDER BY id`);
  const promotedStreamIds = await ids(db, `SELECT stream.id FROM v03_collaboration_streams stream
    JOIN annotation_snapshots snapshot ON snapshot.id=stream.current_snapshot_id
    WHERE snapshot.snapshot_kind IN ('CANDIDATE','APPROVED','SUBMISSION')
      OR snapshot.workflow_status IN ('APPROVED','CANDIDATE') ORDER BY stream.id`);

  const referenceIds = sortedUnique([
    ...(await ids(db, `SELECT 'release:'||r.id AS id FROM approved_analysis_releases r
      LEFT JOIN annotation_snapshots approved ON approved.id=r.approved_snapshot_id
      LEFT JOIN annotation_snapshots source ON source.id=r.source_snapshot_id
      LEFT JOIN analysis_review_rounds review ON review.id=r.source_review_round_id
      WHERE approved.id IS NULL OR source.id IS NULL OR review.id IS NULL
        OR approved.annotation_id<>r.annotation_id OR source.annotation_id<>r.annotation_id
        OR review.annotation_id<>r.annotation_id`)),
    ...(await ids(db, `SELECT 'stream:'||s.id AS id FROM v03_collaboration_streams s
      LEFT JOIN annotations a ON a.id=s.canonical_annotation_id
      LEFT JOIN v03_collaboration_rounds round ON round.id=s.active_round_id
      LEFT JOIN approved_analysis_releases release ON release.id=s.active_release_id
      WHERE a.id IS NULL OR a.video_id<>s.video_id
        OR (s.active_round_id IS NOT NULL AND (round.id IS NULL OR round.stream_id<>s.id))
        OR (s.active_release_id IS NOT NULL AND (release.id IS NULL OR release.video_id<>s.video_id))`)),
    ...(await ids(db, `SELECT 'workspace:'||w.id AS id FROM collaboration_workspaces w
      LEFT JOIN annotations a ON a.id=w.canonical_annotation_id
      LEFT JOIN collaboration_rounds round ON round.id=w.active_round_id
      LEFT JOIN annotation_submission_snapshots submission ON submission.id=w.latest_submission_snapshot_id
      LEFT JOIN expert_analysis_releases release ON release.id=w.active_expert_release_id
      WHERE a.id IS NULL OR a.video_id<>w.video_id OR a.workflow_version<>w.workflow_version
        OR (w.active_round_id IS NOT NULL AND (round.id IS NULL OR round.workspace_id<>w.id))
        OR (w.latest_submission_snapshot_id IS NOT NULL AND (submission.id IS NULL OR submission.workspace_id<>w.id))
        OR (w.active_expert_release_id IS NOT NULL AND (release.id IS NULL OR release.workspace_id<>w.id))`)),
  ]);

  const ledgerRows = Object.fromEntries((await db.prepare(`SELECT 'admin:'||status AS key,COUNT(*)::bigint AS count
      FROM admin_data_operations GROUP BY status
      UNION ALL SELECT 'schema:'||operation_type||':'||status AS key,COUNT(*)::bigint
      FROM schema_migration_operations GROUP BY operation_type,status ORDER BY key`)
    .all<{ key: string; count: number | string } & QueryResultRow>()).results
    .map((row) => [row.key, numeric(row.count)]));
  const ledgerAnomalyIds = await ids(db, `SELECT id FROM schema_migration_operations
    WHERE (operation_type='SCHEMA_PREVIEW' AND status<>'PREVIEWED')
      OR (operation_type IN ('SCHEMA_APPLY','CONTRACT_ACTIVATE') AND status NOT IN ('PREVIEWED','APPLYING','APPLIED','FAILED'))
    ORDER BY id`);

  const p08Ids = await ids(db, `SELECT annotation_id AS id FROM annotation_creative_structures
    WHERE mechanism_primary IN ('__CUSTOM__','其他','其他（自定义机制）')
      OR story_reference_type IN ('__CUSTOM__','其他','其他（自定义参照类型）')
      OR mechanism_auxiliary_json LIKE '%待形成新机制%'
      OR mechanism_custom<>''`);
  const p08 = {
    legacyCustomMarkers: await count(db, `SELECT COUNT(*) AS count FROM annotation_creative_structures
      WHERE mechanism_primary IN ('__CUSTOM__','其他','其他（自定义机制）')
        OR story_reference_type IN ('__CUSTOM__','其他','其他（自定义参照类型）')`),
    pendingMechanisms: await count(db, `SELECT COUNT(*) AS count FROM annotation_creative_structures
      WHERE mechanism_primary='现有词表不适用／待形成新机制'
        OR mechanism_auxiliary_json LIKE '%待形成新机制%'`),
    customTextPresent: await count(db, "SELECT COUNT(*) AS count FROM annotation_creative_structures WHERE mechanism_custom<>''"),
    structuredLegacyRawValues: await count(db, "SELECT COUNT(*) AS count FROM annotation_choice_values WHERE legacy_raw_value IS NOT NULL"),
    stableAnnotationIds: p08Ids,
  };

  const users = (await db.prepare("SELECT id,email,display_name,status FROM users ORDER BY id")
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

  const physicalDeleteIds = await ids(db, `SELECT id FROM audit_logs WHERE
    action ILIKE '%PHYSICAL%DELETE%' OR action ILIKE '%PURGE%' OR action ILIKE '%ASSET%DELETE%' ORDER BY id`);
  const orphanIds = sortedUnique([
    ...(await ids(db, "SELECT 'annotation:'||a.id AS id FROM annotations a LEFT JOIN videos v ON v.id=a.video_id WHERE v.id IS NULL")),
    ...(await ids(db, "SELECT 'snapshot:'||s.id AS id FROM annotation_snapshots s LEFT JOIN annotations a ON a.id=s.annotation_id LEFT JOIN videos v ON v.id=s.video_id WHERE a.id IS NULL OR v.id IS NULL")),
    ...(await ids(db, "SELECT 'shot:'||s.id AS id FROM shots s LEFT JOIN annotations a ON a.id=s.annotation_id WHERE a.id IS NULL")),
    ...(await ids(db, "SELECT 'audit-video:'||a.id AS id FROM audit_logs a LEFT JOIN videos v ON v.id=a.object_id WHERE a.object_type='VIDEO' AND v.id IS NULL")),
  ]);
  const objectKeyIds = await ids(db, `SELECT id FROM videos WHERE object_key='' OR object_key IS NULL
    OR EXISTS (SELECT 1 FROM videos other WHERE other.id<>videos.id AND other.object_key=videos.object_key)
    OR thumbnail_key=object_key ORDER BY id`);

  const historyScopes = source.rows.filter((row) => [
    "annotation_snapshots:legacy", "approved_analysis_releases", "v03_collaboration_baselines",
  ].includes(row.scope));
  const p11Counts = Object.fromEntries(historyScopes.map((row) => [row.scope, row.count]));
  const totalContentHash = hashV04PreviewValue(historyScopes);

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

  const contract = await db.prepare(`SELECT status FROM workflow_contract_versions
    WHERE workflow_version=?`).bind(V04_WORKFLOW_VERSION).first<{ status: string } & QueryResultRow>();
  const blockingCount = schemaDriftCount + versionAnomalyIds.length + referenceIds.length + ledgerAnomalyIds.length;
  const tokenFacts = {
    previewSchemaVersion: V04_MIGRATION_PREVIEW_SCHEMA_VERSION,
    scope: V04_MIGRATION_PREVIEW_SCOPE,
    environmentKey,
    actorUserId: actor.userId,
    contract: {
      productVersion: V04_PRODUCT_VERSION,
      taxonomyVersion: V04_TAXONOMY_VERSION,
      workflowVersion: V04_WORKFLOW_VERSION,
      vocabularyVersion: V04_VOCABULARY_VERSION,
      payloadSchemaVersion: V04_PAYLOAD_SCHEMA_VERSION,
      status: contract?.status ?? "MISSING",
    },
    schemaFingerprint,
    sourceHash: source.hash,
    targetHash: target.hash,
    nonTargetHash: nonTarget.hash,
    p01, p02, snapshotKinds, versionAnomalyIds, promotedStreamIds, referenceIds,
    ledgerRows, ledgerAnomalyIds, drift, p08, p09, physicalDeleteIds, orphanIds, objectKeyIds,
    p11Counts, totalContentHash,
  };
  const previewToken = `v04_preview_${hashV04PreviewValue(tokenFacts)}`;
  return {
    previewSchemaVersion: V04_MIGRATION_PREVIEW_SCHEMA_VERSION,
    scope: V04_MIGRATION_PREVIEW_SCOPE,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + V04_MIGRATION_PREVIEW_TTL_MS).toISOString(),
    environmentKey,
    actorUserId: actor.userId,
    contract: tokenFacts.contract,
    ready: blockingCount === 0 && contract?.status === "DRAFT",
    previewToken,
    schemaFingerprint,
    sourceHash: source.hash,
    targetHash: target.hash,
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
    anomalies,
  };
}
