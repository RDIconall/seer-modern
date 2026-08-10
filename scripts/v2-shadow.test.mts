/**
 * Task 13 gate: the cutover gate rejects on any pending/failed coverage, a false
 * safe-delete, provider-parity failure, missing native links, unpersisted
 * yields, or ANY provider mutation from shadow mode. Only a spotless report is
 * eligible.
 */
import assert from "node:assert/strict";
import { cutoverEligible, type ShadowReport } from "../src/lib/v2/shadow/report.ts";
import type { ReleaseVerdict } from "../src/lib/v2/eval/types.ts";

const cleanBenchmark: ReleaseVerdict = {
  pass: true,
  evaluations: [],
  falseSafeDeletes: 0,
  baselineRegressions: 0,
};

const clean: ShadowReport = {
  account: "a@x.com",
  coverage: { providerTotal: 100, stored: 100, read: 100, pending: 0, failed: 0 },
  benchmark: cleanBenchmark,
  providerParityPassed: true,
  missingNativeLinks: 0,
  unpersistedYields: 0,
  shadowMutations: 0,
};

// A spotless report is eligible.
{
  const d = cutoverEligible(clean);
  assert.equal(d.eligible, true);
  assert.deepEqual(d.blockers, []);
}

// Pending coverage blocks.
assert.equal(cutoverEligible({ ...clean, coverage: { ...clean.coverage, pending: 3 } }).eligible, false);

// Failed coverage blocks.
assert.equal(cutoverEligible({ ...clean, coverage: { ...clean.coverage, failed: 1 } }).eligible, false);

// A false safe-delete blocks (the cardinal sin).
{
  const d = cutoverEligible({
    ...clean,
    benchmark: { ...cleanBenchmark, pass: false, falseSafeDeletes: 1 },
  });
  assert.equal(d.eligible, false);
  assert.ok(d.blockers.some((b) => b.startsWith("false_safe_deletes")));
}

// Baseline regression blocks.
assert.equal(
  cutoverEligible({ ...clean, benchmark: { ...cleanBenchmark, pass: false, baselineRegressions: 2 } }).eligible,
  false,
);

// Missing benchmark blocks.
assert.equal(cutoverEligible({ ...clean, benchmark: null }).eligible, false);

// Provider parity failure blocks.
assert.equal(cutoverEligible({ ...clean, providerParityPassed: false }).eligible, false);

// Missing native links block.
assert.equal(cutoverEligible({ ...clean, missingNativeLinks: 1 }).eligible, false);

// Unpersisted yields block.
assert.equal(cutoverEligible({ ...clean, unpersistedYields: 1 }).eligible, false);

// ANY shadow mutation is disqualifying.
{
  const d = cutoverEligible({ ...clean, shadowMutations: 1 });
  assert.equal(d.eligible, false);
  assert.ok(d.blockers.some((b) => b.startsWith("shadow_mutations")));
}

console.log("v2-shadow: OK");
