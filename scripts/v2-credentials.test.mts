/**
 * Task 2 gate: provider secrets are encrypted at rest and account-scoped, and
 * a user cannot read another user's account. Runs against embedded Postgres.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import {
  encryptCredential,
  decryptCredential,
} from "../src/lib/v2/crypto/credentials.ts";
import {
  upsertUser,
  upsertAccount,
  getOwnedAccount,
  saveCredentials,
  getCredentials,
  rotateCredentials,
  rawCredentialRow,
} from "../src/lib/v2/db/accounts.ts";
import { asAccountId } from "../src/lib/v2/db/types.ts";
import { applyPreservedIntent } from "../src/lib/v2/db/intent.ts";

const db = await startTestDb();
try {
  // --- Encryption primitives -------------------------------------------------
  const enc = encryptCredential("refresh-token-abc", "acct-1");
  assert.notEqual(enc.ciphertext, "refresh-token-abc");
  assert.equal(decryptCredential(enc, "acct-1"), "refresh-token-abc");

  // Wrong account id (AAD) must fail authentication, not silently decrypt.
  assert.throws(
    () => decryptCredential(enc, "acct-2"),
    /auth/i,
    "ciphertext must not decrypt under a different account id",
  );

  // Tampered ciphertext must fail authentication.
  const tampered = { ...enc, ciphertext: enc.ciphertext.slice(0, -2) + "AA" };
  assert.throws(() => decryptCredential(tampered, "acct-1"), /auth|bad|unable|invalid/i);

  // --- Repository isolation --------------------------------------------------
  const userA = await upsertUser("a@example.com");
  const userB = await upsertUser("b@example.com");
  const accountB = await upsertAccount({
    userId: userB,
    provider: "google",
    email: "mailbox-b@example.com",
  });

  // userA must not be able to read userB's account.
  assert.equal(await getOwnedAccount(userA, accountB), null);
  const owned = await getOwnedAccount(userB, accountB);
  assert.equal(owned?.email, "mailbox-b@example.com");

  // --- Secrets persisted encrypted ------------------------------------------
  await saveCredentials(accountB, "google", {
    accessToken: "access-xyz",
    refreshToken: "refresh-xyz",
    expiresAt: Date.now() + 3_600_000,
  });

  const raw = await rawCredentialRow(accountB);
  assert.ok(!raw.includes("refresh-xyz"), "refresh token must not be stored in plaintext");
  assert.ok(!raw.includes("access-xyz"), "access token must not be stored in plaintext");

  const round = await getCredentials(accountB);
  assert.equal(round?.refreshToken, "refresh-xyz");
  assert.equal(round?.accessToken, "access-xyz");
  assert.equal(round?.version, 1);

  // --- Optimistic rotation ---------------------------------------------------
  const okRotate = await rotateCredentials(accountB, 1, {
    accessToken: "access-2",
    expiresAt: Date.now() + 3_600_000,
  });
  assert.equal(okRotate, true);

  // A stale version loses the race and does not clobber.
  const staleRotate = await rotateCredentials(accountB, 1, {
    accessToken: "access-STALE",
  });
  assert.equal(staleRotate, false);

  const after = await getCredentials(accountB);
  assert.equal(after?.accessToken, "access-2");
  assert.equal(after?.refreshToken, "refresh-xyz");
  assert.equal(after?.version, 2);

  // A missing account yields null, not a throw.
  assert.equal(await getCredentials(asAccountId("00000000-0000-0000-0000-000000000000")), null);

  // --- Option B intent preservation -----------------------------------------
  const counts = await applyPreservedIntent(accountB, {
    vips: [{ email: "chair@board.example.com", name: "Sandy Chair" }],
    corrections: [{ messageId: "msg-1", action: "act_today" }],
    senderTeachings: [{ email: "list@news.example.com", action: "unsubscribe" }],
    interests: [{ topic: "clinical trial operations" }],
    manualMatters: [
      { title: "Roche anti-TPO pricing", orgUnit: "sales", conversationProviderIds: [] },
    ],
    closures: [{ title: "Old vendor dispute", reason: "settled" }],
  });
  assert.deepEqual(counts, {
    vips: 1,
    corrections: 1,
    senderTeachings: 1,
    interests: 1,
    manualMatters: 1,
    manualLinks: 0,
    closures: 1,
  });

  // The VIP became a real, user-sourced person row (not inferred).
  const vip = await db.pool.query(
    "select vip, vip_source, tier from seer.people where account_id = $1 and email = $2",
    [accountB, "chair@board.example.com"],
  );
  assert.equal(vip.rows[0].vip, true);
  assert.equal(vip.rows[0].vip_source, "user");

  // The hand-named matter is user-sourced, so a rebuild must not overwrite it.
  const matter = await db.pool.query(
    "select title_source from seer.matters where account_id = $1 and title = $2",
    [accountB, "Roche anti-TPO pricing"],
  );
  assert.equal(matter.rows[0].title_source, "user");

  // No inferred decision, brief, or tier leaked in: only intent was written.
  const decisions = await db.pool.query(
    "select count(*)::int as n from seer.conversation_decisions where account_id = $1",
    [accountB],
  );
  assert.equal(decisions.rows[0].n, 0, "migration must not create inferred decisions");

  // Re-running is idempotent (events dedupe on their keys).
  await applyPreservedIntent(accountB, {
    vips: [],
    corrections: [{ messageId: "msg-1", action: "act_today" }],
    senderTeachings: [],
    interests: [],
    manualMatters: [],
    closures: [],
  });
  const events = await db.pool.query(
    "select count(*)::int as n from seer.events where account_id = $1 and kind = 'user_correction'",
    [accountB],
  );
  assert.equal(events.rows[0].n, 1, "re-running preserves, does not duplicate");

  console.log("v2-credentials: OK");
} finally {
  await db.stop();
}
