/**
 * Gate: the application connects with the least privilege that still works.
 *
 * The app previously connected as `postgres` — a role that bypasses RLS, owns
 * every table, and can run DDL. A single injection or a leaked connection
 * string was therefore full control of the database. It now connects as
 * `seer_app`, which can read and write the corpus and nothing else.
 *
 * This test runs only when SEER_APP_DATABASE_URL is provided (CI/ops), because
 * it needs a live connection; it is skipped silently otherwise so the suite
 * stays runnable on a laptop.
 */
import assert from "node:assert/strict";
import { Pool } from "pg";
import { resolveSsl } from "../src/lib/v2/db/pool.ts";

const url = process.env.SEER_APP_DATABASE_URL;
if (!url) {
  console.log("role-least-privilege: skipped (no SEER_APP_DATABASE_URL)");
  process.exit(0);
}

const { connectionString, ssl } = resolveSsl(url);
const pool = new Pool({ connectionString, ssl, max: 1, connectionTimeoutMillis: 10_000 });

async function allowed(sql: string): Promise<boolean> {
  try {
    await pool.query(sql);
    return true;
  } catch {
    return false;
  }
}

try {
  const who = await pool.query<{ current_user: string; bypasses_rls: boolean }>(
    "select current_user, (select rolbypassrls from pg_roles where rolname = current_user) as bypasses_rls",
  );
  assert.notEqual(
    who.rows[0].current_user,
    "postgres",
    "the app must not connect as the owning role",
  );
  assert.equal(
    who.rows[0].bypasses_rls,
    false,
    "the app role must not bypass row level security",
  );

  // It must still be able to do its job.
  assert.ok(await allowed("select 1 from seer.conversations limit 1"), "must read mail");
  assert.ok(await allowed("select 1 from seer.oauth_credentials limit 1"), "must read credentials");
  assert.ok(await allowed("select 1 from public.seer_kv limit 1"), "must read the legacy store");

  // And nothing more.
  assert.equal(await allowed("create table seer.evil (x int)"), false, "must not create tables");
  assert.equal(await allowed("drop table seer.messages"), false, "must not drop tables");
  assert.equal(await allowed("select 1 from auth.users limit 1"), false, "must not read auth");
  assert.equal(await allowed("alter role seer_app with bypassrls"), false, "must not escalate");
  assert.equal(await allowed("select rolpassword from pg_authid limit 1"), false, "must not read password hashes");

  console.log("role-least-privilege: ok");
} finally {
  await pool.end();
}
