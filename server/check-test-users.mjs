import { PGlite } from "@electric-sql/pglite";
const db = await PGlite.create("./data/hajari-fresh-test");
try {
  const r = await db.query("SELECT COUNT(*)::int AS total FROM users");
  console.log("Users in test database:", r.rows[0].total);
} catch (e) {
  console.log("Check failed:", e.message);
} finally {
  await db.close();
}
