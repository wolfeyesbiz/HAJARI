import { PGlite } from "@electric-sql/pglite";

const dir = "./data/pglite-diagnostic-empty";
let db;

try {
  db = await PGlite.create(dir);
  const result = await db.query("SELECT version()");
  console.log("TEST PASSED: PGlite initialized and executed SQL.");
  console.log(result.rows[0].version);
} catch (error) {
  console.error("TEST FAILED:", error);
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
