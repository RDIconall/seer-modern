/**
 * Gate: user placement corrections reach the next read, and existing-matter
 * continuity cannot be established by one generic shared word.
 */
import assert from "node:assert/strict";
import { compileContext, type ContextInput } from "../src/lib/v2/intelligence/context.ts";
import type { Conversation } from "../src/lib/v2/providers/types.ts";

const conversation = (
  subject: string,
  body: string,
  from = "notifications@roche.com",
): Conversation => ({
  providerConversationId: `provider-${subject}`,
  subject,
  lastMessageAt: "2026-08-23T10:00:00Z",
  messages: [
    {
      providerMessageId: `message-${subject}`,
      from: { email: from },
      to: [{ email: "me@rditrials.com" }],
      cc: [],
      sentAt: "2026-08-23T10:00:00Z",
      snippet: body,
      bodyHtml: `<p>${body}</p>`,
      bodyText: body,
      isUnread: true,
      isOutgoing: false,
      attachments: [],
    },
  ],
});

const base: ContextInput = {
  ownDomain: "rditrials.com",
  ownEmail: "me@rditrials.com",
  people: [],
  interests: [],
  matters: [
    {
      id: "matter-anti-tpo",
      title: "Roche anti-TPO sample collection",
      codes: ["RCD2904"],
      counterparty: "roche",
      userAuthored: false,
    },
  ],
  placements: [
    {
      senderEmail: "notifications@roche.com",
      home: "record",
      count: 3,
    },
  ],
};

const generic = compileContext(
  conversation("Roche weekly product news", "A generic product status update."),
  base,
);
assert.equal(
  generic.candidateMatterId,
  null,
  "one shared company word must not continue an arbitrary live matter",
);
assert.equal(generic.priorMatterRejections, 3);
assert.match(generic.text, /\[explicit\].*archive\/delete 3 time/);
assert.ok(generic.refs.includes("placement:notifications@roche.com"));

const guided = compileContext(conversation("Roche weekly product news", "A generic product status update."), {
  ...base,
  operatingGuidance: "This is a personal desk. Family logistics are matters.",
});
assert.match(guided.text, /\[explicit\] how this desk is organised/);
assert.match(guided.text, /Family logistics are matters/);

const styled = compileContext(conversation("Roche weekly product news", "A generic product status update."), {
  ...base,
  mailboxStyleGuidance:
    "they leave mail in the Inbox folder; they mark importance with unread; only real ongoing work is an Atlas matter.",
});
assert.match(styled.text, /\[explicit\] how this person uses mail/);
assert.match(styled.text, /leave mail in the Inbox/);

const coded = compileContext(
  conversation(
    "RCD_2904 sample collection update",
    "The RCD_2904 collection plan needs review.",
  ),
  base,
);
assert.equal(
  coded.candidateMatterId,
  "matter-anti-tpo",
  "a shared study code is conservative continuity evidence",
);
assert.match(coded.text, /conservative relation match/);

console.log("v2-context-feedback: OK");
