/**
 * The reader carries one action row. Reply, reply-all and forward live under
 * the newest message now, so the row holds the two destructive verbs and puts
 * everything rarer behind one overflow. The participants footer is gone: a
 * thread already says who is on it.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ConversationActions } from "../src/components/v2/ConversationActions.tsx";
import { Reader } from "../src/components/v2/Reader.tsx";
import { v3Preview } from "../src/app/dev/preview/v3-sample.ts";

const noop = () => {};

const row = renderToString(
  createElement(ConversationActions, {
    provider: "microsoft",
    nativeUrl: "https://outlook.office.com/mail/inbox/id/abc",
    onArchive: noop,
    onDelete: noop,
    onMove: noop,
  }),
);

assert.match(row, /seer-actions/);
assert.match(row, />Archive</);
assert.match(row, />Delete</);
assert.match(row, /aria-haspopup="menu"/, "rarer actions sit behind one overflow");
assert.match(row, /More/);

// The reply verbs moved to the inline composer; keeping them here too was the
// duplication that made the reader read as three stacked toolbars.
assert.doesNotMatch(row, />Reply</);
assert.doesNotMatch(row, />Reply all</);
assert.doesNotMatch(row, />Forward</);
// Move and the provider escape hatch are one click away, not on the row.
assert.doesNotMatch(row, /Move to/);
assert.doesNotMatch(row, /Open in Outlook/);

// The fixture keeps everyone on one domain, which shapes the whole thread as an
// internal branch. Move the counterparty out so the trunk renders real turns.
const external = (address: { name?: string; email: string }) =>
  address.email === "you@example.com"
    ? address
    : { ...address, email: address.email.replace("example.com", "counterparty.com") };

const ssrConversation = {
  ...v3Preview.reader.conversation,
  messages: v3Preview.reader.conversation.messages.map((message) => ({
    ...message,
    bodyHtml: null,
    from: external(message.from),
    to: message.to.map(external),
  })),
};

const reader = renderToString(
  createElement(Reader, {
    provider: "microsoft",
    conversation: ssrConversation,
    ownEmail: "you@example.com",
    onReply: noop,
    onArchive: noop,
    onDelete: noop,
  } as never),
).replace(/<!--[\s\S]*?-->/g, "");

assert.match(reader, /reader-turn/, "the thread itself still renders");
assert.doesNotMatch(reader, /reader-people/, "the participants footer is gone");
assert.doesNotMatch(reader, /reader-chip/);
assert.doesNotMatch(reader, /On this/);
assert.doesNotMatch(reader, /reader-foot/, "the counting footer is gone");

const focusedReader = renderToString(
  createElement(Reader, {
    provider: "microsoft",
    conversation: ssrConversation,
    focusMessageId: "preview-m-1",
    ownEmail: "you@example.com",
    onReply: noop,
    onReplyAll: noop,
    onForward: noop,
    onArchive: noop,
    onDelete: noop,
  }),
);
assert.match(
  focusedReader,
  /data-message-id="preview-m-1"[\s\S]*?aria-expanded="true"/,
  "opening a mailbox row expands the concrete message represented by it",
);
assert.match(
  focusedReader,
  /data-message-id="preview-m-2"[\s\S]*?aria-expanded="false"/,
  "focusing an older message does not silently open the newest one instead",
);

console.log("v3-reader-actions: OK");
