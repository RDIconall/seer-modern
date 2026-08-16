import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Atlas } from "../src/components/v2/Atlas.tsx";
import { sampleView } from "../src/app/dev/preview/sample.ts";

const root = process.cwd();
const atlasSource = await fs.readFile(
  path.join(root, "src/components/v2/Atlas.tsx"),
  "utf8",
);
const mailClientSource = await fs.readFile(
  path.join(root, "src/components/v3/MailClient.tsx"),
  "utf8",
);
const styles = await fs.readFile(path.join(root, "src/app/globals.css"), "utf8");

assert.match(atlasSource, /MatterDetail/, "Atlas must render an accessible detail panel");
assert.match(atlasSource, /onOpenConversation/, "Atlas must accept an in-app conversation callback");
assert.match(atlasSource, /aria-modal="true"/);
assert.match(atlasSource, /role="dialog"/);
assert.match(atlasSource, /Escape|keydown/);
assert.match(atlasSource, /shortTitle/);
assert.match(atlasSource, /nextAction/);
assert.match(atlasSource, /Conversation.*button|button[\s\S]*conversation/i);
assert.doesNotMatch(
  atlasSource,
  /target=["']_blank["']/,
  "the primary conversation action must not require a provider tab",
);
assert.match(mailClientSource, /onOpenConversation/);
assert.match(mailClientSource, /setConversationId/);
assert.match(styles, /atlas-detail/);
assert.match(styles, /@media \(max-width: 700px\)[\s\S]*atlas-detail/);

const html = renderToString(
  createElement(Atlas, {
    view: sampleView,
    onOpenConversation: () => {},
  } as never),
);
assert.match(html, /Whiteboard/);
assert.match(html, /matter-detail|matter/i);

console.log("atlas-ui-contract: OK");
