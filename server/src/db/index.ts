import { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';

/**
 * Database layer.
 *
 * The sandbox has no root access, so a system PostgreSQL cannot be installed.
 * We therefore run PGlite — the *real* PostgreSQL engine compiled to WASM — with an
 * on-disk data directory, which gives us actual PostgreSQL semantics (partial unique
 * indexes, transactions, constraints) plus file persistence across restarts.
 *
 * Set DB_DRIVER=postgres + DATABASE_URL to point at a managed PostgreSQL instance
 * in production; the SQL in db/schema.ts is plain PostgreSQL and runs unchanged.
 */
type DbQueryResult<T> = { rows: T[] };
interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<DbQueryResult<T>>;
}
interface Db {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<DbQueryResult<T>>;
  transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

let instance: Db | null = null;

function pgResult<T>(result: QueryResult): DbQueryResult<T> {
  return { rows: result.rows as T[] };
}

async function createPostgresDb(): Promise<Db> {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required when DB_DRIVER=postgres.');
  const pool = new Pool({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: false } });
  return {
    exec: async (sql) => { await pool.query(sql); },
    query: async <T>(sql: string, params: unknown[] = []) => pgResult<T>(await pool.query(sql, params)),
    transaction: async <T>(fn: (client: DbClient) => Promise<T>) => {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async <R>(sql: string, params: unknown[] = []) => pgResult<R>(await client.query(sql, params)),
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: async () => { await pool.end(); },
  };
}

export async function getDb(): Promise<Db> {
  if (!instance) {
    if (config.dbDriver === 'postgres') {
      instance = await createPostgresDb();
    } else {
      const dir = resolve(process.cwd(), config.dataDir);
      mkdirSync(dir, { recursive: true });
      const pglite = await PGlite.create(dir);
      instance = {
        exec: (sql) => pglite.exec(sql),
        query: async <T>(sql: string, params: unknown[] = []) => {
          const result = await pglite.query<T>(sql, params);
          return { rows: result.rows as T[] };
        },
        transaction: (fn) => pglite.transaction((tx) => fn(tx)),
        close: () => pglite.close(),
      };
    }
  }
  return instance;
}

export type Sql = string;
export type Params = unknown[];

export async function q<T = Record<string, unknown>>(sql: Sql, params: Params = []): Promise<T[]> {
  const db = await getDb();
  try {
    const res = await db.query<T>(sql, params);
    return res.rows as T[];
  } catch (err) {
    console.error('[sql-error]', (err as Error).message, '\nSQL:', sql.replace(/\s+/g, ' ').slice(0, 400), '\nPARAMS:', JSON.stringify(params));
    throw err;
  }
}

export async function one<T = Record<string, unknown>>(sql: Sql, params: Params = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

export async function scalar<T = unknown>(sql: Sql, params: Params = []): Promise<T | null> {
  const row = await one<Record<string, unknown>>(sql, params);
  if (!row) return null;
  const values = Object.values(row);
  return (values[0] as T) ?? null;
}

export interface Tx {
  q<T = Record<string, unknown>>(sql: Sql, params?: Params): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: Sql, params?: Params): Promise<T | null>;
}

/** Run a callback inside a real PostgreSQL transaction (rollback on throw). */
export async function tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
  const db = await getDb();
  return (await db.transaction(async (t) => {
    const helper: Tx = {
      q: async <R = Record<string, unknown>>(sql: string, params: Params = []) => {
        const res = await t.query<R>(sql, params);
        return res.rows as R[];
      },
      one: async <R = Record<string, unknown>>(sql: string, params: Params = []) => {
        const res = await t.query<R>(sql, params);
        return (res.rows[0] as R) ?? null;
      },
    };
    return fn(helper);
  })) as T;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}
