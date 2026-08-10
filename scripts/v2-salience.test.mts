/**
 * Gate: salience separates a generic sourcing broadcast from a direct demand,
 * computed from facts (recipients + relationship + the read's owner/obligation),
 * never from the model's own "urgent" claim.
 */
import assert from "node:assert/strict";
import {
  computeSalience,
  addressedDirectly,
  validDueDate,
} from "../src/lib/v2/intelligence/salience.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";

function msg(from: string, to: string[], body: string): Message {
  return {
    providerMessageId: Math.random().toString(36).slice(2),
    from: { email: from },
    to: to.map((email) => ({ email })),
    cc: [],
    sentAt: "2026-08-08T10:00:00Z",
    snippet: body.slice(0, 20),
    bodyHtml: null,
    bodyText: body,
    isUnread: true,
    isOutgoing: false,
    attachments: [],
  };
}

function convo(messages: Message[]): Conversation {
  return { providerConversationId: "c", subject: "s", messages, lastMessageAt: "" };
}

// A generic broadcast: not addressed to me, nobody's ball, portal robot.
{
  const c = convo([msg("global.mybuy@roche.com", ["vendors@roche.com"], "Event open for bidding")]);
  assert.equal(addressedDirectly(c, "conall@rditrials.com"), false);
  const s = computeSalience({
    read: { owner: "nobody", obligation: false, ask: "nothing — informational" },
    conversation: c,
    ownEmail: "conall@rditrials.com",
    senderTier: "machine",
    senderVip: false,
  });
  assert.equal(s, 0, "a generic sourcing broadcast is ambient");
}

// A direct demand: addressed to me, I owe the action, from a senior contact.
{
  const c = convo([
    msg("normand.despres@roche.com", ["conall@rditrials.com"], "Conall, please approve the revised budget by Friday"),
  ]);
  assert.equal(addressedDirectly(c, "conall@rditrials.com"), true);
  const s = computeSalience({
    read: { owner: "you", obligation: true, ask: "Approve the revised budget" },
    conversation: c,
    ownEmail: "conall@rditrials.com",
    senderTier: "inner",
    senderVip: false,
  });
  assert.equal(s, 3, "a direct demand from a senior contact is loud");
}

// Middle: addressed to me and I owe a reply, but sender isn't senior.
{
  const c = convo([msg("newvendor@example.com", ["conall@rditrials.com"], "Can you confirm the quote?")]);
  const s = computeSalience({
    read: { owner: "you", obligation: false, ask: "Confirm the quote" },
    conversation: c,
    ownEmail: "conall@rditrials.com",
    senderTier: "new-credible",
    senderVip: false,
  });
  assert.equal(s, 2);
}

// Same channel (Roche portal), but a message that names me and asks me → louder
// than the broadcast above, purely from recipients + the read's owner call.
{
  const c = convo([
    msg("global.mybuy@roche.com", ["conall@rditrials.com"], "Conall, your response is required on event TZC0430556"),
  ]);
  const s = computeSalience({
    read: { owner: "you", obligation: false, ask: "Respond to the event" },
    conversation: c,
    ownEmail: "conall@rditrials.com",
    senderTier: "unknown",
    senderVip: false,
  });
  assert.ok(s >= 2, "a direct ask addressed to me outranks a broadcast on the same channel");
}

// --- Stated deadlines: accepted only when real and plausible ---
{
  const now = new Date("2026-08-10T00:00:00Z");
  assert.equal(validDueDate("2026-08-19", now), "2026-08-19");
  assert.equal(validDueDate("2026-07-01", now), "2026-07-01", "recent past is a real overdue date");

  // Garbage and guesses are discarded rather than trusted.
  assert.equal(validDueDate(undefined, now), null);
  assert.equal(validDueDate("", now), null);
  assert.equal(validDueDate("next Friday", now), null);
  assert.equal(validDueDate("2026-13-45", now), null, "impossible dates are rejected");
  assert.equal(validDueDate("1999-01-01", now), null, "an ancient date is a misread");
  assert.equal(validDueDate("2099-01-01", now), null, "a far-future date is a misread");
}

console.log("v2-salience: OK");
