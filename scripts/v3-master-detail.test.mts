import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
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

const inbox = renderToString(
  createElement(MailClient, {
    preview: {
      ...preview,
      initialSection: "inbox",
      initialConversationId: "preview-c-1",
    },
  }),
);
assert.match(inbox, /mail-workspace/);
assert.match(inbox, /mail-folder-pane/);
assert.match(inbox, /mail-reader-pane/);
assert.match(inbox, /inbox-list/);
assert.match(inbox, /Reading RMS Amendment/);
assert.doesNotMatch(inbox, /Atlas — the whiteboard/, "there is no separate Atlas board");

// The reader pane only exists once a conversation is chosen.
const closed = renderToString(
  createElement(MailClient, {
    preview: { ...preview, initialSection: "inbox" },
  }),
);
assert.doesNotMatch(closed, /mail-reader-pane/, "no conversation is open until one is chosen");

const clientSource = readFileSync(
  new URL("../src/components/v3/MailClient.tsx", import.meta.url),
  "utf8",
);
assert.match(
  clientSource,
  /<ReaderPane[\s\S]*key=\{`\$\{conversationId\}:\$\{focusedMessageId/,
  "changing rows or their target message must remount the reader instead of showing stale state",
);
const folderPane = clientSource.slice(
  clientSource.indexOf('className="mail-folder-pane"'),
  clientSource.indexOf(">", clientSource.indexOf('className="mail-folder-pane"')),
);
assert.doesNotMatch(
  folderPane,
  /aria-hidden/,
  "mobile CSS and inert hide the source pane; aria-hidden on its focused row is invalid",
);

console.log("v3-master-detail: OK");
