/**
 * Gate: opening a message must not hang on a long run of "<" with no ">".
 *
 * The reading pane decides whether HTML still has text by stripping tags with
 * /<[^>]+>/. That pattern rescans the rest of the string at every "<" when no
 * ">" ever arrives. A sender can put that run in an HTML body; sync stores it,
 * and the v3 reader runs the strip on the main thread before the message is
 * drawn. These checks fail while that strip is still superlinear and pass once
 * it is a linear scan or the HTML is capped before the scan.
 *
 * Run: tsx scripts/v3-tag-strip-dos.test.mts
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { extractKeyActions } from "../src/lib/inbox/key-actions.ts";
import { storedBodyText } from "../src/lib/v2/intelligence/html-text.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";
import { readableHtml, stripQuotedHtml } from "../src/lib/v3/reader/email-html.ts";
import {
  shapeThread,
  summariseThread,
  type Turn,
} from "../src/lib/v3/reader/thread-shape.ts";

const OWN = "victim@rditrials.com";
const OWN_DOMAIN = "rditrials.com";

/**
 * 60_000 is a small email body. On the vulnerable strip one pass takes about
 * two seconds here, and the reader does that pass more than once. A linear
 * scan of the same string finishes in well under the budget.
 */
const ATTACK_CHARS = 60_000;
const BUDGET_MS = 500;

const pureBomb = "<".repeat(ATTACK_CHARS);
const tailBomb = "<p>Hello</p>" + pureBomb;

function attackMessage(html: string, bodyText: string | null): Message {
  return {
    providerMessageId: "m-attack",
    from: { email: "sender@example.com", name: "Sender" },
    to: [{ email: OWN, name: "Victim" }],
    cc: [],
    sentAt: "2026-11-01T15:00:00.000Z",
    snippet: "preview",
    bodyHtml: html,
    bodyText,
    isUnread: true,
    isOutgoing: false,
    attachments: [],
  };
}

/** What sync persists for an HTML-only body: the raw HTML and the derived text. */
function storedHtmlOnlyConversation(html: string): Conversation {
  const message = attackMessage(html, null);
  return {
    providerConversationId: "c-attack",
    subject: "Please read",
    lastMessageAt: message.sentAt,
    messages: [attackMessage(html, storedBodyText(message))],
  };
}

/**
 * The v3 reading pane opens by shaping the thread and summarising it.
 * Reader.tsx runs both on every open, on the conversation JSON from the API.
 */
function openReadingPane(conversation: Conversation) {
  const delivered = JSON.parse(JSON.stringify(conversation)) as Conversation;
  return {
    lanes: shapeThread(delivered, OWN_DOMAIN, OWN),
    summary: summariseThread(delivered, OWN_DOMAIN, OWN),
  };
}

function elapsedMs(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

const failures: string[] = [];

function check(name: string, run: () => void) {
  try {
    const took = elapsedMs(run);
    assert.ok(
      took < BUDGET_MS,
      `${name} took ${took.toFixed(0)}ms (budget ${BUDGET_MS}ms)`,
    );
    console.log(`PASS ${name} (${took.toFixed(0)}ms)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.log(`FAIL ${name}: ${message}`);
  }
}

// Ordinary HTML still has to come through with its text. This passes today;
// it keeps a fix from deleting the reading pane to make the bomb fast.
{
  const safe = readableHtml("<p>Please review the draft.</p>");
  assert.match(safe.html, /Please review the draft/);
  const opened = openReadingPane(
    storedHtmlOnlyConversation("<p>Please review the draft.</p>"),
  );
  const turn = opened.lanes.find((lane): lane is Turn => lane.kind === "turn");
  assert.ok(turn, "a normal external message is a turn");
  assert.match(turn.body, /Please review the draft/);
  const actions = extractKeyActions(
    `<a href="https://example.com/track">track package</a>`,
  );
  assert.ok(actions.some((action) => /track/i.test(action.label)));
  console.log("PASS benign html still reads");
}

check("readableHtml on a run of <", () => {
  readableHtml(pureBomb);
});

check("readableHtml on a tag followed by a run of <", () => {
  readableHtml(tailBomb);
});

check("stripQuotedHtml visible-text check on the unquoted head", () => {
  stripQuotedHtml(`${pureBomb}\n---- Original Message ----`);
});

check("storedBodyText while sync stores an HTML-only body", () => {
  const text = storedBodyText({ bodyHtml: pureBomb, bodyText: null });
  assert.equal(typeof text, "string");
});

const storedHtmlOnly = storedHtmlOnlyConversation(pureBomb);

check("reading pane open on a stored HTML-only message", () => {
  // Sync has already stored the HTML. Time only the open, which is the tab's work.
  const opened = openReadingPane(storedHtmlOnly);
  assert.equal(opened.lanes.length, 1);
});

check("reading pane open when a short text part accompanies the HTML bomb", () => {
  const conversation: Conversation = {
    providerConversationId: "c-attack",
    subject: "Please read",
    lastMessageAt: "2026-11-01T15:00:00.000Z",
    messages: [attackMessage(tailBomb, "See below")],
  };
  openReadingPane(conversation);
});

check("extractKeyActions strips a tracking link full of <", () => {
  extractKeyActions(
    `<a href="https://example.com/track">track package ${pureBomb}</a>`,
  );
});

if (failures.length > 0) {
  console.error(`v3-tag-strip-dos: ${failures.length} failed`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("v3-tag-strip-dos: OK");
