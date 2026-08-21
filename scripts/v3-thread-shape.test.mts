/**
 * Gate: a conversation has two lanes and reads as new text only.
 *
 * The trunk is what the counterparty sees. A branch is the forward to a
 * colleague and everything it produced. Flattened together, following what the
 * customer knows means wading through your own team's working out — and by the
 * sixth turn the same paragraph is on the screen six times.
 */
import assert from "node:assert/strict";
import {
  conversationFiles,
  freshBody,
  isInternal,
  participants,
  shapeThread,
  stripQuoted,
  summariseThread,
  type Branch,
  type Turn,
} from "../src/lib/v3/reader/thread-shape.ts";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Reader } from "../src/components/v2/Reader.tsx";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";

const OWN = "conall@rditrials.com";
const OWN_DOMAIN = "rditrials.com";

let seq = 0;
function msg(over: Partial<Message>): Message {
  seq += 1;
  return {
    providerMessageId: `m${seq}`,
    from: { email: "priya@lumos.com", name: "Priya Vance" },
    to: [{ email: OWN, name: "Conall Arora" }],
    cc: [],
    sentAt: "2026-08-04T09:00:00.000Z",
    snippet: "",
    bodyHtml: null,
    bodyText: "",
    isUnread: false,
    isOutgoing: false,
    attachments: [],
    ...over,
  };
}

const conv = (messages: Message[]): Conversation => ({
  providerConversationId: "c1",
  subject: "Change order",
  messages,
  lastMessageAt: messages[messages.length - 1]?.sentAt ?? "",
});

// --- quoted history ----------------------------------------------------------

{
  const { text, quotedCount } = stripQuoted(
    [
      "Any movement on this? Our board packet closes on the 22nd.",
      "",
      "On Friday, 8 August 2026 at 10:57, Conall Arora wrote:",
      "> We are costing it now.",
      "> I should have a number this week.",
    ].join("\n"),
  );
  assert.equal(text, "Any movement on this? Our board packet closes on the 22nd.");
  assert.equal(quotedCount, 1, "one quoted message underneath");
}

// Several stacked quotes are counted as several, which is the number the reader
// actually wants: how much history is under the fold.
{
  const { quotedCount } = stripQuoted(
    [
      "Third reply.",
      "On Fri, A wrote:",
      "> second",
      "On Thu, B wrote:",
      "> first",
    ].join("\n"),
  );
  assert.equal(quotedCount, 2);
}

// Outlook's divider and its header block count too.
assert.equal(stripQuoted("New text\n-----Original Message-----\nFrom: A\nold").quotedCount >= 1, true);
assert.equal(stripQuoted("New text\n-----Original Message-----\nFrom: A\nold").text, "New text");

// Mail with no quoting is left exactly as it is.
{
  const { text, quotedCount } = stripQuoted("Just one paragraph.");
  assert.equal(text, "Just one paragraph.");
  assert.equal(quotedCount, 0);
}

// A message that is nothing but a quote still renders something.
{
  const body = freshBody(msg({ bodyText: "> only quoted", snippet: "only quoted" }));
  assert.equal(body.text, "only quoted");
}

// --- internal vs external ----------------------------------------------------

assert.equal(
  isInternal(
    msg({
      from: { email: OWN, name: "You" },
      to: [{ email: "lara@rditrials.com", name: "Lara" }],
    }),
    OWN_DOMAIN,
  ),
  true,
  "everyone inside the company is a branch",
);

assert.equal(
  isInternal(
    msg({
      from: { email: OWN, name: "You" },
      to: [
        { email: "lara@rditrials.com", name: "Lara" },
        { email: "priya@lumos.com", name: "Priya" },
      ],
    }),
    OWN_DOMAIN,
  ),
  false,
  "one outsider on the cc and the counterparty can see it",
);

assert.equal(isInternal(msg({}), OWN_DOMAIN), false);

// --- the two lanes -----------------------------------------------------------

