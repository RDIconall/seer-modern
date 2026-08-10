/**
 * Gate: conversations that are one request tie into one unit; things that
 * merely share a topic or a counterparty do NOT. Cases are taken verbatim from
 * the live run on the real inbox.
 */
import assert from "node:assert/strict";
import {
  extractCodes,
  counterpartyOf,
  resolveMatterMatch,
  type MatterCandidate,
} from "../src/lib/v2/intelligence/matter-key.ts";

// --- Code extraction (the strongest identity signal) ---
assert.deepEqual(extractCodes("Roche study RD007704"), ["RD007704"]);
assert.deepEqual(extractCodes("RD 007704 testing schedule"), ["RD007704"]);
assert.deepEqual(extractCodes("RCD_2818 Transplant Drug Study"), ["RCD2818"]);
assert.ok(extractCodes("Event TZC0430556_MC negative samples").includes("TZC0430556"));
// Codes are normalized (separators stripped) so "2026P-073" and "2026P073" tie.
assert.ok(extractCodes("Abbott K2EDTA Whole Blood request 2026P-073").includes("2026P073"));
assert.deepEqual(extractCodes("Weekly shipping insights"), []);

// --- Counterparty from sender ---
assert.equal(counterpartyOf("raiane@roche.com", "rditrials.com"), "roche");
assert.equal(counterpartyOf("global.mybuy@roche.com", "rditrials.com"), "roche");
assert.equal(counterpartyOf("vendor.portal@roche.com", "rditrials.com"), "roche");
assert.equal(counterpartyOf("claire@rditrials.com", "rditrials.com"), "internal");
assert.equal(counterpartyOf("someone@gmail.com", "rditrials.com"), "");

const roche = (title: string, codes: string[] = []): MatterCandidate => ({
  matterId: `m-${title}`,
  title,
  codes,
  counterparty: "roche",
});

// --- THE CASE: four Roche Parkinson's conversations are ONE unit ---
{
  const existing = [roche("Roche Parkinson's Disease biomarker samples")];
  for (const title of [
    "Roche Parkinson's Disease biomarkers quotation",
    "Roche Parkinson's Disease biomarkers sourcing",
    "Roche Parkinson's Disease RPC ART biomarkers collection",
  ]) {
    const match = resolveMatterMatch(
      { title, text: title, counterparty: "roche" },
      existing,
    );
    assert.ok(match, `"${title}" must tie to the existing Parkinson's unit`);
    assert.equal(match?.matterId, existing[0].matterId);
  }
}

// --- Study code ties conversations even when the prose differs completely ---
{
  const existing = [roche("Sample stability programme", ["RD007704"])];
  const match = resolveMatterMatch(
    {
      title: "Required retrofits for 3rd analyzer",
      text: "FW: RMS Amendment #01 to SOW #003 RD007704 Sample Stability",
      counterparty: "roche",
    },
    existing,
  );
  assert.equal(match?.matterId, existing[0].matterId, "shared code must tie the work");
}

// --- GUARDRAIL: same counterparty, genuinely different requests stay apart ---
{
  const existing = [roche("Roche Parkinson's Disease biomarker samples")];
  for (const unrelated of [
    "Roche Vitamin D2 sourcing",
    "Roche HIV-1 serum request",
    "Roche invoicing",
  ]) {
    const match = resolveMatterMatch(
      { title: unrelated, text: unrelated, counterparty: "roche" },
      existing,
    );
    assert.equal(match, null, `"${unrelated}" must NOT merge into Parkinson's`);
  }
}

// --- GUARDRAIL: same words, different counterparty never merges ---
{
  const existing = [roche("Anti-TPO sample request")];
  const match = resolveMatterMatch(
    { title: "Anti-TPO sample request", text: "x", counterparty: "abbott" },
    existing,
  );
  assert.equal(match, null, "different counterparties must never tie together");
}

// --- GUARDRAIL: an unknown sender (no counterparty) never merges on topic ---
{
  const existing = [roche("Roche Parkinson's Disease biomarker samples")];
  const match = resolveMatterMatch(
    { title: "Parkinson's disease biomarkers", text: "x", counterparty: "" },
    existing,
  );
  assert.equal(match, null, "topic similarity alone must never tie work together");
}

// --- Automated and human mail tie identically when it's the same work ---
{
  const existing = [roche("Anti-TPO MC panel sourcing", ["TZC0430556"])];
  const match = resolveMatterMatch(
    {
      title: "INFORM: Event closed for participation",
      text: "Event TZC0430556_MC negative samples for Anti-TPO II FDA hold is closed",
      counterparty: "roche",
    },
    existing,
  );
  assert.equal(
    match?.matterId,
    existing[0].matterId,
    "a robot notice about the same event belongs to that unit",
  );
}

console.log("v2-matter-key: OK");
