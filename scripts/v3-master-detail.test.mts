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
assert.match(triage, /compact-mail-list/);
for (const action of ["Delete", "File", "Answer", "Keep"]) {
  assert.match(triage, new RegExp(`>${action}<`));
}
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
