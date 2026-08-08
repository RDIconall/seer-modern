/**
 * The Abbott case, as a test. Five parallel model calls each saw a few
 * of one company's conversations and each named the work differently;
 * Atlas showed the result as several near-identical matters, and threads
 * appeared under more than one of them.
 *
 * Run: npx tsx scripts/merge-matters.test.mts
 */
import assert from "node:assert/strict";
import { mergeMatters } from "../src/lib/inbox/matters.ts";

type Raw = {
  id: string;
  title: string;
  urgency: number;
  people: { name: string; relationship: string }[];
};

const matter = (id: string, title: string, urgency = 2): Raw => ({
  id,
  title,
  urgency,
  people: [],
});

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`);
  }
}

console.log("mergeMatters");

check("the same id from two chunks is one matter", () => {
  const out = mergeMatters([
    { m: matter("abbott-samples", "Abbott sample requests"), threads: ["t1"] },
    { m: matter("abbott-samples", "Abbott sample requests"), threads: ["t2"] },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].threads.sort(), ["t1", "t2"]);
});

check("different ids for the same work merge on title words", () => {
  const out = mergeMatters([
    { m: matter("abbott-sample-requests", "Abbott sample requests"), threads: ["t1"] },
    { m: matter("abbott-requests-2026", "Requests from Abbott for samples"), threads: ["t2"] },
  ]);
  assert.equal(out.length, 1, `expected 1 matter, got ${out.length}`);
  assert.deepEqual(out[0].threads.sort(), ["t1", "t2"]);
});

check("a shared conversation makes two matters one", () => {
  const out = mergeMatters([
    { m: matter("abbott-tbi-pediatric", "Abbott TBI pediatric donors"), threads: ["t1", "t2"] },
    { m: matter("cft-update", "CFT criteria update"), threads: ["t2", "t3"] },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].threads.sort(), ["t1", "t2", "t3"]);
});

check("no conversation appears in two matters", () => {
  const out = mergeMatters([
    { m: matter("a", "Roche anti-TPO SOW"), threads: ["t1", "t2"] },
    { m: matter("b", "Thermo Fisher pricing"), threads: ["t2", "t3"] },
    { m: matter("c", "CAP inspection"), threads: ["t4"] },
  ]);
  const all = out.flatMap((m) => m.threads);
  assert.equal(all.length, new Set(all).size, `duplicate threads: ${all.join()}`);
});

check("genuinely different work stays separate", () => {
  const out = mergeMatters([
    { m: matter("abbott-samples", "Abbott sample requests"), threads: ["t1"] },
    { m: matter("roche-sow", "Roche anti-TPO SOW execution"), threads: ["t2"] },
    { m: matter("cap-inspection", "CAP on-site inspection"), threads: ["t3"] },
  ]);
  assert.equal(out.length, 3);
});

check("the fullest account leads, and urgency is the loudest", () => {
  const out = mergeMatters([
    { m: matter("thin", "Abbott request 2026P-073", 1), threads: ["t1"] },
    {
      m: {
        ...matter("rich", "Abbott request 2026P-073 whole blood", 3),
        people: [{ name: "Ajda Guttormsen", relationship: "client — new" }],
      },
      threads: ["t1", "t2", "t3"],
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "rich");
  assert.equal(out[0].urgency, 3);
  assert.equal(out[0].people.length, 1);
});

check("a longer name for the same work merges (containment)", () => {
  const out = mergeMatters([
    { m: matter("short", "Abbott sample requests"), threads: ["t1"] },
    { m: matter("long", "Abbott K2EDTA sample request 2026P-073"), threads: ["t2"] },
  ]);
  assert.equal(out.length, 1, `expected 1 matter, got ${out.length}`);
});

check("two deals with one counterparty stay two matters", () => {
  const out = mergeMatters([
    { m: matter("tpo", "Roche anti-TPO SOW"), threads: ["t1"] },
    { m: matter("stability", "Roche stability study SOW"), threads: ["t2"] },
  ]);
  assert.equal(out.length, 2, `expected 2 matters, got ${out.length}`);
});

check("a bare company name does not swallow its matters", () => {
  const out = mergeMatters([
    { m: matter("bare", "Abbott"), threads: ["t1"] },
    { m: matter("contract", "Abbott contract negotiation"), threads: ["t2"] },
  ]);
  assert.equal(out.length, 2, `expected 2 matters, got ${out.length}`);
});

check("a matter left with no conversations is dropped", () => {
  const out = mergeMatters([
    { m: matter("big", "Abbott program"), threads: ["t1", "t2"] },
    { m: matter("dupe-by-thread", "Abbott program follow-up"), threads: ["t1"] },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].threads.sort(), ["t1", "t2"]);
});

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
