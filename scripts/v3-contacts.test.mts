/**
 * Contact suggestions: merge people + message exchanges, ranked in SQL, with
 * hard account isolation.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { suggestContacts } from "../src/lib/v3/contacts/repository.ts";
import type { AccountId } from "../src/lib/v2/db/types.ts";

async function seedPerson(
  pool: import("pg").Pool,
  accountId: AccountId,
  email: string,
  opts: { displayName?: string; tier?: string; vip?: boolean } = {},
) {
  await pool.query(
    `insert into seer.people (account_id, email, display_name, tier, vip)
     values ($1, $2, $3, $4, $5)
     on conflict (account_id, email) do update
       set display_name = excluded.display_name,
           tier = excluded.tier,
           vip = excluded.vip`,
    [
      accountId,
      email,
      opts.displayName ?? null,
      opts.tier ?? "unknown",
      opts.vip ?? false,
    ],
  );
}

async function seedMessage(
  pool: import("pg").Pool,
  accountId: AccountId,
  opts: {
    providerId: string;
    fromEmail: string;
    toEmails: string[];
    fromName?: string;
  },
) {
  const c = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders)
     values ($1, $2, $3, now(), array['inbox']::text[])
     returning id`,
    [accountId, opts.providerId, opts.providerId],
  );
  await pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, from_name,
        to_emails, sent_at, snippet, is_unread, is_outgoing)
     values ($1, $2, $3, $4, $5, $6, now(), 'hi', false, false)`,
    [
      accountId,
      c.rows[0].id,
      `${opts.providerId}-m1`,
      opts.fromEmail,
      opts.fromName ?? null,
      opts.toEmails,
    ],
  );
}

const db = await startTestDb();
try {
  const userA = await upsertUser("me@example.com");
  const accountA = await upsertAccount({
    userId: userA,
    provider: "google",
    email: "me@example.com",
  });
  const userB = await upsertUser("other@example.com");
  const accountB = await upsertAccount({
    userId: userB,
    provider: "google",
    email: "other@example.com",
  });

  await seedPerson(db.pool, accountA, "s.yasavul@fund.com", {
    displayName: "Sandra Yasavul",
    tier: "known",
    vip: false,
  });
  await seedPerson(db.pool, accountA, "vip@example.com", {
    displayName: "Very Important",
    tier: "new-credible",
    vip: true,
  });
  await seedPerson(db.pool, accountA, "inner@example.com", {
    displayName: "Inner Circle",
    tier: "inner",
  });
  await seedPerson(db.pool, accountA, "known@example.com", {
    displayName: "Known Peer",
    tier: "known",
  });
  await seedPerson(db.pool, accountA, "noreply@example.com", {
    displayName: "No Reply Bot",
    tier: "machine",
  });
  await seedPerson(db.pool, accountA, "aaa-tie@example.com", {
    displayName: "Tie A",
    tier: "known",
  });
  await seedPerson(db.pool, accountA, "zzz-tie@example.com", {
    displayName: "Tie Z",
    tier: "known",
  });

  // VIP has fewer exchanges than known non-VIP — still ranks first.
  for (let i = 0; i < 2; i++) {
    await seedMessage(db.pool, accountA, {
      providerId: `vip-${i}`,
      fromEmail: "vip@example.com",
      toEmails: ["me@example.com"],
    });
  }
  for (let i = 0; i < 10; i++) {
    await seedMessage(db.pool, accountA, {
      providerId: `known-ex-${i}`,
      fromEmail: "known@example.com",
      toEmails: ["me@example.com"],
    });
  }
  for (let i = 0; i < 3; i++) {
    await seedMessage(db.pool, accountA, {
      providerId: `inner-${i}`,
      fromEmail: "inner@example.com",
      toEmails: ["me@example.com"],
    });
  }
  for (let i = 0; i < 5; i++) {
    await seedMessage(db.pool, accountA, {
      providerId: `machine-${i}`,
      fromEmail: "noreply@example.com",
      toEmails: ["me@example.com"],
    });
  }
  // Equal tier+exchanges: alphabetical email breaks the tie.
  for (let i = 0; i < 4; i++) {
    await seedMessage(db.pool, accountA, {
      providerId: `tie-a-${i}`,
      fromEmail: "aaa-tie@example.com",
      toEmails: ["me@example.com"],
    });
    await seedMessage(db.pool, accountA, {
      providerId: `tie-z-${i}`,
      fromEmail: "zzz-tie@example.com",
      toEmails: ["me@example.com"],
    });
  }

  // Mail-only address (never in seer.people), appears as from and as to.
  await seedMessage(db.pool, accountA, {
    providerId: "mail-only-1",
    fromEmail: "only-in-mail@example.com",
    toEmails: ["me@example.com"],
    fromName: "Mail Only",
  });
  await seedMessage(db.pool, accountA, {
    providerId: "mail-only-2",
    fromEmail: "someone@example.com",
    toEmails: ["only-in-mail@example.com"],
  });

  // Other account: must never leak.
  await seedPerson(db.pool, accountB, "secret@other.com", {
    displayName: "Secret Other",
    tier: "inner",
    vip: true,
  });
  await seedMessage(db.pool, accountB, {
    providerId: "other-1",
    fromEmail: "secret@other.com",
    toEmails: ["other@example.com"],
  });

  // Substring match on display name and email, case-insensitive.
  const byName = await suggestContacts(accountA, "sand");
  assert.ok(byName.some((s) => s.email === "s.yasavul@fund.com"));
  assert.equal(
    byName.find((s) => s.email === "s.yasavul@fund.com")?.displayName,
    "Sandra Yasavul",
  );

  const byEmail = await suggestContacts(accountA, "YASA");
  assert.ok(byEmail.some((s) => s.email === "s.yasavul@fund.com"));

  // Empty query → top-ranked contacts (raise limit so machine is in the page).
  const top = await suggestContacts(accountA, "", 25);
  assert.ok(top.length > 0);
  assert.equal(top[0].email, "vip@example.com", "VIP outranks higher-exchange non-VIP");
  assert.ok(top[0].vip);

  const emails = top.map((s) => s.email);
  const innerIdx = emails.indexOf("inner@example.com");
  const knownIdx = emails.indexOf("known@example.com");
  assert.ok(innerIdx >= 0 && knownIdx >= 0 && innerIdx < knownIdx, "inner outranks known");

  const machineIdx = emails.indexOf("noreply@example.com");
  assert.ok(machineIdx >= 0, "machine still suggestible");
  assert.equal(machineIdx, emails.length - 1, "machine sorts last among returned");
  assert.ok(
    emails.slice(0, machineIdx).every((e) => e !== "noreply@example.com"),
  );

  const aaaIdx = emails.indexOf("aaa-tie@example.com");
  const zzzIdx = emails.indexOf("zzz-tie@example.com");
  assert.ok(aaaIdx >= 0 && zzzIdx >= 0 && aaaIdx < zzzIdx, "ties break by email");

  // Mail-only address with exchange count from from + to appearances.
  const mailOnly = await suggestContacts(accountA, "only-in-mail");
  assert.equal(mailOnly.length, 1);
  assert.equal(mailOnly[0].email, "only-in-mail@example.com");
  assert.equal(mailOnly[0].exchanges, 2);
  assert.equal(mailOnly[0].tier, "unknown");
  assert.equal(mailOnly[0].vip, false);

  // Account isolation.
  const leaked = await suggestContacts(accountA, "secret");
  assert.equal(leaked.length, 0);
  const otherTop = await suggestContacts(accountB, "");
  assert.ok(otherTop.every((s) => s.email === "secret@other.com"));
  assert.ok(!otherTop.some((s) => s.email === "vip@example.com"));

  // Limit respected and hard-capped at 25.
  const limited = await suggestContacts(accountA, "", 3);
  assert.equal(limited.length, 3);

  for (let i = 0; i < 30; i++) {
    await seedPerson(db.pool, accountA, `bulk-${String(i).padStart(2, "0")}@example.com`, {
      tier: "unknown",
    });
  }
  const capped = await suggestContacts(accountA, "", 100);
  assert.equal(capped.length, 25);

  console.log("v3-contacts: OK");
} finally {
  await db.stop();
}
