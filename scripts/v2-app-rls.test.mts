/**
 * seer_app RLS is dual-mode: unset seer.account_id keeps today's open access
 * so pooled cron queries still see every mailbox. SET LOCAL scopes a
 * transaction to one account without breaking existing callers.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";

const db = await startTestDb();
try {
  const userA = await upsertUser("app-rls-a@rditrials.com");
  const userB = await upsertUser("app-rls-b@rditrials.com");
  const accountA = await upsertAccount({
    userId: userA,
    provider: "google",
    email: "app-rls-a@rditrials.com",
  });
  const accountB = await upsertAccount({
    userId: userB,
    provider: "google",
    email: "app-rls-b@rditrials.com",
  });

  await db.pool.query("set role seer_app");
  try {
    const open = await db.pool.query<{ email: string }>(
      "select email from seer.mail_accounts where email like 'app-rls-%' order by email",
    );
    assert.deepEqual(
      open.rows.map((r) => r.email),
      ["app-rls-a@rditrials.com", "app-rls-b@rditrials.com"],
      "unset seer.account_id must keep seeing every mailbox",
    );

    await db.pool.query("begin");
    try {
      await db.pool.query("select set_config('seer.account_id', $1, true)", [accountA]);
      const scoped = await db.pool.query<{ email: string }>(
        "select email from seer.mail_accounts where email like 'app-rls-%' order by email",
      );
      assert.deepEqual(
        scoped.rows.map((r) => r.email),
        ["app-rls-a@rditrials.com"],
        "SET LOCAL seer.account_id must hide the other mailbox",
      );
      const otherConv = await db.pool.query(
        `insert into seer.conversations (account_id, provider_conversation_id, subject, folders, is_unread)
         values ($1, 'other-app-rls', 'nope', array['inbox'], false)`,
        [accountB],
      ).then(
        () => false,
        () => true,
      );
      assert.equal(otherConv, true, "cannot insert a conversation for another account when scoped");
    } finally {
      await db.pool.query("rollback");
    }
  } finally {
    await db.pool.query("reset role");
  }

  console.log("v2-app-rls: OK");
} finally {
  await db.stop();
}
