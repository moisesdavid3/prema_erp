import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema";

export type DbInstance = PostgresJsDatabase<typeof schema>;

const isWorker = typeof (globalThis as { caches?: unknown }).caches !== "undefined";

export const dbContext = new AsyncLocalStorage<DbInstance>();

export function createDbConnection(): { sql: Sql; db: DbInstance } {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database?",
    );
  }

  const sql = postgres(process.env.DATABASE_URL, {
    prepare: false,
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
  });
  return { sql, db: drizzle(sql, { schema }) };
}

let fallbackDb: DbInstance | undefined;

function defaultDb(): DbInstance {
  if (isWorker) {
    throw new Error("No database connection available outside a request in a worker.");
  }
  if (!fallbackDb) {
    fallbackDb = createDbConnection().db;
  }
  return fallbackDb;
}

export function getDb(): DbInstance {
  return dbContext.getStore() ?? defaultDb();
}

export * from "./schema";
