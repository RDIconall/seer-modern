/**
 * Grounded per-email verdict: whether Conall should care, why, and what to do,
 * citing calendar, amounts, replied state, and relationship — no second model.
 */
import assert from "node:assert/strict";
import { composeVerdict, type VerdictInput } from "../src/lib/v2/intelligence/verdict.ts";
import { compileContext } from "../src/lib/v2/intelligence/context.ts";
import {
  extractAmount,
  isAnomalousCharge,
  recordCharge,
  type MerchantDb,
} from "../src/lib/v2/intelligence/amounts.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";

const now = new Date("2026-11-14T17:00:00Z");

function base(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    home: "matter",
    owner: "you",
    ask: "nothing — informational",
    summary: "A note",
    obligation: false,
    dueDate: null,
    senderName: "Vendor",
    senderEmail: "billing@vendor.com",
    senderTier: "unknown",
    senderVip: false,
    inContacts: false,
    writtenTo: false,
    meeting: null,
    inviteAnswered: false,
    weSpokeLast: false,
    behavior: null,
    amount: null,
    usualAmount: null,
    usualLabel: null,
    anomalousAmount: false,
    candidateMatterTitle: null,
    freeSlot: null,
    now,
    ...over,
  };
}

{
  const v = composeVerdict(
    base({
      obligation: true,
      amount: 140,
      dueDate: "2026-12-13",
      usualLabel: "same as last year's renewal",
      usualAmount: 140,
      ask: "Pay the renewal invoice",
    }),
  );
  assert.equal(v.care, "needs_you");
  assert.match(v.why, /Pay by Dec 13/i);
  assert.match(v.why, /same as last year's renewal/);
  assert.match(v.what, /\$140/);
  assert.ok(v.evidence.some((e) => e.kind === "amount"));
}

{
  const v = composeVerdict(
    base({
      senderName: "Coleen Arora",
      senderEmail: "coleen@example.com",
      inContacts: true,
      writtenTo: true,
      senderTier: "known",
      ask: "Need a CAP time this week",
      summary: "Can we find a CAP slot?",
      freeSlot: "Tue 9am",
    }),
  );
  assert.equal(v.care, "needs_you");
  assert.match(v.why, /Coleen needs a time, you're free Tue 9am/i);
  assert.equal(v.what, "Offer Tue 9am");
}

{
  const v = composeVerdict(
    base({
      home: "delete",
      owner: "nobody",
      ask: "nothing — informational",
    }),
  );
  assert.equal(v.care, "ignore");
  assert.equal(v.what, "Ignore — nothing changed");
  assert.equal(v.importance, 0);
}

{
  const v = composeVerdict(
    base({
      home: "record",
      owner: "nobody",
      amount: 480,
      usualLabel: "usually ~$140 (6 charges)",
      usualAmount: 140,
      anomalousAmount: true,
    }),
  );
  assert.equal(v.care, "review_charge");
  assert.match(v.why, /\$480/);
  assert.match(v.what, /Check the \$480 charge/);
}

{
  const v = composeVerdict(
    base({
      owner: "you",
      weSpokeLast: true,
      obligation: false,
    }),
  );
  assert.equal(v.care, "waiting");
  assert.match(v.why, /already replied/i);
}

{
  const v = composeVerdict(
    base({
      inviteAnswered: true,
      owner: "you",
      ask: "Please RSVP",
    }),
  );
  assert.equal(v.care, "ignore");
  assert.match(v.why, /RSVP already/i);
}

{
  const v = composeVerdict(
    base({
      dueDate: "2026-10-01",
      owner: "nobody",
      home: "record",
    }),
  );
  assert.equal(v.urgencyExpired, true);
  assert.equal(v.care, "ignore");
}

{
  const db: MerchantDb = {};
  recordCharge(db, "billing@vendor.com", "Vendor", 140);
  recordCharge(db, "billing@vendor.com", "Vendor", 140);
  recordCharge(db, "billing@vendor.com", "Vendor", 145);
  assert.equal(extractAmount("Invoice $1,200.00 due"), 1200);
  assert.equal(isAnomalousCharge(db, "billing@vendor.com", 140), false);
  assert.equal(isAnomalousCharge(db, "billing@vendor.com", 480), true);
}

function msg(
  from: string,
  body: string,
  extra: Partial<Message> = {},
): Message {
  return {
    providerMessageId: "m1",
    from: { email: from, name: extra.from?.name },
    to: [{ email: "conall@rditrials.com" }],
    cc: [],
    sentAt: "2026-11-14T10:00:00Z",
    snippet: body.slice(0, 40),
    bodyHtml: null,
    bodyText: body,
    isUnread: true,
    isOutgoing: false,
    attachments: [],
    ...extra,
  };
}

{
  const conversation: Conversation = {
    providerConversationId: "c",
    subject: "Need a CAP time",
    lastMessageAt: "2026-11-14T10:00:00Z",
    messages: [msg("coleen@example.com", "Can we find a CAP slot this week?", {
      from: { email: "coleen@example.com", name: "Coleen Arora" },
    })],
  };
  const compiled = compileContext(conversation, {
    ownDomain: "rditrials.com",
    ownEmail: "conall@rditrials.com",
    people: [],
    matters: [],
    interests: [],
    personal: {
      contacts: ["coleen@example.com"],
      autoContacts: [],
      events: [],
      timezone: "Pacific Standard Time",
      health: { people: "ok", calendar: "ok" },
      contactsBuiltAt: now.toISOString(),
      eventsBuiltAt: now.toISOString(),
    },
    writtenTo: new Set(["coleen@example.com"]),
  });
  assert.equal(compiled.senderIsKnown, true, "saved contacts count as known");
  assert.equal(compiled.inContacts, true);
  assert.equal(compiled.writtenTo, true);
  assert.match(compiled.text, /saved contacts/);
  assert.ok(compiled.text.length <= 1600);
}

{
  const conversation: Conversation = {
    providerConversationId: "c",
    subject: "Re: quote",
    lastMessageAt: "2026-11-14T12:00:00Z",
    messages: [
      msg("new@vendor.com", "Can you confirm?"),
      {
        ...msg("conall@rditrials.com", "Thanks, looping back Monday."),
        isOutgoing: true,
        from: { email: "conall@rditrials.com" },
      },
    ],
  };
  const compiled = compileContext(conversation, {
    ownDomain: "rditrials.com",
    ownEmail: "conall@rditrials.com",
    people: [],
    matters: [],
    interests: [],
  });
  assert.equal(compiled.weSpokeLast, true);
  assert.match(compiled.text, /already replied/);
}

console.log("v2-verdict: OK");
