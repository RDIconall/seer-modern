import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  Atlas,
  atlasDragTravelled,
  atlasDropTarget,
  atlasNudgeTarget,
} from "../src/components/v2/Atlas.tsx";
import { reorderMatterSections } from "../src/lib/v2/view/matter-order.ts";
import type { AtlasSection } from "../src/lib/v2/view/types.ts";
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
const inboxHookSource = await fs.readFile(
  path.join(root, "src/components/v2/useInboxView.ts"),
  "utf8",
);
const styles = await fs.readFile(path.join(root, "src/app/globals.css"), "utf8");
const skin = await fs.readFile(path.join(root, "src/app/seer-skin.css"), "utf8");

/**
 * A matter opens as mail. The bespoke detail panel restated the row and then
 * made you click a third time to reach the thing you came for; the mail itself
 * is the view, and it belongs in the reading pane like every other message.
 */
assert.doesNotMatch(
  atlasSource,
  /MatterDetail/,
  "the matter panel is replaced by the ordinary reading pane",
);
assert.doesNotMatch(atlasSource, /aria-modal/, "opening a matter is not a modal");
assert.doesNotMatch(atlasSource, /atlas-detail/);
assert.match(
  atlasSource,
  /wb-mail/,
  "an open matter lists its conversations as mail rows",
);
assert.match(atlasSource, /onOpenConversation/, "Atlas must accept an in-app conversation callback");
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
assert.doesNotMatch(
  styles,
  /atlas-detail/,
  "the detail panel's rules go with the panel",
);

const html = renderToString(
  createElement(Atlas, {
    view: sampleView,
    onOpenConversation: () => {},
  } as never),
);
assert.match(html, /Whiteboard/);
assert.doesNotMatch(html, /role="dialog"/, "the board opens no dialog of its own");

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

// A matter line opens the latest real email directly. Atlas is the index, not
// another detail screen between the user and their mail.
assert.doesNotMatch(atlasSource, /openMatterId/);
assert.match(
  atlasSource,
  /latestConversation\(matter\)[\s\S]{0,160}onOpenConversation/,
  "clicking a matter must hand its latest corpus conversation to the reader",
);
assert.match(atlasSource, /Open latest email for/);

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
assert.doesNotMatch(
  atlasSource,
  /draggable=/,
  "one pointer path handles mouse, touch and pen; native drag forks behavior",
);
assert.match(atlasSource, /onPointerDown/, "matter handles start pointer dragging");
assert.match(atlasSource, /onPointerUp/, "matter handles commit pointer dragging");
assert.match(atlasSource, /onReorderMatters/);
assert.match(atlasSource, /onMoveMatter/);

/**
 * Mouse drag already used native HTML drag events. Touch has no reliable native
 * drag on iOS, so the handle hit-tests the row/section under the pointer and
 * sends the result through the same persisted reorder path.
 */
assert.match(atlasSource, /onPointerDown/);
assert.match(atlasSource, /document\.elementFromPoint/);
assert.match(atlasSource, /data-atlas-matter/);
assert.match(atlasSource, /data-atlas-section/);
assert.doesNotMatch(
  skin,
  /@media \(max-width: 700px\)[\s\S]*?\.wb-drag\s*\{[^}]*display:\s*none/,
  "the drag handle must remain available on touch screens",
);

/**
 * A drag is a gesture, not two isolated events. The board reads the pointer the
 * whole way across so it can say where the row will land, carry the scrollport
 * with it, and tell a press apart from a move — the three things whose absence
 * made a drop look like it had been ignored.
 */
assert.match(
  atlasSource,
  /onPointerMove/,
  "the drag must be tracked while it moves, not only where it is released",
);
assert.match(
  atlasSource,
  /DRAG_SLOP_PX/,
  "a press that never travelled must not commit a drop",
);
assert.match(atlasSource, /onPointerCancel/);
assert.match(
  atlasSource,
  /onLostPointerCapture/,
  "a capture lost mid-gesture has to put the board back",
);
assert.match(
  atlasSource,
  /requestAnimationFrame/,
  "a drag held at the edge must scroll the board to reach an off-screen section",
);
assert.match(
  atlasSource,
  /data-drop-before/,
  "the board must show the gap the matter will drop into",
);
assert.match(
  skin,
  /\.wb-m\[data-drop-before="true"\]::before/,
  "the drop indicator needs a rule, not just an attribute",
);
assert.match(skin, /\.wb-sec\[data-drop-end="true"\]::after/);

/**
 * The grip is a control. Arrow keys move a matter without a pointer at all,
 * which is the one path that cannot be lost to a cancelled gesture.
 */
