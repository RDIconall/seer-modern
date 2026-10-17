import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";

const STAFF = [
  "bots",
  "bot_tasks",
  "bot_task_events",
  "bot_messages",
  "triage_proposals",
];

const db = await startTestDb();
try {
  const tables = await db.pool.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'seer'",
  );
  const names = new Set(tables.rows.map((row) => row.table_name));
  for (const table of STAFF) {
    assert.ok(names.has(table), `missing seer.${table}`);
  }

  const rls = await db.pool.query<{ relname: string; relrowsecurity: boolean }>(
    `select c.relname, c.relrowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'seer' and c.relkind = 'r' and c.relname = any($1::text[])`,
    [STAFF],
  );
  for (const row of rls.rows) {
    assert.equal(row.relrowsecurity, true, `RLS on seer.${row.relname}`);
  }

  const bots = await db.pool.query<{ slug: string }>(
    "select slug from seer.bots order by slug",
  );
  assert.ok(
    bots.rows.some((row) => row.slug === "chief-of-staff"),
    "catalog includes Chief of staff",
  );

  const userId = await upsertUser("staff-schema@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "staff-schema@example.com",
  });
  const bot = await db.pool.query<{ id: string }>(
    "select id from seer.bots where slug = 'chief-of-staff'",
  );

  await db.pool.query(
    "insert into seer.bot_allowed_accounts (account_id) values ($1) on conflict do nothing",
    [accountId],
  );

  await db.pool.query("set role seer_bot");
  try {
    await db.pool.query(
      `insert into seer.bot_tasks (account_id, bot_id, title, source)
       values ($1, $2, 'From the bot', 'bot')`,
      [accountId, bot.rows[0].id],
    );
    const canInsertMail = await db.pool.query<{ allowed: boolean }>(
      "select has_table_privilege(current_user, 'seer.conversations', 'insert') as allowed",
    );
    assert.equal(
      canInsertMail.rows[0].allowed,
      false,
      "seer_bot must not have INSERT on conversations",
    );
    let denied = false;
    try {
      await db.pool.query(
        `insert into seer.conversations
           (account_id, provider_conversation_id, subject, folders, is_unread)
         values ($1, 'pc-bot-forbidden', 'nope', array['inbox'], false)`,
        [accountId],
      );
    } catch {
      denied = true;
    }
    assert.equal(denied, true, "seer_bot must not write the mail corpus");
  } finally {
    await db.pool.query("reset role");
  }

  let badStatus = false;
  try {
    await db.pool.query(
      `insert into seer.bot_tasks (account_id, bot_id, title, status, source)
       values ($1, $2, 'Bad', 'working', 'bot')`,
      [accountId, bot.rows[0].id],
    );
  } catch {
    badStatus = true;
  }
  assert.equal(badStatus, true, "status check constraint holds");

  for (const role of ["anon", "authenticated"]) {
    const allowed = await db.pool.query<{ allowed: boolean }>(
      "select has_table_privilege($1, 'seer.bot_tasks', 'select') as allowed",
      [role],
    );
    assert.equal(allowed.rows[0].allowed, false, `${role} must not read bot_tasks`);
  }

  console.log("v2-staff-schema: OK");
} finally {
  await db.stop();
}
