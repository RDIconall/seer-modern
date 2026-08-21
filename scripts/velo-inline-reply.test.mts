import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { InlineReply } from "../src/components/v3/InlineReply.tsx";
import { v3Preview } from "../src/app/dev/preview/v3-sample.ts";

const noop = () => {};
const common = {
  conversation: v3Preview.reader.conversation,
  providerConversationId:
    v3Preview.reader.conversation.providerConversationId,
  onActivate: noop,
  onClose: noop,
  onExpand: noop,
  onSent: noop,
};

const collapsed = renderToString(
  createElement(InlineReply, { ...common, intent: null }),
);
assert.match(collapsed, /inline-reply/);
assert.match(collapsed, />Reply</);
assert.match(collapsed, />Reply all</);
assert.match(collapsed, />Forward</);
assert.doesNotMatch(collapsed, /mail-rich-composer/);

const active = renderToString(
  createElement(InlineReply, {
    ...common,
    intent: { mode: "reply" },
  }),
);
assert.match(active, /inline-reply-editor/);
assert.match(active, /Draft with AI/);
assert.match(active, />Expand</);
assert.match(active, /Ctrl|⌘/);

const forward = renderToString(
  createElement(InlineReply, {
    ...common,
    intent: { mode: "forward" },
  }),
);
assert.match(forward, /mail-recipient/);

const reader = readFileSync(
  new URL("../src/components/v2/Reader.tsx", import.meta.url),
  "utf8",
);
assert.match(reader, /replySlot/);
assert.match(reader, /lastTurnKey/);

const pane = readFileSync(
  new URL("../src/components/v3/ReaderPane.tsx", import.meta.url),
  "utf8",
);
assert.match(pane, /<InlineReply/);
assert.match(pane, /replySlot=/);

const client = readFileSync(
  new URL("../src/components/v3/MailClient.tsx", import.meta.url),
  "utf8",
);
assert.match(client, /expanded/);
assert.match(client, /inlineIntent/);
assert.match(client, /onExpand/);

console.log("velo-inline-reply: OK");
