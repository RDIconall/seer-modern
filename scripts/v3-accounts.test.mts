/**
 * Task 8 gate: relational accounts are canonical and account management is
 * owner-scoped. Secrets may be decrypted inside server-only code, but neither
 * account APIs nor persisted rows expose them.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestDb } from "./v2-testdb.mts";
import { asAccountId } from "../src/lib/v2/db/types.ts";

const accounts = await import("../src/lib/v2/db/accounts.ts");
const legacy = await import("../src/lib/store/accounts.ts");
const db = await startTestDb();

try {
  assert.equal(typeof accounts.listOwnedAccounts, "function");
  assert.equal(typeof accounts.deleteOwnedAccount, "function");
  assert.equal(typeof accounts.upsertAccountWithCredentials, "function");
  assert.equal(typeof accounts.normalizeEpochMs, "function");

  const userA = await accounts.upsertUser("task8-a@example.com");
  const userB = await accounts.upsertUser("task8-b@example.com");
  const accountA = await accounts.upsertAccountWithCredentials({
    userId: userA,
    provider: "google",
    email: "mail-a@example.com",
    displayName: "Mailbox A",
    accessToken: "access-a",
    refreshToken: "refresh-a",
    expiresAt: 1_800_000_000,
  });
  const accountB = await accounts.upsertAccountWithCredentials({
    userId: userB,
    provider: "microsoft",
    email: "mail-b@example.com",
    accessToken: "access-b",
    refreshToken: "refresh-b",
    expiresAt: Date.now() + 3_600_000,
  });

  const ownedA = await accounts.listOwnedAccounts(userA);
  assert.deepEqual(ownedA.map((account) => account.id), [accountA.id]);
  assert.equal(ownedA[0]?.email, "mail-a@example.com");

  assert.equal(
    await accounts.deleteOwnedAccount(userA, accountB.id),
    false,
    "a user cannot remove another user's account",
  );
  assert.ok(await accounts.getOwnedAccount(userB, accountB.id));

  const rawA = await accounts.rawCredentialRow(accountA.id);
  assert.doesNotMatch(rawA, /access-a|refresh-a/);
  const credentialA = await accounts.getCredentials(accountA.id);
  assert.equal(credentialA?.accessToken, "access-a");
  assert.equal(credentialA?.refreshToken, "refresh-a");
  assert.equal(credentialA?.expiresAt, 1_800_000_000_000);
  assert.equal(accounts.normalizeEpochMs(1_800_000_000), 1_800_000_000_000);
  assert.equal(accounts.normalizeEpochMs(1_800_000_000_000), 1_800_000_000_000);

  // OAuth refresh responses commonly omit refresh_token. The canonical row
  // must retain the previous refresh token instead of silently losing it.
  await accounts.saveCredentials(accountA.id, "google", {
    accessToken: "access-a-rotated",
    expiresAt: Date.now() + 3_600_000,
  });
  const rotated = await accounts.getCredentials(accountA.id);
  assert.equal(rotated?.accessToken, "access-a-rotated");
  assert.equal(rotated?.refreshToken, "refresh-a");

  const apiSource = await fs.readFile(
    path.join(process.cwd(), "src/app/api/v3/accounts/route.ts"),
    "utf8",
  );
  assert.match(apiSource, /listOwnedAccounts/);
  assert.match(apiSource, /deleteOwnedAccount/);
  assert.match(apiSource, /confirmed/);
  assert.doesNotMatch(
    apiSource,
    /accessToken|refreshToken|ciphertext/,
    "account API must not serialize credential fields",
  );

  const sessionSource = await fs.readFile(
    path.join(process.cwd(), "src/lib/mail/session.ts"),
    "utf8",
  );
  assert.match(sessionSource, /getOwnedAccount|listOwnedAccounts/);
  assert.match(sessionSource, /SEER_V3_LEGACY_ACCOUNT_FALLBACK/);
  assert.match(sessionSource, /legacyAccountFallbackEnabled/);

  const storeSource = await fs.readFile(
    path.join(process.cwd(), "src/lib/store/accounts.ts"),
    "utf8",
  );
  assert.match(storeSource, /SEER_V3_LEGACY_ACCOUNT_FALLBACK/);

  const migrationSource = await fs.readFile(
    path.join(process.cwd(), "scripts/migrate-v3-accounts.mts"),
    "utf8",
  );
  assert.match(migrationSource, /--apply/);
  assert.match(migrationSource, /dry-run|dryRun/);
  assert.match(migrationSource, /upsertAccountWithCredentials/);

  const settingsSource = await fs.readFile(
    path.join(process.cwd(), "src/components/v3/Settings.tsx"),
    "utf8",
  );
  for (const label of ["Current account", "Reconnect", "Add account", "Remove", "Switch", "Sign out"]) {
    assert.match(settingsSource, new RegExp(label, "i"));
  }

  assert.equal(await accounts.deleteOwnedAccount(userA, accountA.id), true);
  assert.equal(
    await accounts.getOwnedAccount(userA, asAccountId(accountA.id)),
    null,
  );
  assert.ok(await accounts.getOwnedAccount(userB, accountB.id));

  // The legacy fallback is opt-in and never enabled implicitly.
  const previous = process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK;
  delete process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK;
  assert.equal(legacy.legacyAccountFallbackEnabled(), false);
  if (previous === undefined) delete process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK;
  else process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK = previous;

  console.log("v3-accounts: OK");
} finally {
  await db.stop();
}
