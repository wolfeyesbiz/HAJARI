import { PGlite } from "@electric-sql/pglite";

let db;

try {
  db = await PGlite.create("./data/pg-recovery-test", { debug: 1 });
  const result = await db.query("SELECT current_database(), version()");
  console.log("RECOVERY TEST PASSED");
  console.log(result.rows);
} catch (error) {
  console.error("RECOVERY TEST FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  if (db) {
    try {
      await db.close();
    } catch {}
  }
}
