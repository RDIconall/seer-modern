/**
 * Gate: an optimistic row move is never presented as provider confirmation.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { noticeForCommands } from "../src/components/v3/MailClient.tsx";
import type { CommandResult } from "../src/lib/v2/commands/types.ts";

const deleted = [{ type: "delete", conversationId: "c1", byUser: true }] as const;

const queued = noticeForCommands(
  [...deleted],
  [
    {
      ok: true,
      replayed: false,
      optimistic: true,
      outboxId: "outbox-1",
    },
  ],
);
assert.match(queued.message, /Waiting for provider confirmation/);
assert.equal(queued.outboxId, "outbox-1");
assert.deepEqual(queued.outboxIds, ["outbox-1"]);

const rejected = noticeForCommands(
  [...deleted],
  [
    {
      ok: false,
      replayed: false,
      error: "conversation not found",
    },
  ],
);
assert.equal(rejected.error, true);
assert.match(rejected.message, /not queued/);
assert.match(rejected.message, /back in the list/);

const partialResults: CommandResult[] = [
  {
    ok: true,
    replayed: false,
    optimistic: true,
    outboxId: "outbox-1",
  },
  {
    ok: false,
    replayed: false,
    error: "not queued",
  },
];
const partial = noticeForCommands(
  [
    { type: "archive", conversationId: "c1" },
    { type: "archive", conversationId: "c2" },
  ],
  partialResults,
);
assert.match(partial.message, /1 queued/);
assert.match(partial.message, /1 not queued and restored/);
assert.equal(partial.error, true);

const mailbox = await readFile("src/components/v3/useMailbox.ts", "utf8");
assert.match(
  mailbox,
  /results\.push\(\{\s*ok: false,[\s\S]*?action was not queued/,
  "one result per command identifies exactly which batch rows failed",
);

const client = await readFile("src/components/v3/MailClient.tsx", "utf8");
assert.match(client, /\/status/);
assert.match(client, /confirmed by the provider/);
assert.match(client, /still queued and retrying/);
assert.match(client, /failed at the provider and the mailbox was refreshed/);

const route = await readFile(
  "src/app/api/v3/outbox/[id]/status/route.ts",
  "utf8",
);
assert.match(route, /getActiveV2Account/);
assert.match(route, /findOutboxById\(account\.id/);

console.log("v3-action-status: OK");
