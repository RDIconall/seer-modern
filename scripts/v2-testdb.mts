/**
 * Shared test harness: boot a real, throwaway PostgreSQL, apply the committed
 * migrations, and hand back a `pg` Pool bound into the v2 db module. Using a
 * genuine Postgres (not an emulator) means the same DDL and SQL that runs on
 * Supabase runs in tests — RLS, arrays, partial indexes, `gen_random_uuid`
 * and all. The production connection string is a Sensitive Vercel secret and
 * is intentionally never needed here.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { setPoolForTesting } from "../src/lib/v2/db/pool.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, "..", "supabase", "migrations");

export type TestDb = {
  pool: Pool;
  stop: () => Promise<void>;
};

let portCounter = 55432 + Math.floor(Math.random() * 2000);

export async function startTestDb(): Promise<TestDb> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "seer-v2-pg-"));
  const port = portCounter++;
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    // Keep the initdb/pg_ctl banner out of test output.
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("seer_test");

  const pool = new Pool({
    host: "localhost",
    port,
    user: "postgres",
    password: "postgres",
    database: "seer_test",
  });

  await applyMigrations(pool);
  setPoolForTesting(pool);

  return {
    pool,
    stop: async () => {
      setPoolForTesting(null);
      await pool.end();
      await pg.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function applyMigrations(pool: Pool): Promise<void> {
  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await pool.query(sql);
  }
}
