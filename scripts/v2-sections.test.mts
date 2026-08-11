/**
 * Gate: the whiteboard groups by the PART OF THE BUSINESS, not the counterparty.
 *
 * This is the distinction the board exists for. Three Roche matters — a
 * software fix, a purchase order, an invoice — belong in three different
 * sections. Grouping them by counterparty would put them in one pile and lose
 * the shape of the business, which is exactly what the previous flat Atlas did.
 */
import assert from "node:assert/strict";
import { groupIntoSections } from "../src/lib/v2/view/build.ts";
import type { MatterCard } from "../src/lib/v2/view/types.ts";

const matter = (
  title: string,
  section: string,
  orgUnit: string | null,
): MatterCard => ({
  matterId: title,
  title,
  status: "open",
  orgUnit,
  section,
  conversations: [],
  yields: [],
});

const registry = ["sales — leads", "software", "finance (ar/ap)"];

// THE CASE: one counterparty, three parts of the business.
{
  const sections = groupIntoSections(
    [
      matter("Roche stability fixes", "software", "roche"),
      matter("Roche MyBuy purchase order", "sales — leads", "roche"),
      matter("Roche invoice query", "finance (ar/ap)", "roche"),
    ],
    registry,
  );
  assert.equal(sections.length, 3, "same counterparty must still split by section");
  assert.deepEqual(
    sections.map((s) => s.name),
    registry,
    "sections follow registry order, not matter order",
  );
}

// Registry order holds regardless of the order matters arrive in.
{
  const sections = groupIntoSections(
    [
      matter("Invoice", "finance (ar/ap)", "x"),
      matter("Lead", "sales — leads", "y"),
    ],
    registry,
  );
  assert.deepEqual(sections.map((s) => s.name), ["sales — leads", "finance (ar/ap)"]);
}

// Empty shelves are not shown — a board of blank columns reads as broken.
{
  const sections = groupIntoSections([matter("Lead", "sales — leads", "y")], registry);
  assert.deepEqual(sections.map((s) => s.name), ["sales — leads"]);
}

// Unfiled work is visible, and always last so it reads as a to-do.
{
  const sections = groupIntoSections(
    [
      matter("Mystery", "unfiled", null),
      matter("Lead", "sales — leads", "y"),
    ],
    registry,
  );
  assert.deepEqual(sections.map((s) => s.name), ["sales — leads", "unfiled"]);
}

// A section outside the registry (renamed, or from an older run) still shows,
// after the registry and before unfiled, rather than vanishing with its work.
{
  const sections = groupIntoSections(
    [
      matter("Odd", "legacy-section", null),
      matter("Mystery", "unfiled", null),
      matter("Lead", "sales — leads", "y"),
    ],
    registry,
  );
  assert.deepEqual(sections.map((s) => s.name), [
    "sales — leads",
    "legacy-section",
    "unfiled",
  ]);
}

// Every matter survives grouping — none may be dropped on the floor.
{
  const input = [
    matter("a", "software", null),
    matter("b", "software", null),
    matter("c", "unfiled", null),
  ];
  const total = groupIntoSections(input, registry).reduce(
    (n, s) => n + s.matters.length,
    0,
  );
  assert.equal(total, input.length);
}

console.log("v2-sections: ok");
