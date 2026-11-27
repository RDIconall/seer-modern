/**
 * The person's own wording for a matter's next step: it is stored on the
 * matter, trimmed, bounded, clearable, scoped to the account, and it replaces
 * Seer's reading on the matter board's `nextAction` until it is cleared.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";

const db = await startTestDb();
try {
  const userId = await upsertUser("next-step@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "next-step@example.com",
  });
  const otherUser = await upsertUser("other-next-step@example.com");
  const otherAccount = await upsertAccount({
    userId: otherUser,
    provider: "google",
    email: "other-next-step@example.com",
  });
  const ctx = { accountId, provider: new FakeProvider({ conversations: [] }) };

  const matter = await db.pool.query<{ id: string }>(
    "insert into seer.matters (account_id, title) values ($1, 'Roche MSA') returning id",
    [accountId],
  );
  const matterId = matter.rows[0].id;
  const stored = async () =>
    (
      await db.pool.query<{ next_step_user: string | null; next_step_user_at: Date | null }>(
        "select next_step_user, next_step_user_at from seer.matters where id = $1",
        [matterId],
      )
    ).rows[0];

  const set = await executeCommand(
    ctx,
    { type: "setMatterNextStep", matterId, text: "  Call Roche legal first  " },
    "step-set",
  );
  assert.equal(set.ok, true);
  assert.deepEqual(set.processed, [matterId]);
  let row = await stored();
  assert.equal(row.next_step_user, "Call Roche legal first", "wording is trimmed");
  assert.ok(row.next_step_user_at, "the time of the edit is kept");

  const tooLong = await executeCommand(
    ctx,
    { type: "setMatterNextStep", matterId, text: "x".repeat(281) },
    "step-long",
  );
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error ?? "", /too long/);
  assert.equal((await stored()).next_step_user, "Call Roche legal first", "a refused edit changes nothing");

  const foreign = await executeCommand(
    { accountId: otherAccount, provider: ctx.provider },
    { type: "setMatterNextStep", matterId, text: "Hijacked" },
    "step-foreign",
  );
  assert.equal(foreign.ok, false);
  assert.match(foreign.error ?? "", /not found/);
  assert.equal((await stored()).next_step_user, "Call Roche legal first", "another account cannot edit it");

  const blank = await executeCommand(
    ctx,
    { type: "setMatterNextStep", matterId, text: "   " },
    "step-blank",
  );
  assert.equal(blank.ok, true);
  row = await stored();
  assert.equal(row.next_step_user, null, "blank wording hands the step back to Seer");
  assert.equal(row.next_step_user_at, null);

  const cleared = await executeCommand(
    ctx,
    { type: "setMatterNextStep", matterId, text: null },
    "step-null",
  );
  assert.equal(cleared.ok, true);

  console.log("v2-matter-next-step: ok");
} finally {
  await db.stop();
}
