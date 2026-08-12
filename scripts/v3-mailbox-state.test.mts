import assert from "node:assert/strict";
import type { MailboxView } from "../src/lib/v3/mailbox/types.ts";
import {
  prefetchAdjacentIds,
  viewForFolder,
} from "../src/components/v3/mailbox-state.ts";

const view = (folder: MailboxView["folder"], ids: string[]): MailboxView => ({
  accountId: "test-account",
  folder,
  sort: "date",
  rows: ids.map((conversationId) => ({
    conversationId,
    providerConversationId: `provider-${conversationId}`,
    senderDisplayName: "Sender",
    subject: conversationId,
    timestamp: "2026-08-11T00:00:00.000Z",
    isUnread: false,
    snippet: "",
    attachments: [],
    decisionSummary: null,
    priority: null,
    dueDate: null,
    matterTitle: null,
    disposition: "pending",
    deleteRank: 4,
    deleteToken: null,
    category: null,
  })),
  total: ids.length,
  nextCursor: null,
});

assert.equal(viewForFolder(view("inbox", ["inbox-1"]), "sent"), null);
assert.equal(viewForFolder(null, "sent"), null);
assert.equal(viewForFolder(view("sent", ["sent-1"]), "sent")?.folder, "sent");

assert.deepEqual(
  prefetchAdjacentIds(view("inbox", ["a", "b", "c"]), "b"),
  ["a", "b", "c"],
);
assert.deepEqual(
  prefetchAdjacentIds(view("inbox", ["a", "b", "c"]), "a"),
  ["a", "b"],
);
assert.deepEqual(
  prefetchAdjacentIds(view("inbox", ["a", "b", "c"]), "missing"),
  [],
);

console.log("v3-mailbox-state: OK");
