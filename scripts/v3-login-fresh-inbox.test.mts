/**
 * Gate: signing in must not resurrect last week's inbox.
 *
 * After login Seer painted the previous session's localStorage mailbox, kept
 * the leftover active-account cookie, and never asked the provider for mail
 * that arrived while the user was away. The list looked fine and was wrong.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { asAccountId, asUserId } from "../src/lib/v2/db/types.ts";
import { resolveMailboxAccount } from "../src/lib/v2/session.ts";
import {
  inboxCatchUpDue,
  INBOX_CATCH_UP_STALE_MS,
} from "../src/lib/v2/sync/catch-up.ts";
import {
  isMailboxCacheFresh,
  wrapMailboxCache,
} from "../src/lib/v3/mailbox/cache.ts";
import type { MailAccount } from "../src/lib/v2/db/accounts.ts";
import type { MailboxView } from "../src/lib/v3/mailbox/types.ts";

function account(id: string, email: string): MailAccount {
  return {
    id: asAccountId(id),
    userId: asUserId("11111111-1111-4111-8111-111111111111"),
    provider: "google",
    email,
    displayName: email,
    status: "active",
  };
}

const gmail = account("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "you@gmail.com");
const outlook = account(
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "you@rditrials.com",
);
const owned = [outlook, gmail];

assert.equal(
  resolveMailboxAccount(owned, null, gmail.id, gmail.email)?.id,
  gmail.id,
  "with no cookie, the mailbox just signed into is the one shown",
);
assert.equal(
  resolveMailboxAccount(owned, outlook.id, gmail.id, gmail.email)?.id,
  outlook.id,
  "an explicit switch (cookie) still wins over the original sign-in",
);
assert.equal(
  resolveMailboxAccount(owned, null, null, gmail.email)?.id,
  gmail.id,
  "falling back by session email must not pick another owned mailbox",
);
assert.equal(
  resolveMailboxAccount(owned, "not-owned", gmail.id, outlook.email)?.id,
  gmail.id,
  "a leftover cookie from another browser user cannot select their mailbox",
);

const now = Date.parse("2026-09-19T23:00:00Z");
assert.equal(
  inboxCatchUpDue(null, now),
  true,
  "a never-synced mailbox must catch up on login",
);
assert.equal(
  inboxCatchUpDue(new Date(now - INBOX_CATCH_UP_STALE_MS - 1), now),
  true,
  "mail last synced before the stale window must catch up on login",
);
assert.equal(
  inboxCatchUpDue(new Date(now - 60_000), now),
  false,
  "a mailbox the cron just touched must not pay for another provider poll",
);

const sampleView: MailboxView = {
  accountId: gmail.id,
  folder: "inbox",
  sort: "date",
  rows: [],
  total: 0,
  needsYou: 0,
  nextCursor: null,
};

assert.equal(
  isMailboxCacheFresh(wrapMailboxCache(sampleView, now - 60_000), now),
  true,
  "a cache from this session may paint while the network revalidates",
);
assert.equal(
  isMailboxCacheFresh(
    wrapMailboxCache(sampleView, now - 6 * 60 * 60 * 1000),
    now,
  ),
  false,
  "yesterday's cached inbox must not paint after login",
);
assert.equal(
  isMailboxCacheFresh(sampleView, now),
  false,
  "a cache written before timestamps existed is expired",
);

const root = process.cwd();
const read = (file: string) => fs.readFile(path.join(root, file), "utf8");

const actions = await read("src/app/actions.ts");
assert.match(
  actions,
  /export async function loginGoogle[\s\S]*setActiveAccountId\(null\)/,
  "Google login must drop the leftover active mailbox before OAuth",
);
assert.match(
  actions,
  /export async function loginMicrosoft[\s\S]*setActiveAccountId\(null\)/,
  "Microsoft login must drop the leftover active mailbox before OAuth",
);
assert.match(
  actions,
  /export async function logout[\s\S]*setActiveAccountId\(null\)/,
  "sign-out must forget which mailbox was selected",
);

const auth = await read("src/auth.ts");
assert.match(
  auth,
  /session\.activeAccountId\s*=\s*token\.activeAccountId/,
  "the session must carry the mailbox signed into, not only the cookie",
);

const session = await read("src/lib/v2/session.ts");
assert.match(
  session,
  /activeAccountId|sessionAccountId/,
  "corpus reads must honor the signed-in mailbox when the cookie is empty",
);

const mailboxHook = await read("src/components/v3/useMailbox.ts");
assert.match(
  mailboxHook,
  /unwrapMailboxCache|isMailboxCacheFresh|savedAt/,
  "the client must refuse an expired local inbox cache",
);
assert.match(
  mailboxHook,
  /settleScope|activeAccountId/,
  "a failed refresh after login must error against the resolved mailbox, not the empty pre-login scope",
);
assert.match(
  mailboxHook,
  /catchingUp/,
  "when the corpus is catching up from the provider, the client must reload it",
);

const mailboxRoute = await read("src/app/api/v3/mailbox/route.ts");
assert.match(
  mailboxRoute,
  /catchUpInbox|kickInboxCatchUp|inboxCatchUp/,
  "opening the mailbox after login must ask the provider for mail that arrived while away",
);

const inboxRoute = await read("src/app/api/v2/inbox/route.ts");
assert.match(
  inboxRoute,
  /catchUpInbox|kickInboxCatchUp|inboxCatchUp/,
  "Triage and Atlas must not stay on the pre-login corpus either",
);

const accountsRoute = await read("src/app/api/v3/accounts/route.ts");
assert.match(
  accountsRoute,
  /resolveMailboxAccount/,
  "the account picker must name the same mailbox the list is showing",
);

const login = await read("src/components/auth/AuthScreens.tsx");
assert.match(
  login,
  /ForgetCachedInbox/,
  "tapping sign-in must drop the previous session's cached rows",
);

const settings = await read("src/components/v3/Settings.tsx");
assert.match(
  settings,
  /clearMailboxCaches/,
  "sign-out from settings must drop the cached inbox",
);

console.log("v3-login-fresh-inbox: OK");
