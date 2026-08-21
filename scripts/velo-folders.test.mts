import assert from "node:assert/strict";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";

const provider = new FakeProvider({
  conversations: [
    {
      providerConversationId: "thread-1",
      subject: "Move me",
      messages: [
        {
          providerMessageId: "m1",
          from: { email: "a@example.com" },
          to: [{ email: "me@example.com" }],
          cc: [],
          sentAt: "2026-08-21T10:00:00Z",
          snippet: "",
          bodyHtml: "<p>x</p>",
          bodyText: "x",
          isUnread: false,
          isOutgoing: false,
          attachments: [],
          folder: "inbox",
        },
      ],
    },
  ],
});

const folders = await provider.listFolders();
assert.ok(folders.some((folder) => folder.id === "archive"));
const moved = await provider.moveConversation("thread-1", "archive", "move-1");
assert.deepEqual(moved.failed, []);
assert.deepEqual(moved.processed, ["m1"]);
assert.equal((await provider.syncFolder("inbox")).conversations.length, 0);

console.log("velo-folders: OK");
