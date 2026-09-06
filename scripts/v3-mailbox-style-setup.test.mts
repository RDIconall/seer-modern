/**
 * Gate: the training overlay must not exist.
 *
 * It blocked the mailbox until style was confirmed, then kept coming back
 * on a never-archive inbox. Triage is the clearing surface; this dialog is
 * not shown from MailClient or Settings.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const client = await readFile("src/components/v3/MailClient.tsx", "utf8");
assert.doesNotMatch(
  client,
  /MailboxStyleSetup/,
  "MailClient must not mount the training overlay",
);
assert.doesNotMatch(client, /Check what we inferred/);

const settings = await readFile("src/components/v3/Settings.tsx", "utf8");
assert.doesNotMatch(
  settings,
  /MailboxStyleSetup|MailboxStyleSettings/,
  "Settings must not reopen the training overlay",
);

console.log("v3-mailbox-style-setup: OK");
