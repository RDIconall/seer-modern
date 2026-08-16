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
import { seal } from "../src/lib/store/secret-at-rest.ts";

const accounts = await import("../src/lib/v2/db/accounts.ts");
const v2Session = await import("../src/lib/v2/session.ts");
const origin = await import("../src/lib/security/origin.ts");
const dataDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-v3-accounts-"));
process.env.SEER_DATA_DIR = dataDir;
process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK = "1";
const legacy = await import("../src/lib/store/accounts.ts");
const kv = await import("../src/lib/store/kv.ts");
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
  const accountA2 = await accounts.upsertAccountWithCredentials({
    userId: userA,
    provider: "microsoft",
    email: "linked-b@example.com",
    displayName: "Mailbox A2",
    accessToken: "access-a2",
    refreshToken: "refresh-a2",
    expiresAt: Date.now() + 3_600_000,
  });

  const ownedA = await accounts.listOwnedAccounts(userA);
  assert.deepEqual(ownedA.map((account) => account.id), [accountA2.id, accountA.id]);
  assert.equal(ownedA[1]?.email, "mail-a@example.com");
  assert.deepEqual(
    (await accounts.listOwnedAccounts(userB)).map((account) => account.id),
    [accountB.id],
    "mailbox B linked by owner A remains invisible to owner B",
  );
  assert.equal(v2Session.selectV2Account(ownedA, accountA2.id, "mail-a@example.com")?.id, accountA2.id);
  assert.equal(v2Session.selectV2Account(ownedA, accountB.id, "mail-a@example.com")?.id, accountA.id);
  assert.equal(typeof v2Session.effectiveActiveAccountId, "function");
  assert.equal(
    v2Session.effectiveActiveAccountId(ownedA, null, "mail-a@example.com"),
    accountA.id,
    "removing the displayed fallback account must require sign-out",
  );
  assert.equal(
    v2Session.selectV2Account(
      await accounts.listOwnedAccounts(userB),
      accountA2.id,
      "mail-b@example.com",
    )?.id,
    accountB.id,
    "a foreign active cookie must fall back within the signed-in owner",
  );
  assert.equal(
    origin.originAllowed({
      origin: "https://mail.example.com",
      requestOrigin: "https://mail.example.com",
      production: true,
    }),
    true,
  );
  assert.equal(
    origin.originAllowed({
      origin: null,
      requestOrigin: "https://mail.example.com",
      production: true,
    }),
    false,
    "production mutations require Origin",
  );
  assert.equal(
    origin.originAllowed({
      origin: "https://evil.example",
      requestOrigin: "https://mail.example.com",
      production: true,
    }),
    false,
    "cross-origin mutations are rejected",
  );
  const previousAllowlist = process.env.SEER_V2_ACCOUNT_ALLOWLIST;
  process.env.SEER_V2_ACCOUNT_ALLOWLIST = "task8-a@example.com";
  assert.equal(v2Session.isV2Enabled("task8-a@example.com"), true);
  assert.equal(
    v2Session.isV2Enabled("task8-b@example.com"),
    false,
    "unallowlisted signed-in users must not enter V3 account management",
  );
  if (previousAllowlist === undefined) delete process.env.SEER_V2_ACCOUNT_ALLOWLIST;
  else process.env.SEER_V2_ACCOUNT_ALLOWLIST = previousAllowlist;

  assert.equal(
    await accounts.deleteOwnedAccount(userA, accountB.id),
    false,
    "a user cannot remove another user's account",
  );
  assert.ok(await accounts.getOwnedAccount(userB, accountB.id));

  // Legacy fallback opens sealed records but never crosses the authenticated
  // owner boundary or chooses the first global token.
  await kv.kvSet("accounts", {
    accounts: [
      {
        id: "google:owner@example.com",
        provider: "google",
        email: "owner@example.com",
        name: "Owner",
        accessToken: seal("legacy-owner-access", "google:owner@example.com"),
        refreshToken: seal("legacy-owner-refresh", "google:owner@example.com"),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "google:other@example.com",
        provider: "google",
        email: "other@example.com",
        name: "Other",
        accessToken: seal("legacy-other-access", "google:other@example.com"),
        refreshToken: seal("legacy-other-refresh", "google:other@example.com"),
        updatedAt: new Date().toISOString(),
      },
    ],
  });
  assert.equal(typeof legacy.selectOwnedAccount, "function");
  const hydratedLegacy = await legacy.listAccountsWithTokens();
  const ownerFallback = legacy.selectOwnedAccount(
    hydratedLegacy,
    "owner@example.com",
    null,
  );
  assert.equal(ownerFallback?.email, "owner@example.com");
  assert.equal(ownerFallback?.accessToken, "legacy-owner-access");
  assert.equal(
    legacy.selectOwnedAccount(hydratedLegacy, "missing@example.com", null),
    null,
    "legacy fallback must not select another user's first token",
  );
  const migratedUser = await accounts.upsertUser("owner@example.com");
  const migratedAccount = await accounts.upsertAccountWithCredentials({
    userId: migratedUser,
    provider: "google",
    email: ownerFallback!.email,
    accessToken: ownerFallback!.accessToken,
    refreshToken: ownerFallback!.refreshToken,
    expiresAt: ownerFallback!.expiresAt,
  });
  const migratedCredentials = await accounts.getCredentials(migratedAccount.id);
  assert.equal(migratedCredentials?.accessToken, "legacy-owner-access");
  assert.equal(migratedCredentials?.refreshToken, "legacy-owner-refresh");

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
  assert.equal(
    (await accounts.listOwnedAccounts(userA)).find((account) => account.id === accountA.id)?.status,
    "active",
  );

  // A failed refresh is durable per account and never exposes its error as a
  // credential or account secret.
  await accounts.saveCredentials(accountA.id, "google", {
    accessToken: "expired-access",
    expiresAt: Date.now() - 1,
  });
  const tokenService = await import("../src/lib/v2/providers/token-service.ts");
  await assert.rejects(
    tokenService.freshAccessToken(accountA.id, "google", async () => {
      throw new Error("invalid_grant");
    }),
    /invalid_grant/,
  );
  const reconnectRequired = (await accounts.listOwnedAccounts(userA)).find(
    (account) => account.id === accountA.id,
  );
  assert.equal(reconnectRequired?.status, "reconnect_required");
  await accounts.saveCredentials(accountA.id, "google", {
    accessToken: "healthy-access",
    expiresAt: Date.now() + 3_600_000,
  });
  const healthy = (await accounts.listOwnedAccounts(userA)).find(
    (account) => account.id === accountA.id,
  );
  assert.equal(healthy?.status, "active");

  const apiSource = await fs.readFile(
    path.join(process.cwd(), "src/app/api/v3/accounts/route.ts"),
    "utf8",
  );
  assert.match(apiSource, /listOwnedAccounts/);
  assert.match(apiSource, /deleteOwnedAccount/);
  assert.match(apiSource, /confirmed/);
  assert.match(apiSource, /requiresSignOut/);
  assert.match(apiSource, /originAllowed/);
  assert.match(apiSource, /isV2Enabled/);
  const serializerSource = apiSource.slice(
    apiSource.indexOf("function publicAccount"),
    apiSource.indexOf("async function currentUser"),
  );
  assert.doesNotMatch(
    serializerSource,
    /accessToken|refreshToken|ciphertext/,
    "account API must not serialize credential fields",
  );
  assert.match(serializerSource, /status/);
  assert.doesNotMatch(serializerSource, /lastError|last_error/);

  const sessionSource = await fs.readFile(
    path.join(process.cwd(), "src/lib/mail/session.ts"),
    "utf8",
  );
  assert.match(sessionSource, /getOwnedAccount|listOwnedAccounts/);
  assert.match(sessionSource, /SEER_V3_LEGACY_ACCOUNT_FALLBACK/);
  assert.match(sessionSource, /legacyAccountFallbackEnabled/);

  const v2SessionSource = await fs.readFile(
    path.join(process.cwd(), "src/lib/v2/session.ts"),
    "utf8",
  );
  assert.match(v2SessionSource, /getActiveAccountId/);
  assert.match(v2SessionSource, /listOwnedAccounts|getOwnedAccount/);
  assert.match(v2SessionSource, /fallback|cookie/i);

  const authSource = await fs.readFile(
    path.join(process.cwd(), "src/auth.ts"),
    "utf8",
  );
  assert.match(authSource, /upsertAccountWithCredentials/);
  assert.match(authSource, /consumeAccountLinkState/);
  assert.match(authSource, /ownerUserId/);
  assert.match(authSource, /token\.email = ownerEmail/);
  assert.match(authSource, /session\.accessToken = undefined/);
  assert.doesNotMatch(authSource, /session\.accessToken\s*=\s*token\.accessToken/);

  const linkPath = path.join(process.cwd(), "src/lib/auth/account-link.ts");
  const linkExists = await fs.stat(linkPath).then(() => true).catch(() => false);
  assert.equal(linkExists, true, "account linking state module must exist");
  const linkSource = await fs.readFile(linkPath, "utf8");
  assert.match(linkSource, /AUTH_SECRET/);
  assert.match(linkSource, /nonce/);
  assert.match(linkSource, /maxAge|600|10/);
  assert.match(linkSource, /cookies/);
  process.env.AUTH_SECRET = "task8-link-test-secret";
  const link = await import("../src/lib/auth/account-link.ts");
  const signed = link.signAccountLinkState({
    ownerUserId: userA,
    ownerEmail: "task8-a@example.com",
    provider: "google",
    nonce: "task8-once",
    exp: Date.now() + 60_000,
  });
  const usedNonces = new Set<string>();
  const validLink = link.consumeSignedAccountLinkState(
    signed,
    "google",
    usedNonces,
  );
  assert.equal(validLink?.ownerEmail, "task8-a@example.com");
  assert.equal(
    link.consumeSignedAccountLinkState(signed, "google", usedNonces),
    null,
    "link state is one-time",
  );
  assert.equal(
    link.consumeSignedAccountLinkState(
      `${signed.slice(0, -1)}x`,
      "google",
      new Set(),
    ),
    null,
    "tampered link state is rejected",
  );
  const expired = link.signAccountLinkState({
    ownerUserId: userA,
    ownerEmail: "task8-a@example.com",
    provider: "google",
    nonce: "task8-expired",
    exp: Date.now() - 1,
  });
  assert.equal(
    link.consumeSignedAccountLinkState(expired, "google", new Set()),
    null,
    "expired link state is rejected",
  );

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
  assert.match(migrationSource, /listAccountsWithTokens/);
  assert.doesNotMatch(migrationSource, /kvGet/);

  const settingsSource = await fs.readFile(
    path.join(process.cwd(), "src/components/v3/Settings.tsx"),
    "utf8",
  );
  for (const label of ["Current account", "Reconnect", "Add account", "Remove", "Switch", "Sign out"]) {
    assert.match(settingsSource, new RegExp(label, "i"));
  }
  assert.match(settingsSource, /reconnect_required|Needs reconnect/i);
  assert.match(settingsSource, /requiresSignOut/);
  assert.match(settingsSource, /logout/);
  assert.match(settingsSource, /onAccountSwitch|clearMailboxCaches/);
  const mailboxSource = await fs.readFile(
    path.join(process.cwd(), "src/components/v3/useMailbox.ts"),
    "utf8",
  );
  assert.match(mailboxSource, /accountKey/);
  assert.match(mailboxSource, /bodyCache/);
  assert.match(mailboxSource, /clearMailboxCaches/);
  const inboxViewSource = await fs.readFile(
    path.join(process.cwd(), "src/components/v2/useInboxView.ts"),
    "utf8",
  );
  assert.match(inboxViewSource, /ACCOUNT_CHANGED_EVENT/);
  assert.match(
    inboxViewSource,
    /setView\(null\)[\s\S]*void load\(\)/,
    "Atlas/Triage must clear stale account data before reloading",
  );

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
  await fs.rm(dataDir, { recursive: true, force: true });
}
