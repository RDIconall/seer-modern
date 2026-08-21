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

/**
 * The whiteboard, as specified: a ledger of the account in numbers, an All/Mine
 * filter, and sections of matters set as lines on paper.
 */
assert.match(html, /class="wb-ledger/, "the board states yours/out/stalled");
assert.match(html, /yours ·/);
assert.match(html, /aria-pressed="true">All</, "All is the default filter");
assert.match(html, /aria-pressed="false">Mine</);
assert.match(html, /class="wb-sec"/, "sections are paper");
assert.match(html, /class="wb-mt"/, "a matter is a titled line");
assert.match(html, /class="wb-own tabular/, "a matter says who holds it");
assert.match(html, /class="wb-foot tabular"/, "the board closes with the accounting");
assert.match(html, /Accounted \d+ of \d+/);

// One matter open at a time, and the expansion carries the next action.
assert.match(atlasSource, /openMatterId/, "the board is an accordion, not a tree");
assert.match(atlasSource, /wb-next/);

/**
 * Archiving strikes the row and keeps its place, holding an undo inline. A
 * toast that slides over the next row asks the user to catch it before it goes.
 */
assert.match(atlasSource, /wb-m-gone/);
assert.match(atlasSource, /wb-undo/);
assert.match(atlasSource, />\s*Undo\s*</);
assert.doesNotMatch(
  atlasSource,
  /Action queued/,
  "the board reports an archive on the row, not in a toast",
);

/**
 * Outreach nobody answered rolls into one line, and is kept out of the stalled
 * count. Counting mail nobody owes us a reply on as stalled work described most
 * of the board, which is the same as describing none of it.
 */
assert.match(atlasSource, /isAwaitingReply/);
assert.match(atlasSource, />Outreach, no reply</);
assert.match(atlasSource, /const STALE_DAYS = 14/, "stalled means a fortnight, not a week");
assert.match(
  atlasSource,
  /isStalled[\s\S]{0,200}!isAwaitingReply/,
  "awaiting a reply is excluded from stalled",
);

// A matter is one line: title, owner, age. No prose rides on a board row.
assert.match(atlasSource, /wb-age/);
assert.doesNotMatch(atlasSource, /<Chevron/, "a chevron per row is what made the board scroll");
assert.match(atlasSource, /draggable=/, "desktop matters can be dragged");
assert.match(atlasSource, /onDrop/, "columns accept reordered matters");
assert.match(atlasSource, /onReorderMatters/);
assert.match(atlasSource, /onMoveMatter/);

/**
 * The skin has to be worn, not just shipped. seer-skin.css defined the display
 * face, the tabular numerals and the Atlas density rules, and for a while
 * nothing referenced any of them: the board rendered in raw pixel sizes while
 * the design system sat unused in a stylesheet. A rule no element claims is
 * indistinguishable from a rule that was never written.
 */
const skin = await fs.readFile(path.join(root, "src/app/seer-skin.css"), "utf8");
assert.match(skin, /\.wb-columns/);
assert.match(
  skin,
  /@media \(min-width: 900px\)[\s\S]*grid-template-columns/,
  "desktop Atlas uses multiple columns",
);
for (const cls of ["atlas-heading", "tabular", "seer-display"]) {
  assert.match(
    skin,
    new RegExp(`\\.${cls}(?![\\w-])`),
    `seer-skin.css must define .${cls}`,
  );
  assert.match(
    atlasSource,
    new RegExp(`\\b${cls}\\b`),
    `Atlas must use .${cls} rather than restating it in raw pixels`,
  );
}

/**
 * And the inverse: every whiteboard class the board emits must have a rule.
 * This is the check the v2 app never had, which is how Triage shipped as a bare
 * table hanging off .seer-triage, a class no stylesheet ever defined.
 */
const boardClasses = new Set<string>();
for (const match of atlasSource.matchAll(/className=[{"`]([^"`}]*)/g)) {
  for (const cls of match[1].split(/[\s${}]+/)) {
    if (cls.startsWith("wb-")) boardClasses.add(cls);
  }
}
assert.ok(boardClasses.size > 0, "expected the board to declare wb-* classes");
const unstyled = [...boardClasses].filter(
  (cls) => !new RegExp(`\\.${cls}(?![\\w-])`).test(skin + styles),
);
assert.deepEqual(unstyled, [], `whiteboard classes with no rule: ${unstyled.join(", ")}`);

// Sizes belong to the six-step scale, so the board stays in proportion.
assert.doesNotMatch(
  atlasSource,
  /tabular-nums/,
  "counts use the .tabular mono face, not the Tailwind numeric variant",
);

console.log("atlas-ui-contract: OK");
