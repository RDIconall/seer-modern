/**
 * Task 11 gate: the mail client's pure logic. Reply-all derives correct
 * recipients (excluding self, deduped), provider action parity holds, and the
 * v2 components render from server data without re-deriving placement.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { replyRecipients, quoteBody } from "../src/lib/v2/client/reply.ts";
import { supportedActions, isSupported } from "../src/lib/v2/client/actions.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";

function m(from: string, to: string[], cc: string[]): Message {
  return {
    providerMessageId: Math.random().toString(36).slice(2),
    from: { email: from }, to: to.map((e) => ({ email: e })), cc: cc.map((e) => ({ email: e })),
    sentAt: "2026-08-08T10:00:00Z", snippet: "hi", bodyHtml: "<p>hi</p>", bodyText: "hi",
    isUnread: false, isOutgoing: false, attachments: [],
  };
}

const conversation: Conversation = {
  providerConversationId: "c",
  subject: "Re: Deal",
  messages: [
    m("alice@x.com", ["me@company.com", "bob@x.com"], ["carol@x.com"]),
    m("bob@x.com", ["me@company.com", "alice@x.com"], ["carol@x.com", "me@company.com"]),
  ],
  lastMessageAt: "2026-08-08T10:00:00Z",
};

// Reply: only the last sender, self excluded.
{
  const r = replyRecipients(conversation, "me@company.com", false);
  assert.deepEqual(r.to.map((a) => a.email), ["bob@x.com"]);
  assert.deepEqual(r.cc, []);
}

// Reply-all: last sender in To; others in Cc; self excluded; deduped.
{
  const r = replyRecipients(conversation, "me@company.com", true);
  assert.deepEqual(r.to.map((a) => a.email), ["bob@x.com"]);
  const cc = r.cc.map((a) => a.email).sort();
  assert.deepEqual(cc, ["alice@x.com", "carol@x.com"]);
  assert.ok(!cc.includes("me@company.com"), "must never reply to self");
}

// Quote includes the last message body.
assert.match(quoteBody(conversation), /bob@x\.com wrote:/);

// Provider parity: both providers support the same in-app actions.
assert.deepEqual(supportedActions("google"), supportedActions("microsoft"));
assert.equal(isSupported("microsoft", "restore"), true);

// Static contract: v2 components must not re-derive placement or branch on
// provider. They render server fields only.
const componentsDir = path.join(process.cwd(), "src", "components", "v2");
const forbidden = [
  /DELETE_DISPOSITIONS/,
  /disposition/i,
  /=== *['"]google['"]/,
  /=== *['"]microsoft['"]/,
];
const files = await fs.readdir(componentsDir).catch(() => []);
assert.ok(files.length > 0, "v2 components must exist");
for (const file of files) {
  if (!file.endsWith(".tsx") && !file.endsWith(".ts")) continue;
  const src = await fs.readFile(path.join(componentsDir, file), "utf8");
  for (const pattern of forbidden) {
    assert.ok(
      !pattern.test(src),
      `${file} must not contain placement/provider logic (${pattern})`,
    );
  }
}

console.log("v2-mail-client: OK");
