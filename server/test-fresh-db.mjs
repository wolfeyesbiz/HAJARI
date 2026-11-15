import { PGlite } from "@electric-sql/pglite";
import { resolve } from "node:path";

const dir = resolve("./data/hajari-fresh-test");
let db;

try {
  db = await PGlite.create(dir);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { SCHEMA_V1 } = await import("./dist/db/schema.js");
  await db.exec(SCHEMA_V1);

  const result = await db.query(`
    SELECT COUNT(*)::int AS total
    FROM information_schema.tables
    WHERE table_schema = 'public'
  `);

  console.log("TEST DATABASE CREATED SUCCESSFULLY");
  console.log("Public tables:", result.rows[0].total);
} catch (err) {
  console.error("TEST FAILED:", err.message);
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
