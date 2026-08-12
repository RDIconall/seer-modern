import assert from "node:assert/strict";
import {
  compactMatterTitle,
  isValidShortTitle,
  nameMatterBatch,
  type MatterNamingInput,
} from "../src/lib/v2/intelligence/matter-namer.ts";

const inputs: MatterNamingInput[] = [
  {
    id: "roche-1",
    title: "Roche diagnostic development laboratory medicine introductions and sourcing",
    shortTitle: null,
    shortTitleSource: null,
    shortTitleVersion: null,
    counterparty: "roche.com",
    section: "sales — leads",
    conversations: [
      { subject: "ADLM 2026 introductions", summary: "Coordinate introductions at ADLM." },
      { subject: "IgG sourcing request", summary: "Roche asked for IgG sourcing options." },
    ],
  },
  {
    id: "roche-2",
    title: "Roche diagnostic development laboratory medicine introductions and sourcing",
    shortTitle: "Board-approved Roche phrase",
    shortTitleSource: "user",
    shortTitleVersion: 1,
    counterparty: "roche.com",
    section: "sales — leads",
    conversations: [{ subject: "IgG sourcing", summary: "Confirm supplier availability." }],
  },
];

assert.equal(isValidShortTitle("follow-up"), false, "generic engagement alone is invalid");
assert.equal(isValidShortTitle("A very long matter phrase with too many useful words here"), false);
assert.equal(isValidShortTitle("Roche ADLM introductions"), true);

const fallbackA = compactMatterTitle({
  title: inputs[0].title,
  counterparty: inputs[0].counterparty,
  subject: inputs[0].conversations[0].subject,
});
const fallbackB = compactMatterTitle({
  title: inputs[0].title,
  counterparty: inputs[0].counterparty,
  subject: inputs[0].conversations[0].subject,
});
assert.equal(fallbackA, fallbackB, "fallback must be deterministic");
assert.ok(isValidShortTitle(fallbackA), "fallback must satisfy short-title rules");

const modelCalls: MatterNamingInput[][] = [];
const named = await nameMatterBatch(inputs, async (batch) => {
  modelCalls.push(batch);
  return [
    { id: "roche-1", shortTitle: "follow-up" },
    { id: "roche-2", shortTitle: "Overwritten user title" },
  ];
});

assert.equal(modelCalls.length, 1, "active board must be named in one injected batch");
assert.equal(modelCalls[0].length, 2);
assert.equal(
  named.find((matter) => matter.id === "roche-2")?.shortTitle,
  "Board-approved Roche phrase",
  "user title must never be overwritten",
);
const inferred = named.find((matter) => matter.id === "roche-1")!;
assert.ok(isValidShortTitle(inferred.shortTitle));
assert.notEqual(inferred.shortTitle.toLowerCase(), "follow-up");
assert.equal(new Set(named.map((matter) => matter.shortTitle.toLowerCase())).size, named.length);

const missing = await nameMatterBatch([
  {
    ...inputs[0],
    id: "missing",
    shortTitle: null,
    shortTitleSource: null,
    shortTitleVersion: null,
  },
], async () => []);
assert.ok(isValidShortTitle(missing[0].shortTitle));

console.log("atlas-matter-namer: OK");