const thread = conv([
  msg({
    bodyText: "Two extra visits at weeks 12 and 20 — can you reprice?",
    sentAt: "2026-08-04T09:00:00.000Z",
  }),
  msg({
    from: { email: OWN, name: "Conall Arora" },
    to: [{ email: "lara@rditrials.com", name: "Lara Bennett" }],
    isOutgoing: true,
    bodyText: "Lara — can you reprice this?",
    sentAt: "2026-08-04T10:00:00.000Z",
  }),
  msg({
    from: { email: "lara@rditrials.com", name: "Lara Bennett" },
    to: [{ email: OWN, name: "Conall Arora" }],
    bodyText: "Costed at +14.2%.",
    sentAt: "2026-08-06T10:00:00.000Z",
  }),
  msg({
    from: { email: OWN, name: "Conall Arora" },
    isOutgoing: true,
    to: [{ email: "priya@lumos.com", name: "Priya Vance" }],
    bodyText: "Priya — we are costing it now.\n\nOn Tue, Priya wrote:\n> two extra visits",
    sentAt: "2026-08-08T10:00:00.000Z",
  }),
  msg({
    // The newest turn quotes the whole thread back, as real replies do.
    bodyText:
      "Any movement? Our board packet closes the 22nd.\n\n" +
      "On Fri, 8 August 2026, Conall Arora wrote:\n> we are costing it now",
    sentAt: "2026-08-14T10:00:00.000Z",
  }),
]);

const lanes = shapeThread(thread, OWN_DOMAIN, OWN);
assert.deepEqual(
  lanes.map((lane) => lane.kind),
  ["turn", "branch", "turn", "turn"],
  "consecutive internal mail collapses into one branch on the trunk",
);

const branch = lanes[1] as Branch;
assert.equal(branch.turns.length, 2, "the forward and the reply it drew");
assert.equal(branch.to, "Lara Bennett", "the branch names who it went to");
assert.equal(branch.turns[0].isYou, true);
assert.equal(branch.turns[1].who, "Lara Bennett");

const yourTurn = lanes[2] as Turn;
assert.equal(yourTurn.who, "You");
assert.equal(yourTurn.body, "Priya — we are costing it now.", "the trunk carries new text only");
assert.equal(yourTurn.quotedCount, 1);
assert.equal(yourTurn.peek, "Priya — we are costing it now.");

// A mail whose whole body sits inside layout blockquotes still reads. Zoho
// nests one per send, and treating the tag as a quote left the reader with a
// greeting and a count of history that was never there.
{
  const zoho = msg({
    bodyText: null,
    bodyHtml:
      `<div>Hi Conall,<br></div>` +
      `<blockquote id="blockquote_zmail" style="margin:0px">` +
      `<blockquote id="x_890740167blockquote_zmail" style="margin:0px">` +
      `<div>We built a platform where you can showcase your services.</div>` +
      `<div>Regards,<br>Joseph</div>` +
      `</blockquote></blockquote>`,
    snippet: "Hi Conall,",
  });
  const body = freshBody(zoho);
  assert.match(body.html!, /showcase your services/, "the mail is not cut to its greeting");
  assert.match(body.text, /showcase your services/, "the peek text agrees with the body");
  assert.equal(body.quotedCount, 0, "layout indentation is not quoted history");
}

// --- files, once -------------------------------------------------------------

const withFiles = conv([
  msg({
    attachments: [
      { id: "a1", filename: "CO v3.pdf", mimeType: "application/pdf", sizeBytes: 1000 },
    ],
  }),
  msg({
    attachments: [
      { id: "a2", filename: "CO v3.pdf", mimeType: "application/pdf", sizeBytes: 2000 },
      { id: "a3", filename: "model.xlsx", mimeType: "application/vnd.ms-excel", sizeBytes: 41000 },
    ],
  }),
]);
const files = conversationFiles(withFiles);
assert.equal(files.length, 2, "one entry per name, not per message");
const co = files.find((f) => f.filename === "CO v3.pdf")!;
assert.equal(co.versions, 2, "a re-sent document is counted as a version");
assert.equal(co.attachmentId, "a2", "the newest copy is the one offered");
assert.equal(co.sizeBytes, 2000);

