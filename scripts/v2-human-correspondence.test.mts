/**
 * Gate: a letter a person wrote to you by name is never swept.
 *
 * The case this exists for is real. A referral from a family friend — "Hi
 * Conall, this is Rachel's Dad" — was classified safe to delete, because the
 * sender was not yet a saved contact and the note asked a favour rather than
 * raising an obligation. Every veto the safety layer had was about the state of
 * the work; none was about the kind of mail.
 */
import assert from "node:assert/strict";
import {
  isHumanCorrespondence,
  isMachineAddress,
  ownNames,
  personalGreeting,
} from "../src/lib/v2/intelligence/human-correspondence.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";

const OWN = "conall@rditrials.com";

function message(over: Partial<Message>): Message {
  return {
    providerMessageId: "m1",
    from: { email: "someone@example.com", name: "Someone" },
    to: [{ email: OWN, name: "Conall Arora" }],
    cc: [],
    sentAt: "2026-08-07T10:57:00.000Z",
    snippet: "",
    bodyHtml: null,
    bodyText: "",
    isUnread: true,
    isOutgoing: false,
    attachments: [],
    ...over,
  };
}

const conversation = (messages: Message[]): Conversation => ({
  providerConversationId: "c1",
  subject: "Resume of a friend's niece",
  messages,
  lastMessageAt: "2026-08-07T10:57:00.000Z",
});

// --- the names a user answers to --------------------------------------------

{
  const names = ownNames(conversation([message({})]), OWN);
  assert.ok(names.includes("conall"), "the local part of the own address is a name");
  assert.ok(names.includes("arora"), "the display name mail is addressed to counts too");
}

// A single letter is an initial, not a name, and must not be matched on.
assert.ok(!ownNames(conversation([message({})]), "c@rditrials.com").includes("c"));

// --- the greeting ------------------------------------------------------------

assert.ok(personalGreeting("Hi Conall, this is Rachel's Dad.", ["conall"]));
assert.ok(personalGreeting("Dear Conall,\n\nPlease find attached.", ["conall"]));
assert.ok(personalGreeting("Good morning Conall —", ["conall"]));
assert.ok(personalGreeting("Hello Mr Arora,", ["conall", "arora"]));

// A greeting that names nobody is a broadcast opening, not a letter.
assert.equal(personalGreeting("Hi there,\n\nBig savings this week.", ["conall"]), null);
assert.equal(personalGreeting("Dear Customer,", ["conall"]), null);
assert.equal(personalGreeting("Hello,\n\nYour statement is ready.", ["conall"]), null);

// The name has to be in the greeting, not merely somewhere in the mail.
assert.equal(
  personalGreeting("Hi there,\n\nWe told Conall about the release.", ["conall"]),
  null,
);

// A "Dear Sir" buried far down a quoted footer is not someone greeting you.
assert.equal(personalGreeting(`${"filler ".repeat(120)}Dear Conall,`, ["conall"]), null);

// The Microsoft external-sender banner lands in front of the greeting on the
// same line. The salutation must still be found underneath it.
assert.ok(
  personalGreeting(
    "You don't often get email from spalekar@gmail.com. Learn why this is important Hi Conall, this is Rachel's Dad.",
    ["conall"],
  ),
  "the external-sender banner must not hide the greeting",
);

// --- machine addresses -------------------------------------------------------

for (const address of [
  "no-reply@roche.com",
  "noreply@qualio.com",
  "do-not-reply@ironmountain.com",
  "notifications@github.com",
  "mailer-daemon@example.com",
  "bounces@sendgrid.net",
  // Broadcast identities: a mail-merge from one of these is not a letter.
  "updates@frontapp.com",
  "newsletter@labmanager.com",
  "marketing@vendor.com",
  "digest@substack.com",
]) {
  assert.ok(isMachineAddress(address), `${address} is a machine address`);
}

// Real people whose address reads like a role keep their protection.
for (const address of [
  "spalekar@gmail.com",
  "support@acme.com",
  "info@lab.org",
  "hello@startup.com",
  "team@studio.com",
]) {
  assert.ok(!isMachineAddress(address), `${address} must not be treated as a machine`);
}

// A mail-merge that opens "Hi Conall" from a broadcast address is not a letter.
assert.ok(
  !isHumanCorrespondence(
    conversation([
      message({
        from: { email: "updates@frontapp.com", name: "Matt at Front" },
        bodyText: "Hi Conall, which operational archetype is your team?",
      }),
    ]),
    OWN,
  ),
  "a mail-merge greeting from a broadcast address is not human correspondence",
);

// --- the whole rule ----------------------------------------------------------

// The referral that started this.
assert.ok(
  isHumanCorrespondence(
    conversation([
      message({
        from: { email: "spalekar@gmail.com", name: "Sadanand Palekar" },
        bodyText:
          "Hi Conall, this is Rachel's Dad. Samir was telling me how well you and " +
          "your company are doing. I am writing to forward a resume of my friend's niece.",
      }),
    ]),
    OWN,
  ),
  "a personal referral is human correspondence",
);

// The same greeting from a no-reply address is a mail merge.
assert.ok(
  !isHumanCorrespondence(
    conversation([
      message({
        from: { email: "no-reply@portal.com", name: "Roche MyBuy" },
        bodyText: "Hi Conall, your supplier portal password expires in 7 days.",
      }),
    ]),
    OWN,
  ),
  "a machine address is not correspondence however it greets you",
);

// A broadcast with no name is not correspondence.
assert.ok(
  !isHumanCorrespondence(
    conversation([
      message({
        from: { email: "news@bizdevlabs.com", name: "BizDevLabs" },
        bodyText: "Hello,\n\nProspecting scripts that convert.",
      }),
    ]),
    OWN,
  ),
);

// A greeting in the user's own sent mail is their handwriting, not a letter owed
// to them.
assert.ok(
  !isHumanCorrespondence(
    conversation([
      message({
        isOutgoing: true,
        from: { email: OWN, name: "Conall Arora" },
        bodyText: "Hi Conall, note to self.",
      }),
    ]),
    OWN,
  ),
);

// HTML-only mail is read through the same body extraction as everything else.
assert.ok(
  isHumanCorrespondence(
    conversation([
      message({
        from: { email: "friend@example.com", name: "A Friend" },
        bodyText: null,
        bodyHtml: "<div><p>Dear Conall,</p><p>Hope you are well.</p></div>",
      }),
    ]),
    OWN,
  ),
);

// Without an own address there is no name to match, and the rule stays silent
// rather than guessing.
assert.ok(!isHumanCorrespondence(conversation([message({})]), undefined));

console.log("v2-human-correspondence: OK");
