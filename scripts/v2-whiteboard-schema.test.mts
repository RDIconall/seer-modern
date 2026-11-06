import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";

const TABLES = ["whiteboard_sections", "whiteboard_items"];

const db = await startTestDb();
try {
  const tables = await db.pool.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'seer'",
  );
  const names = new Set(tables.rows.map((row) => row.table_name));
  for (const table of TABLES) {
    assert.ok(names.has(table), `missing seer.${table}`);
  }

  const extras = await db.pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'seer' and table_name = 'bot_tasks'
        and column_name in ('whiteboard_slug', 'conversation_id')`,
  );
  assert.equal(extras.rows.length, 2, "bot_tasks gained additive whiteboard columns");

  const rls = await db.pool.query<{ relname: string; relrowsecurity: boolean }>(
    `select c.relname, c.relrowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'seer' and c.relkind = 'r' and c.relname = any($1::text[])`,
    [TABLES],
  );
  for (const row of rls.rows) {
    assert.equal(row.relrowsecurity, true, `RLS on seer.${row.relname}`);
  }

  const userId = await upsertUser("board-schema@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "board-schema@example.com",
  });

  await db.pool.query("set role seer_bot");
  try {
    await db.pool.query(
      `insert into seer.whiteboard_sections (account_id, slug, title, sort_order)
       values ($1, 'due-now', 'Due Now', 10)
       on conflict (account_id, slug) do nothing`,
      [accountId],
    );
    const section = await db.pool.query<{ id: string }>(
      `select id from seer.whiteboard_sections where account_id = $1 and slug = 'due-now'`,
      [accountId],
    );
    await db.pool.query(
      `insert into seer.whiteboard_items (account_id, section_id, external_key, title, source)
       values ($1, $2, 'W001', 'From the bot', 'bot')`,
      [accountId, section.rows[0].id],
    );
    const canInsertMail = await db.pool.query<{ allowed: boolean }>(
      "select has_table_privilege(current_user, 'seer.conversations', 'insert') as allowed",
    );
    assert.equal(
      canInsertMail.rows[0].allowed,
      false,
      "seer_bot must not have INSERT on conversations",
    );
  } finally {
    await db.pool.query("reset role");
  }

  for (const role of ["anon", "authenticated"]) {
    const allowed = await db.pool.query<{ allowed: boolean }>(
      "select has_table_privilege($1, 'seer.whiteboard_items', 'select') as allowed",
      [role],
    );
    assert.equal(allowed.rows[0].allowed, false, `${role} must not read whiteboard_items`);
  }

  console.log("v2-whiteboard-schema: OK");
} finally {
  await db.stop();
}
