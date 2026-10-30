import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  const done = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

// CLI entry: `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  migrate(pool)
    .then((a) => console.log(a.length ? `applied: ${a.join(", ")}` : "up to date"))
    .finally(() => pool.end());
}