// --- who is on it ------------------------------------------------------------

const people = participants(thread, OWN_DOMAIN, OWN);
assert.ok(people.some((p) => p.isYou && p.name === "You"));
assert.equal(people.find((p) => p.email === "priya@lumos.com")?.org, "lumos");
assert.equal(people.find((p) => p.email === "lara@rditrials.com")?.org, "internal");

// Someone on the first messages and off the last third has dropped off.
{
  const dropped = conv([
    msg({ to: [{ email: OWN }, { email: "dan@lumos.com", name: "Dan Rowe" }] }),
    msg({ to: [{ email: OWN }, { email: "dan@lumos.com", name: "Dan Rowe" }] }),
    msg({ to: [{ email: OWN }] }),
    msg({ to: [{ email: OWN }] }),
    msg({ to: [{ email: OWN }] }),
    msg({ to: [{ email: OWN }] }),
  ]);
  const dan = participants(dropped, OWN_DOMAIN, OWN).find(
    (p) => p.email === "dan@lumos.com",
  );
  assert.equal(dan?.droppedOff, true, "Dan stopped being on it");
  const priya = participants(dropped, OWN_DOMAIN, OWN).find(
    (p) => p.email === "priya@lumos.com",
  );
  assert.equal(priya?.droppedOff, false, "the sender is still on it");
}

// --- the summary -------------------------------------------------------------

{
  const now = Date.parse("2026-08-24T10:00:00.000Z");
  const s = summariseThread(thread, OWN_DOMAIN, OWN, now);
  assert.equal(s.external, 3);
  assert.equal(s.internal, 2);
  assert.equal(s.waitingOn, "Priya Vance", "the counterparty wrote last and got no answer");
  assert.equal(s.daysUnanswered, 10);
}

// When you answered last, nobody is waiting on you.
{
  const answered = conv([
    msg({ bodyText: "Question?", sentAt: "2026-08-01T10:00:00.000Z" }),
    msg({
      from: { email: OWN, name: "Conall Arora" },
      isOutgoing: true,
      to: [{ email: "priya@lumos.com" }],
      bodyText: "Answer.",
      sentAt: "2026-08-02T10:00:00.000Z",
    }),
  ]);
  const s = summariseThread(answered, OWN_DOMAIN, OWN, Date.parse("2026-08-10T10:00:00.000Z"));
  assert.equal(s.waitingOn, null);
  assert.equal(s.daysUnanswered, null);
}

// --- the reader renders both lanes ------------------------------------------

{
  const rendered = renderToString(
    createElement(Reader, {
      provider: "microsoft",
      conversation: thread,
      ownEmail: OWN,
      onReply() {},
      onReplyAll() {},
      onForward() {},
      onArchive() {},
      onDelete() {},
    } as never),
  );
  // React separates adjacent text nodes with comments; strip them so the
  // assertions read the sentence the user sees.
  const html = rendered.replace(/<!--[\s\S]*?-->/g, "");

  // The trunk and the branch are different things on the page, not one list.
  assert.match(html, /reader-turn/, "external turns render on the trunk");
  assert.match(html, /reader-branch/, "internal mail renders as a branch");
  assert.match(html, /INTERNAL/);
  assert.match(html, /You forwarded to Lara Bennett/);

  // Closed turns show one line; the newest stands open.
  assert.match(html, /reader-turn-peek/, "closed turns show a single line");

  // Quoted history is counted, not re-read.
  assert.match(html, /quoted message/, "the reader says how much history is hidden");

  // Who is waiting still leads the reader; the participants footer does not.
  assert.match(html, /has had no reply/);
  assert.doesNotMatch(html, /reader-chip/);
}

console.log("v3-thread-shape: OK");
