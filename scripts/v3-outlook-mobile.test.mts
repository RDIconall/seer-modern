import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import {
  MobileMailRow,
  mobileSwipeAction,
} from "../src/components/v3/MobileMailRow.tsx";

assert.equal(mobileSwipeAction(87), null);
assert.equal(mobileSwipeAction(88), "delete");
assert.equal(mobileSwipeAction(-87), null);
assert.equal(mobileSwipeAction(-88), "archive");
assert.equal(mobileSwipeAction(175, true), "delete");
assert.equal(mobileSwipeAction(176, true), "atlas");
assert.equal(mobileSwipeAction(220), "delete", "Inbox never gains an Atlas swipe");
assert.equal(mobileSwipeAction(-220, true), "archive");

const html = renderToString(
  createElement(MobileMailRow, {
    model: {
      id: "c1",
      from: "Violeta Hryhorian",
      subject: "RDI <> BDL - Weekly Report",
      preview: "Here is a report for the week",
      when: "10:25 PM",
      isUnread: true,
      attachmentCount: 1,
      threadCount: 5,
    },
    onOpen: () => {},
    onArchive: () => {},
    onDelete: () => {},
  }),
);
assert.match(html, /mobile-mail-row/);
assert.match(html, /Violeta Hryhorian/);
assert.match(html, /10:25 PM/);
assert.match(html, /Weekly Report/);
assert.match(html, /Here is a report/);
assert.match(html, /Archive/);
assert.match(html, /Delete/);
assert.match(html, /1 attachment/);
assert.match(html, />5</);

const folder = readFileSync(
  new URL("../src/components/v3/MobileMailboxList.tsx", import.meta.url),
  "utf8",
);
assert.match(folder, /<MobileMailRow/);
assert.match(folder, /type: "archive"/);
assert.match(folder, /type: "delete"/);
assert.match(folder, /onLongPress/);
assert.match(folder, /onAtlas/);
assert.match(folder, /matter-picker/);
assert.match(folder, /Let Seer place it/);
assert.match(folder, /createMatter: true/);
assert.doesNotMatch(
  folder,
  /badge:\s*triage/,
  "action-grouped Triage must not overlay a second category label on rows",
);

const client = readFileSync(
  new URL("../src/components/v3/MailClient.tsx", import.meta.url),
  "utf8",
);
assert.match(client, /isMobile[\s\S]*MobileMailboxList/);
assert.match(client, /mail-mobile-title/);

const atlas = readFileSync(
  new URL("../src/components/v2/Atlas.tsx", import.meta.url),
  "utf8",
);
assert.match(atlas, /<MobileMailRow/);

const styles = readFileSync(
  new URL("../src/app/globals.css", import.meta.url),
  "utf8",
);
assert.match(
  styles,
  /\.compact-mail-list \.mobile-mail-reveal\s*\{\s*display: none;/,
  "swipe tracks stay hidden in the desktop compact list",
);
const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 700px)"));
assert.match(
  mobileStyles,
  /\.mobile-mail-row-actions\s*\{\s*display:\s*none;/,
  "mobile Triage uses swipe and hold, not visible action buttons",
);
assert.match(
  mobileStyles,
  /\.compact-mail-group > h2 button\s*\{\s*display:\s*none;/,
  "mobile pile sweeps stay out of the Outlook-style list chrome",
);
assert.match(
  styles,
  /@media \(max-width: 700px\)[\s\S]*\.compact-mail-list \.mobile-mail-reveal\s*\{\s*display: flex;/,
  "mobile restores the swipe tracks behind each row",
);

const reader = readFileSync(
  new URL("../src/components/v2/Reader.tsx", import.meta.url),
  "utf8",
);
assert.match(reader, /mobile-reader-actions/);
assert.match(reader, /reader-turn-avatar/);
assert.match(reader, /Reply all/);

console.log("v3-outlook-mobile: OK");
