import { PGlite } from "@electric-sql/pglite";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const candidates = ["data/pglite-test", "data/attendease-test"];

for (const candidate of candidates) {
  const source = resolve(candidate);
  const temp = mkdtempSync(join(tmpdir(), "hajari-db-check-"));
  let db;

  try {
    cpSync(source, join(temp, "db"), { recursive: true });
    db = await PGlite.create(join(temp, "db"));
    const result = await db.query(
      "SELECT current_database() AS db, COUNT(*) AS tables FROM information_schema.tables WHERE table_schema = 'public'"
    );
    console.log(`PASS ${candidate}:`, result.rows);
  } catch (err) {
    console.log(`FAIL ${candidate}:`, err.message);
  } finally {
    try { if (db) await db.close(); } catch {}
    try { rmSync(temp, { recursive: true, force: true }); } catch {}
  }
}
