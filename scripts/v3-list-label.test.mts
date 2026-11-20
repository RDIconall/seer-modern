/**
 * Unit tests for inbox list labels and effective unread state.
 */
import assert from "node:assert/strict";
import {
  effectiveUnread,
  formatLocalPart,
  mailboxListLabel,
  nameFromEmail,
} from "../src/lib/v3/mailbox/list-label.ts";

assert.equal(formatLocalPart("may.yau"), "May Yau");
assert.equal(formatLocalPart("bob"), "Bob");
assert.equal(nameFromEmail("may.yau@example.com"), "May Yau");

assert.equal(
  mailboxListLabel({
    latestOutgoing: true,
    toEmail: "may.yau@example.com",
  }),
  "To May Yau",
);

assert.equal(
  mailboxListLabel({
    latestOutgoing: true,
    recipientDisplay: "May Yau",
    toEmail: "may.yau@example.com",
  }),
  "To May Yau",
);

assert.equal(
  mailboxListLabel({
    latestOutgoing: false,
    personDisplay: "Alice Example",
    fromEmail: "alice@example.com",
  }),
  "Alice Example <alice@example.com>",
);

assert.equal(
  mailboxListLabel({
    latestOutgoing: false,
    fromName: "Pat Colleague",
    fromEmail: "pat@elsewhere.example",
  }),
  "Pat Colleague <pat@elsewhere.example>",
  "a sender-chosen name never stands without its mailbox",
);

assert.equal(
  mailboxListLabel({ latestOutgoing: false, fromEmail: "may.yau@example.com" }),
  "may.yau@example.com",
  "an unnamed sender reads as its mailbox, not a name made from it",
);

assert.equal(effectiveUnread(true, true, false), false, "answered thread is not bold");
assert.equal(effectiveUnread(true, true, true), true, "unread outgoing reply stays bold");
assert.equal(effectiveUnread(true, false, true), true, "incoming unread stays bold");
assert.equal(effectiveUnread(false, false, false), false, "read thread stays plain");

console.log("v3-list-label: OK");
