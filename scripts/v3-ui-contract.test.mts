/**
 * Task 7 gate: V3 uses one responsive mail client shell for both entry points.
 * The contract protects the business/data boundaries while leaving layout
 * details to the components and CSS.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MailClient } from "../src/components/v3/MailClient.tsx";
import { v3Preview } from "../src/app/dev/preview/v3-sample.ts";

const root = process.cwd();
const componentDir = path.join(root, "src", "components", "v3");
const files = await fs.readdir(componentDir).catch(() => []);

for (const required of [
  "MailClient.tsx",
  "Navigation.tsx",
  "FolderList.tsx",
  "SearchBox.tsx",
  "ReaderPane.tsx",
  "ComposePane.tsx",
  "useMailbox.ts",
]) {
  assert.ok(files.includes(required), `missing V3 shell file ${required}`);
}

const read = (file: string) =>
  fs.readFile(path.join(componentDir, file), "utf8");
const client = await read("MailClient.tsx");
const mailbox = await read("useMailbox.ts");
const navigation = await read("Navigation.tsx");
const reader = await read("ReaderPane.tsx");
const compose = await read("ComposePane.tsx");
const folderList = await read("FolderList.tsx");

assert.match(client, /MailClient/);
assert.match(client, /useMailbox/);
assert.match(client, /ReaderPane/);
assert.match(client, /ComposePane/);
assert.match(client, /\/api\/v3\/outbox\/.*\/undo/);
assert.match(client, /provider|failed|failure/i);
assert.match(client, /location\.hash|history\.replaceState|URLSearchParams/);
assert.match(client, /mail-folder-pane/);
assert.match(client, /mail-reader-pane/);
assert.match(client, /restoreSearch|fetchSearch/);
assert.match(client, /mobile-compose|onCompose/);
assert.match(client, /modalOpen|isMobile/);
assert.match(client, /inert/);
assert.match(client, /useSyncExternalStore/);
assert.match(client, /getServerMobileSnapshot/);
assert.match(client, /getServerHashSnapshot/);

for (const label of ["Inbox", "Sent", "Trash", "Atlas", "Triage", "Settings"]) {
  assert.match(navigation, new RegExp(label), `navigation is missing ${label}`);
}
assert.match(navigation, /bottom|mobile/i);
assert.match(navigation, /aria-label/);
assert.match(navigation, /mail-mobile-compose/);
assert.match(navigation, /onCompose/);
assert.match(navigation, /modalOpen/);
assert.match(navigation, /!modalOpen/);

assert.match(mailbox, /localStorage/);
assert.match(mailbox, /stale|cache/i);
assert.match(mailbox, /prefetch/i);
assert.match(mailbox, /adjacent|rows/i);
assert.match(mailbox, /viewForFolder|folder !==/);
assert.match(mailbox, /setView\(null\)/, "failed folder loads must clear prior rows");
assert.match(mailbox, /\/api\/v3\/mailbox/);

assert.match(reader, /Reader/);
assert.match(reader, /native|provider/i);
assert.match(reader, /aria-label/);
assert.match(reader, /aria-modal/);
assert.match(reader, /mail-reader-full/);
assert.match(reader, /onBack/);
assert.match(compose, /aria-modal/);
assert.match(compose, /onClose/);
assert.match(
  folderList,
  /return current/,
  "selection cleanup must preserve the Set reference when rows are unchanged",
);

for (const page of ["src/app/page.tsx", "src/app/m/page.tsx"]) {
  const source = await fs.readFile(path.join(root, page), "utf8");
  assert.match(source, /isV2Enabled/, `${page} must retain the V3 gate`);
  assert.match(source, /MailClient/, `${page} must render MailClient`);
  assert.doesNotMatch(source, /useMailbox|Brief/, `${page} must not import legacy mailbox UI`);
}

const allV3 = await Promise.all(
  files
    .filter((file) => file.endsWith(".tsx") || file.endsWith(".ts"))
    .map(async (file) => [file, await read(file)] as const),
);
for (const [file, source] of allV3) {
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*\/(inbox\/use-mailbox|Brief)["']/,
    `${file} must not import legacy mailbox/Brief code`,
  );
}

const ssrPreview = {
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
  initialSection: "inbox",
  initialConversationId: "preview-c-1",
  initialCompose: true,
} as never;
const ssr = renderToString(createElement(MailClient, { preview: ssrPreview }));
assert.match(ssr, /mail-folder-pane/, "SSR must include the selectable folder pane");
assert.match(ssr, /mail-reader-pane/, "SSR must include the open reader pane");
assert.match(ssr, /mail-compose/, "compose state must render ComposePane");
assert.doesNotMatch(ssr, /mail-bottom-nav/, "modal SSR must not expose bottom navigation");
assert.doesNotMatch(ssr, /mail-mobile-compose/, "modal SSR must not expose compose FAB");

const normalSsr = renderToString(
  createElement(MailClient, { preview: v3Preview }),
);
assert.match(normalSsr, /mail-bottom-nav/, "normal SSR keeps mobile navigation");
assert.match(normalSsr, /mail-mobile-compose/, "normal SSR keeps compose FAB");

const emptySentPreview = {
  ...v3Preview,
  initialSection: "sent",
  mailbox: {
    ...v3Preview.mailbox,
    sent: { folder: "sent", rows: [], total: 0, nextCursor: null },
  },
} as never;
const emptySentSsr = renderToString(createElement(MailClient, { preview: emptySentPreview }));
assert.match(emptySentSsr, /Nothing here yet/);
assert.doesNotMatch(emptySentSsr, /RMS Amendment/);

console.log("v3-ui-contract: OK");
