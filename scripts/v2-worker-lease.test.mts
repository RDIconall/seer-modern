/** Gate: only one read (or sync) hop runs per mailbox at a time. */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import {
  claimWorkerLease,
  releaseWorkerLease,
} from "../src/lib/v2/cron/lease.ts";

const database = await startTestDb();
try {
  const userId = await upsertUser("lease@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "microsoft",
    email: "lease@example.com",
  });

  assert.equal(await claimWorkerLease(accountId, "read"), true);
  assert.equal(
    await claimWorkerLease(accountId, "read"),
    false,
    "a live lease refuses a second hop",
  );
  assert.equal(
    await claimWorkerLease(accountId, "sync"),
    true,
    "read and sync are separate pipes",
  );

  await releaseWorkerLease(accountId, "read");
  assert.equal(await claimWorkerLease(accountId, "read"), true);

  await database.pool.query(
    `update seer.worker_leases
        set expires_at = now() - interval '1 second'
      where account_id = $1 and kind = 'read'`,
    [accountId],
  );
  assert.equal(
    await claimWorkerLease(accountId, "read"),
    true,
    "an expired lease is stolen so a killed hop cannot stall the desk",
  );

  console.log("v2-worker-lease: OK");
} finally {
  await database.stop();
}
