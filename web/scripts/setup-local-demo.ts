import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { applySchema } from "../db/bootstrap.ts";
import { getDbClient } from "../db/index.ts";
import { isLocalDemoMode } from "../lib/local-demo.ts";
import { copyFileToLocalObject } from "../storage/local.ts";

type SqliteValue = string | number | null;
type SqliteRow = Record<string, SqliteValue>;

const importTables = [
  "videos",
  "annotations",
  "shots",
  "field_answers",
  "annotation_snapshots",
  "assignment_reviews",
  "assignment_review_snapshots",
  "audit_logs",
] as const;

if (!isLocalDemoMode()) {
  throw new Error("Set LOCAL_DEMO_MODE=1 before preparing the local demo.");
}

const legacyRoot = path.join(process.cwd(), ".wrangler", "state", "v3");
const files = await walkFiles(legacyRoot);
const d1Database = files.find(
  (file) =>
    file.includes(`${path.sep}d1${path.sep}`) &&
    file.endsWith(".sqlite") &&
    path.basename(file) !== "metadata.sqlite",
);
const r2Database = files.find(
  (file) =>
    file.includes(`${path.sep}r2${path.sep}`) &&
    file.endsWith(".sqlite") &&
    path.basename(file) !== "metadata.sqlite",
);

if (!d1Database || !r2Database) {
  throw new Error("Legacy local demo database or object registry was not found under .wrangler/state/v3.");
}

await applySchema();
const db = getDbClient();
let importedRows = 0;

await db.withTransaction(async (transaction) => {
  for (const table of importTables) {
    const rows = sqliteJson(d1Database, `SELECT * FROM \"${table}\"`);
    for (const row of rows) {
      const columns = Object.keys(row);
      if (columns.length === 0) continue;
      const identifiers = columns.map(quoteIdentifier).join(", ");
      const placeholders = columns.map(() => "?").join(", ");
      await transaction
        .prepare(
          `INSERT INTO ${quoteIdentifier(table)} (${identifiers}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        )
        .bind(...columns.map((column) => row[column]))
        .run();
      importedRows += 1;
    }
  }
});

const r2Objects = sqliteJson(
  r2Database,
  "SELECT key, blob_id, http_metadata FROM _mf_objects ORDER BY key",
);
let copiedObjects = 0;
for (const object of r2Objects) {
  const key = typeof object.key === "string" ? object.key : "";
  const blobId = typeof object.blob_id === "string" ? object.blob_id : "";
  if (!key || !blobId) continue;
  const blob = files.find(
    (file) => file.includes(`${path.sep}r2${path.sep}`) && path.basename(file) === blobId,
  );
  if (!blob) {
    throw new Error(`Legacy object blob is missing for ${key}.`);
  }
  const httpMetadata = parseJsonObject(object.http_metadata);
  await copyFileToLocalObject(blob, key, {
    contentType:
      typeof httpMetadata.contentType === "string"
        ? httpMetadata.contentType
        : "application/octet-stream",
  });
  copiedObjects += 1;
}

console.log(`Local demo ready: ${importedRows} legacy rows checked, ${copiedObjects} media objects copied.`);

function sqliteJson(database: string, sql: string): SqliteRow[] {
  const output = execFileSync("sqlite3", ["-json", database, sql], {
    encoding: "utf8",
  }).trim();
  return output ? (JSON.parse(output) as SqliteRow[]) : [];
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function parseJsonObject(value: SqliteValue) {
  if (typeof value !== "string") return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {} as Record<string, unknown>;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name);
      return entry.isDirectory() ? walkFiles(target) : [target];
    }),
  );
  return nested.flat();
}
