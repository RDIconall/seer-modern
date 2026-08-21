import assert from "node:assert/strict";
import {
  applyMatterOrder,
  reorderMatterSections,
} from "../src/lib/v2/view/matter-order.ts";
import type { AtlasSection, MatterCard } from "../src/lib/v2/view/types.ts";

const matter = (id: string, section: string): MatterCard =>
  ({
    matterId: id,
    title: id,
    shortTitle: id,
    status: "active",
    orgUnit: null,
    section,
    summary: "",
    nextAction: "",
    owner: "you",
    dueDate: null,
    conversations: [],
    yields: [],
  }) as MatterCard;

const sections: AtlasSection[] = [
  { name: "Sales", matters: [matter("a", "Sales"), matter("b", "Sales")] },
  {
    name: "Operations",
    matters: [matter("c", "Operations"), matter("d", "Operations")],
  },
];

const ordered = applyMatterOrder(sections, {
  Sales: ["b", "missing", "a"],
  Operations: ["d"],
});
assert.deepEqual(
  ordered[0].matters.map((item) => item.matterId),
  ["b", "a"],
);
assert.deepEqual(
  ordered[1].matters.map((item) => item.matterId),
  ["d", "c"],
  "new matters append after the user's saved order",
);

const within = reorderMatterSections(sections, {
  matterId: "b",
  targetSection: "Sales",
  beforeMatterId: "a",
});
assert.deepEqual(within.sections[0].matters.map((item) => item.matterId), [
  "b",
  "a",
]);

const moved = reorderMatterSections(sections, {
  matterId: "b",
  targetSection: "Operations",
  beforeMatterId: "d",
});
assert.deepEqual(moved.sections[0].matters.map((item) => item.matterId), ["a"]);
assert.deepEqual(
  moved.sections[1].matters.map((item) => item.matterId),
  ["c", "b", "d"],
);
assert.equal(moved.sections[1].matters[1].section, "Operations");
assert.deepEqual(moved.sourceMatterIds, ["a"]);
assert.deepEqual(moved.targetMatterIds, ["c", "b", "d"]);

console.log("v2-matter-order: OK");
