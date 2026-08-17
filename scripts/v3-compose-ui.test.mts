/**
 * Compose pane UI contract: Outlook-style forward shows a read-only FW subject,
 * the quoted thread (sanitised via MessageHtml), and an attachment warning when
 * the original thread carried files. Reply hides the recipient field.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ComposePane } from "../src/components/v3/ComposePane.tsx";
import { v3Preview } from "../src/app/dev/preview/v3-sample.ts";
import type { Conversation } from "../src/lib/v2/providers/types.ts";

const noop = () => {};

/** SSR cannot sanitise HTML without a DOM, so quote bodies fall back to text. */
function forSsr(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      bodyHtml: null,
    })),
  };
}

const withAttachments = forSsr(v3Preview.reader.conversation);
assert.ok(
  withAttachments.messages.some((m) => m.attachments.length > 0),
  "fixture must include an attachment for the warning assertion",
);

const withoutAttachments: Conversation = {
  ...withAttachments,
  messages: withAttachments.messages.map((message) => ({
    ...message,
    attachments: [],
  })),
};

const forwardHtml = renderToString(
  createElement(ComposePane, {
    intent: { mode: "forward" },
    providerConversationId: withAttachments.providerConversationId,
    conversationId: "preview-c-1",
    preview: withAttachments,
    onClose: noop,
    onSent: noop,
  }),
);

assert.match(forwardHtml, /mail-compose/);
assert.match(forwardHtml, /FW:\s*RMS Amendment #01 to SOW #003/);
assert.match(
  forwardHtml,
  /mail-compose-subject[^>]*\s(?:readOnly|readonly|disabled)=/,
  "forward subject must be read-only / disabled",
);
assert.match(forwardHtml, /mail-recipient/, "forward must show the To field");
assert.match(forwardHtml, /From/);
assert.match(forwardHtml, /Sent/);
assert.match(forwardHtml, /To/);
assert.match(forwardHtml, /Sandra Yasavul/);
assert.match(
  forwardHtml,
  /countersignature is the last item/,
  "quoted thread must include the real message body text",
);
// Gmail forwards are rebuilt from the provider contract, which carries no
// attachment bytes, so the loss has to be stated before the user sends.
assert.match(
  forwardHtml,
  /Attachments from the original thread are not included in this forward/,
);

// Graph forwards the original message intact, so warning there would be a lie.
const microsoftForwardHtml = renderToString(
  createElement(ComposePane, {
    intent: { mode: "forward" },
    providerConversationId: withAttachments.providerConversationId,
    conversationId: "preview-c-1",
    preview: withAttachments,
    previewProvider: "microsoft",
    onClose: noop,
    onSent: noop,
  }),
);
assert.doesNotMatch(
  microsoftForwardHtml,
  /Attachments from the original thread are not included in this forward/,
  "Graph carries attachments through a forward; do not warn about losing them",
);
assert.match(
  microsoftForwardHtml,
  /countersignature is the last item/,
  "the quoted thread must still render for Microsoft accounts",
);

const noAttachHtml = renderToString(
  createElement(ComposePane, {
    intent: { mode: "forward" },
    providerConversationId: withoutAttachments.providerConversationId,
    conversationId: "preview-c-1",
    preview: withoutAttachments,
    onClose: noop,
    onSent: noop,
  }),
);
assert.doesNotMatch(
  noAttachHtml,
  /Attachments from the original thread are not included in this forward/,
);

const replyHtml = renderToString(
  createElement(ComposePane, {
    intent: { mode: "reply" },
    providerConversationId: withAttachments.providerConversationId,
    conversationId: "preview-c-1",
    preview: withAttachments,
    onClose: noop,
    onSent: noop,
  }),
);
assert.doesNotMatch(replyHtml, /mail-recipient/, "reply must not show To");
assert.doesNotMatch(replyHtml, /mail-compose-subject/, "reply must not show Subject");
assert.match(replyHtml, /mail-compose-quote/);

console.log("v3-compose-ui: OK");
