import { PGlite } from "@electric-sql/pglite";

let db;

try {
  db = await PGlite.create("./data/pg-diagnostic-copy", {
    debug: 1
  });

  const result = await db.query("SELECT version()");
  console.log("DATABASE OPENED:", result.rows);
} catch (error) {
  console.error("DATABASE OPEN FAILED:");
  console.error(error);
  process.exitCode = 1;
} finally {
  if (db) {
    try {
      await db.close();
    } catch (error) {
      console.error("Close error:", error.message);
    }
  }
}
