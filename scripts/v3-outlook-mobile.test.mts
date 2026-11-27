import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { InboxList } from "../src/components/v3/InboxList.tsx";
import { v3Preview } from "../src/app/dev/preview/v3-sample.ts";

const inbox = v3Preview.mailbox.inbox;
const noop = async () => [];

// The phone and the desktop share one list. It stacks each group when its pane
// is narrow, so the reader opening beside it gets the same treatment.
const html = renderToString(
  createElement(InboxList, {
    view: inbox,
    onOpen: () => {},
    onPrefetch: () => {},
    onCommands: noop,
  }),
);
assert.match(html, /Roche RD007704 stability extension/);
assert.match(html, /Dashboard redesign/);
assert.match(html, /Send Amy the estimate by Friday/, "the person's own next step shows");
assert.match(html, /Countersign RMS Amendment #01/, "Seer's wording shows where the person wrote none");
assert.match(html, /Keep for record/);
assert.match(html, /Check the steps you agree with/);
assert.doesNotMatch(html, /Do these next steps/, "the apply bar belongs to selecting");

const selected = renderToString(
  createElement(InboxList, {
    view: inbox,
    onOpen: () => {},
    onPrefetch: () => {},
    onCommands: noop,
    initialSelectedKeys: ["c:preview-c-delete", "m:preview-matter-roche"],
    initialConfirming: true,
  }),
);
assert.match(selected, /2(<!-- -->)? selected/);
assert.match(selected, /Do these next steps/);
assert.match(selected, /Is this the next step you want to do\?/);
assert.match(selected, /Delete 1 email/);
assert.match(selected, /Finish 1 matter and archive 2 emails/);

const client = readFileSync(
  new URL("../src/components/v3/MailClient.tsx", import.meta.url),
  "utf8",
);
assert.match(client, /<InboxList/);
assert.match(client, /mail-mobile-title/);

const inboxList = readFileSync(
  new URL("../src/components/v3/InboxList.tsx", import.meta.url),
  "utf8",
);
assert.match(inboxList, /MatterPicker/);
assert.match(inboxList, /BulkConfirmDialog/);

const picker = readFileSync(
  new URL("../src/components/v3/MatterPicker.tsx", import.meta.url),
  "utf8",
);
assert.match(picker, /Let Seer place it/);
assert.match(picker, /createMatter: true/);

const styles = readFileSync(
  new URL("../src/app/globals.css", import.meta.url),
  "utf8",
);
assert.match(
  styles,
  /@container \(max-width: \d+px\)\s*\{\s*\.inbox-head\s*\{\s*display: none;/,
  "a narrow Inbox drops the column header and stacks each row",
);
assert.match(styles, /\.inbox-body\s*\{\s*container-type: inline-size;/);

const reader = readFileSync(
  new URL("../src/components/v2/Reader.tsx", import.meta.url),
  "utf8",
);
assert.match(reader, /mobile-reader-actions/);
assert.match(reader, /reader-turn-avatar/);
assert.match(reader, /Reply all/);

console.log("v3-outlook-mobile: OK");
