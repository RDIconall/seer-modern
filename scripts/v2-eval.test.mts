/**
 * Task 8 gate: the release-gating comparison. A release fails when Seer is worse
 * than the naive baseline, deletes something actionable, fabricates a business
 * connection, or misses a required yield. Correct context-driven connections are
 * counted as improvements.
 */
import assert from "node:assert/strict";
import { compareDecision, releaseVerdict } from "../src/lib/v2/eval/compare.ts";
import type { EvalCase, BaselineResult } from "../src/lib/v2/eval/types.ts";
import type { Conversation } from "../src/lib/v2/providers/types.ts";

const conversation: Conversation = {
  providerConversationId: "c",
  subject: "x",
  messages: [],
  lastMessageAt: "",
};

function evalCase(over: Partial<EvalCase>): EvalCase {
  return {
    id: "case",
    conversation,
    context: { ownDomain: "x.com", people: [], matters: [], interests: [] },
    expectedHome: "delete",
    ...over,
  };
}

const baselineKeep: BaselineResult = { keep: true, hasAsk: true };
const baselineDrop: BaselineResult = { keep: false, hasAsk: false };

// False safe-delete is a failure.
{
  const e = compareDecision(
    evalCase({ expectedHome: "matter" }),
    baselineDrop,
    { home: "delete", yields: [] },
  );
  assert.equal(e.pass, false);
  assert.ok(e.failures.some((f) => f.startsWith("false_safe_delete")));
}

// Regression vs baseline: baseline keeps, Seer deletes.
{
  const e = compareDecision(evalCase({ expectedHome: "delete" }), baselineKeep, {
    home: "delete",
    yields: [],
  });
  assert.equal(e.pass, false);
  assert.ok(e.failures.some((f) => f.startsWith("baseline_regression")));
}

// Fabricated connection: a matter_connection to an unknown matter.
{
  const e = compareDecision(
    evalCase({ expectedHome: "delete", allowedMatterRefs: ["roche"] }),
    baselineDrop,
    { home: "delete", yields: [{ kind: "matter_connection", matterRef: "acme", headline: "x" }] },
  );
  assert.equal(e.pass, false);
  assert.ok(e.failures.some((f) => f.startsWith("fabricated_connection")));
}

// Missing required yield.
{
  const e = compareDecision(
    evalCase({ expectedHome: "delete", requiredYieldKinds: ["matter_connection"] }),
    baselineDrop,
    { home: "delete", yields: [] },
  );
  assert.equal(e.pass, false);
  assert.ok(e.failures.some((f) => f.startsWith("missing_yield")));
}

// A correct, context-driven connection that the baseline could not make is an
// improvement, and the case passes.
{
  const e = compareDecision(
    evalCase({ expectedHome: "delete", allowedMatterRefs: ["roche"], requiredYieldKinds: ["matter_connection"] }),
    baselineDrop,
    {
      home: "delete",
      yields: [{ kind: "matter_connection", matterRef: "Roche", headline: "FDA cleared Roche" }],
    },
  );
  assert.equal(e.pass, true);
  assert.ok(e.improvements.includes("added_correct_business_connection"));
}

// A clean delete that matches expectations and the baseline passes.
{
  const e = compareDecision(evalCase({ expectedHome: "delete" }), baselineDrop, {
    home: "delete",
    yields: [],
  });
  assert.equal(e.pass, true);
  assert.deepEqual(e.failures, []);
}

// Release verdict aggregates and counts the cardinal failures.
{
  const verdict = releaseVerdict([
    compareDecision(evalCase({ expectedHome: "matter" }), baselineDrop, { home: "delete", yields: [] }),
    compareDecision(evalCase({ expectedHome: "delete" }), baselineDrop, { home: "delete", yields: [] }),
  ]);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.falseSafeDeletes, 1);
}

console.log("v2-eval: OK");