assert.match(atlasSource, /ArrowUp/);
assert.match(atlasSource, /ArrowDown/);
assert.match(atlasSource, /aria-label={`Drag /);

/**
 * A drop is applied locally and confirmed by the server. Until the confirmation
 * lands the incoming view still describes the old order, and repainting from it
 * is what snapped a dragged matter back to where it started.
 */
assert.match(
  atlasSource,
  /if \(pendingMoves > 0\) return;\s*setBoardSections\(view\.sections\);/,
  "an unconfirmed move must not be repainted by the stale server view",
);

const rowElement = (row: {
  id: string;
  section: string;
  top?: number;
  height?: number;
  next?: string;
}) => {
  const matter = {
    dataset: { atlasMatter: row.id, atlasSection: row.section },
    getBoundingClientRect:
      row.top === undefined
        ? undefined
        : () => ({
            top: row.top!,
            height: row.height ?? 36,
            bottom: row.top! + (row.height ?? 36),
          }),
    nextElementSibling: row.next
      ? { dataset: { atlasMatter: row.next }, nextElementSibling: null }
      : null,
  };
  return {
    closest(selector: string) {
      return selector === "[data-atlas-matter]" ? matter : null;
    },
  } as unknown as Element;
};

assert.deepEqual(atlasDropTarget(rowElement({ id: "matter-2", section: "sales" })), {
  section: "sales",
  beforeMatterId: "matter-2",
});

// Above the midpoint the matter goes in ahead of the row under the pointer;
// below it, after. Treating any touch of a row as "insert before" landed every
// drop one place high and made the foot of a section unreachable.
const midRow = { id: "matter-2", section: "sales", top: 100, height: 36, next: "matter-3" };
assert.deepEqual(atlasDropTarget(rowElement(midRow), 110), {
  section: "sales",
  beforeMatterId: "matter-2",
});
assert.deepEqual(atlasDropTarget(rowElement(midRow), 130), {
  section: "sales",
  beforeMatterId: "matter-3",
});
assert.deepEqual(
  atlasDropTarget(
    rowElement({ id: "matter-9", section: "sales", top: 100, height: 36 }),
    130,
  ),
  { section: "sales", beforeMatterId: null },
  "past the last row a drop appends to the section",
);

const columnElement = {
  closest(selector: string) {
    return selector === "[data-atlas-section]"
      ? { dataset: { atlasSection: "sales" } }
      : null;
  },
} as unknown as Element;
assert.deepEqual(atlasDropTarget(columnElement, 400), {
  section: "sales",
  beforeMatterId: null,
});
assert.equal(atlasDropTarget(null), null);

/**
 * A tap on the grip is a tap. Every pixel of travel counting as a drag is what
 * let a scroll that started on the handle finish as a move of the matter.
 */
assert.equal(atlasDragTravelled({ x: 10, y: 10 }, { x: 11, y: 12 }), false);
assert.equal(atlasDragTravelled({ x: 10, y: 10 }, { x: 10, y: 16 }), true);
assert.equal(atlasDragTravelled({ x: 10, y: 10 }, { x: 2, y: 10 }), true);

/**
 * Arrow keys move a matter one place, and the place has to be the next one:
 * an off-by-one here reads as the board refusing to move the row at all.
 */
const ids = ["a", "b", "c"];
assert.equal(atlasNudgeTarget(ids, "a", -1), null, "the first row cannot go up");
assert.equal(atlasNudgeTarget(ids, "c", 1), null, "the last row cannot go down");
assert.equal(atlasNudgeTarget(ids, "nope", 1), null);

const nudged = (matterId: string, delta: -1 | 1) => {
  const sections: AtlasSection[] = [
    {
      name: "sales",
      matters: ids.map(
        (id) =>
          ({ matterId: id, section: "sales", conversations: [] }) as never,
      ),
    } as AtlasSection,
  ];
  const target = atlasNudgeTarget(ids, matterId, delta);
  assert.ok(target, `expected ${matterId} to move`);
  return reorderMatterSections(sections, {
    matterId,
    targetSection: "sales",
    beforeMatterId: target.beforeMatterId,
  }).targetMatterIds;
};
assert.deepEqual(nudged("b", -1), ["b", "a", "c"], "up swaps with the row above");
assert.deepEqual(nudged("b", 1), ["a", "c", "b"], "down swaps with the row below");
assert.deepEqual(nudged("a", 1), ["b", "a", "c"]);
assert.deepEqual(nudged("c", -1), ["a", "c", "b"]);
assert.match(
  inboxHookSource,
  /if \(disabled\)[\s\S]{0,220}optimistic: true/,
  "the backend-less preview must keep optimistic drag order visible",
);

/**
 * The skin has to be worn, not just shipped. seer-skin.css defined the display
 * face, the tabular numerals and the Atlas density rules, and for a while
 * nothing referenced any of them: the board rendered in raw pixel sizes while
 * the design system sat unused in a stylesheet. A rule no element claims is
 * indistinguishable from a rule that was never written.
 */
assert.match(skin, /\.wb-columns/);
assert.match(
  skin,
  /@media \(min-width: 900px\)[\s\S]*grid-template-columns/,
  "desktop Atlas uses multiple columns",
);

/**
 * A column must not become its own sticky scrollport. `.wb-shead` was written to
 * stick under the page chrome at 67px; put it inside a clipped column and it is
 * pushed 67px down that column instead, which strands the first matter above the
 * heading and hides another one behind it.
 */
const columnRule = skin.slice(
  skin.indexOf(".wb-column {"),
  skin.indexOf("}", skin.indexOf(".wb-column {")),
);
assert.doesNotMatch(
  columnRule,
  /overflow:\s*(hidden|clip|auto|scroll)/,
  "a clipped column re-anchors the sticky section heading inside it",
);
assert.match(
  skin,
  /\.wb-columns \.wb-shead \{[^}]*position:\s*static/,
  "inside a column the heading is the card's own header, not a floating rail",
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
