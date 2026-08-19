import type { DbClient } from "@/db";
import { ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS } from "@/db/admin-data-operation-schema";

// Static compatibility markers for the existing production safety regression.
// The executable DDL has a single source in db/admin-data-operation-schema.ts.
export const ADMIN_DATA_OPERATION_SCHEMA_INVARIANTS = [
  "backup_json JSONB NOT NULL",
  "ALTER TABLE admin_data_operations ENABLE ROW LEVEL SECURITY",
  "completed administrator data operations are permanently locked",
] as const;

export async function installAdminDataOperationSchema(db: DbClient) {
  for (const statement of ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS) {
    await db.prepare(statement).run();
  }
}
