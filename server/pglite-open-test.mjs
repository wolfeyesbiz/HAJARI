import { PGlite } from "@electric-sql/pglite";

let db;

try {
  db = await PGlite.create("./data/pg-diagnostic-copy");
  const result = await db.query("SELECT current_database()");
  console.log("EXISTING DATABASE COPY OPENED SUCCESSFULLY.");
  console.log(result.rows);
} catch (error) {
  console.error("FAILED TO OPEN DATABASE COPY:");
  console.error(error);
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
