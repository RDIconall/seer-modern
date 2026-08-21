import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MailClient } from "../src/components/v3/MailClient.tsx";
import { v3Preview } from "../src/app/dev/preview/v3-sample.ts";

const preview = {
  ...v3Preview,
  reader: {
    ...v3Preview.reader,
    conversation: {
      ...v3Preview.reader.conversation,
      messages: v3Preview.reader.conversation.messages.map((message) => ({
        ...message,
        bodyHtml: null,
      })),
    },
  },
};

const triage = renderToString(
  createElement(MailClient, {
    preview: {
      ...preview,
      initialSection: "triage",
      initialConversationId: "preview-c-1",
    },
  }),
);
assert.match(triage, /mail-workspace/);
assert.match(triage, /mail-folder-pane/);
assert.match(triage, /mail-reader-pane/);
assert.match(triage, /triage-table-compact/);
assert.match(triage, /Reading RMS Amendment/);

const atlas = renderToString(
  createElement(MailClient, {
    preview: {
      ...preview,
      initialSection: "atlas",
      initialConversationId: "preview-c-1",
    },
  }),
);
assert.match(atlas, /mail-workspace mail-atlas-workspace/);
assert.match(atlas, /aria-label="Atlas — the whiteboard"/);
assert.match(atlas, /mail-reader-pane/);
assert.match(atlas, /Reading RMS Amendment/);

console.log("v3-master-detail: OK");
