/**
 * Round-robin multi-account sync: large account 1 sent cannot starve account 2 trash.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { syncTickRoundRobin } from "../src/lib/v2/sync/report.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";

function msg(id: string, folder: "sent" | "trash"): Message & { folder: typeof folder } {
  return {
    providerMessageId: id,
    from: { email: "s@example.com" },
    to: [{ email: "me@example.com" }],
    cc: [],
    sentAt: "2026-08-01T10:00:00Z",
    snippet: "s",
    bodyHtml: "<p>b</p>",
    bodyText: "b",
    isUnread: false,
    isOutgoing: folder === "sent",
    attachments: [],
    folder,
  };
}

const db = await startTestDb();
try {
  const userId = await upsertUser("fairness@example.com");
  const accountId1 = await upsertAccount({
    userId,
    provider: "google",
    email: "huge-sent@example.com",
  });
  const accountId2 = await upsertAccount({
    userId,
    provider: "google",
    email: "small-trash@example.com",
  });

  const account1 = {
    id: accountId1,
    userId,
    provider: "google" as const,
    email: "huge-sent@example.com",
    displayName: null,
  };
  const account2 = {
    id: accountId2,
    userId,
    provider: "google" as const,
    email: "small-trash@example.com",
    displayName: null,
  };

  const provider1 = new FakeProvider({
    pageSize: 10,
    conversations: Array.from({ length: 200 }, (_, i) => ({
      providerConversationId: `a1-sent-${i}`,
      subject: `A1 ${i}`,
      messages: [msg(`a1-sent-${i}-m`, "sent")],
    })),
  });
  const provider2 = new FakeProvider({
    pageSize: 5,
    conversations: Array.from({ length: 15 }, (_, i) => ({
      providerConversationId: `a2-trash-${i}`,
      subject: `A2 trash ${i}`,
      messages: [msg(`a2-trash-${i}-m`, "trash")],
    })),
  });

  const deadlineMs = Date.now() + 120_000;
  const entries = [
    { account: account1, provider: provider1 },
    { account: account2, provider: provider2 },
  ];

  for (const tickSlot of [0, 1]) {
    const report = await syncTickRoundRobin(
      entries,
      "incremental",
      ["inbox", "sent", "trash"],
      { deadlineMs, tickSlot, rounds: 1 },
    );
    const acc2Trash = report.filter(
      (r) => r.email === account2.email && r.folder === "trash",
    );
    assert.ok(
      acc2Trash.some((r) => (r.pages ?? 0) >= 1),
      `tickSlot ${tickSlot}: account 2 trash must progress`,
    );
    const acc1Sent = report.filter(
      (r) => r.email === account1.email && r.folder === "sent",
    );
    assert.ok(
      acc1Sent.some((r) => (r.pages ?? 0) >= 1),
      `tickSlot ${tickSlot}: account 1 sent also progresses`,
    );
  }

  const trashStored = await db.pool.query<{ n: number }>(
    `select count(*)::int as n from seer.conversations
      where account_id = $1 and folders @> array['trash']::text[]`,
    [accountId2],
  );
  assert.ok(trashStored.rows[0].n >= 5, "account 2 trash corpus must grow over rotated ticks");

  console.log("v3-sync-fairness: OK");
} finally {
  await db.stop();
}
