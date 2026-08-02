import pg from "pg";
import { getRequiredEnv } from "@/lib/env";
import { CosVideoBucket } from "@/storage/cos";
import { translateSqlPlaceholders } from "./sql";

type QueryValue = string | number | boolean | null;
type QueryClient = pg.Pool | pg.PoolClient;

export type QueryResultRow = Record<string, unknown>;

export type DbAllResult<T> = {
  results: T[];
};

export type DbRunResult = {
  success: boolean;
  meta: {
    rows_read: number;
    rows_written: number;
  };
};

const { Pool } = pg;

let pool: pg.Pool | null = null;

function normalizeSql(sql: string) {
  return sql.replace(/\bCURRENT_TIMESTAMP\b/g, "(CURRENT_TIMESTAMP::text)");
}

export { translateSqlPlaceholders };

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getRequiredEnv("DATABASE_URL"),
      ssl:
        process.env.SUPABASE_DB_SSL === "false"
          ? false
          : { rejectUnauthorized: false },
      max: Number(process.env.DATABASE_POOL_MAX || 5),
    });
  }
  return pool;
}

export class DbPreparedStatement {
  private values: QueryValue[] = [];
  private readonly client: QueryClient;
  private readonly sql: string;

  constructor(client: QueryClient, sql: string) {
    this.client = client;
    this.sql = sql;
  }

  bind(...values: QueryValue[]) {
    this.values = values;
    return this;
  }

  private queryText() {
    return translateSqlPlaceholders(normalizeSql(this.sql));
  }

  withClient(client: QueryClient) {
    return new DbPreparedStatement(client, this.sql).bind(...this.values);
  }

  async all<T extends QueryResultRow = QueryResultRow>(): Promise<DbAllResult<T>> {
    const result = await this.client.query<T>(this.queryText(), this.values);
    return { results: result.rows };
  }

  async first<T extends QueryResultRow = QueryResultRow>(): Promise<T | null> {
    const result = await this.client.query<T>(this.queryText(), this.values);
    return result.rows[0] ?? null;
  }

  async run(): Promise<DbRunResult> {
    const result = await this.client.query(this.queryText(), this.values);
    return {
      success: true,
      meta: {
        rows_read: 0,
        rows_written: result.rowCount ?? 0,
      },
    };
  }
}

export class DbClient {
  private readonly client: pg.Pool;

  constructor(client: pg.Pool) {
    this.client = client;
  }

  prepare(sql: string) {
    return new DbPreparedStatement(this.client, sql);
  }

  async batch(statements: DbPreparedStatement[]) {
    const client = await this.client.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const statement of statements) {
        results.push(await statement.withClient(client).run());
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

let db: DbClient | null = null;
let videoBucket: CosVideoBucket | null = null;

export function getDbClient() {
  if (!db) {
    db = new DbClient(getPool());
  }
  return db;
}

export function getVideoBucket() {
  if (!videoBucket) {
    videoBucket = new CosVideoBucket();
  }
  return videoBucket;
}
