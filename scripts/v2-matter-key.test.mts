/**
 * Gate: conversations that are one request tie into one unit; things that
 * merely share a topic or a counterparty do NOT. Cases are taken verbatim from
 * the live run on the real inbox.
 */
import assert from "node:assert/strict";
import {
  extractCodes,
  counterpartyOf,
  matterNameFrom,
  ownTokens,
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

// --- A matter the user named themselves collects the work from every side ---
// The live run split the user's own "Canadian startup CRO monitoring lead"
// three ways because each counterparty created its own copy.
{
  const userMatter: MatterCandidate = {
    matterId: "m-user",
    title: "Canadian startup CRO monitoring lead",
    codes: [],
    counterparty: "sales — leads",
    userAuthored: true,
  };
  for (const counterparty of ["bizdevlabs", "internal", ""]) {
    const match = resolveMatterMatch(
      {
        title: "Canadian startup CRO monitoring lead",
        text: "x",
        counterparty,
      },
      [userMatter],
    );
    assert.equal(
      match?.matterId,
      "m-user",
      `a user-named matter must collect work from ${counterparty || "unknown"}`,
    );
  }
}

// --- ...but a user-named matter still does not swallow different work ---
{
  const userMatter: MatterCandidate = {
    matterId: "m-user",
    title: "Canadian startup CRO monitoring lead",
    codes: [],
    counterparty: "sales — leads",
    userAuthored: true,
  };
  const match = resolveMatterMatch(
    { title: "Roche invoicing query", text: "x", counterparty: "roche" },
    [userMatter],
  );
  assert.equal(match, null, "a different request must not join a user matter");
}

// --- THE LIVE FAILURE: a vague name must never act as a tie -------------
// The model proposed "RDI engagement / Conall call" for four UNRELATED pieces
// of internal work (a call reschedule, a contractor agreement, a networking
// follow-up, a draft contract). Same counterparty + same vague words merged
// them into one matter. The user's own name, their company, and words that
// merely say people talked count for nothing.
{
  const own = ownTokens("conall@rditrials.com");
  const existing: MatterCandidate[] = [
    {
      matterId: "m-vague",
      title: "RDI engagement / Conall call",
      codes: [],
      counterparty: "internal",
    },
  ];
  const match = resolveMatterMatch(
    {
      title: "RDI engagement / Conall call",
      text: "Amy drafted a contractor agreement and WO1 for the Centific work",
      counterparty: "internal",
      own,
    },
    existing,
  );
  assert.equal(
    match,
    null,
    "a name made of the user's own identity and talk-words must not tie work together",
  );
}

// ...while a name that shares REAL work vocabulary still ties.
{
  const own = ownTokens("conall@rditrials.com");
  const existing: MatterCandidate[] = [
    {
      matterId: "m-centific",
      title: "Centific contractor agreement",
      codes: [],
      counterparty: "internal",
    },
  ];
  const match = resolveMatterMatch(
    {
      title: "Centific contractor agreement WO1",
      text: "x",
      counterparty: "internal",
      own,
    },
    existing,
  );
  assert.equal(match?.matterId, "m-centific", "real shared work still ties");
}

// A vacuous model proposal is rejected and the name falls back to the work.
{
  const own = ownTokens("conall@rditrials.com");
  assert.equal(
    matterNameFrom(
      "RDI engagement / Conall call",
      "Re: ADLM Follow-Up – Draft Contract",
      "rubrumadvising",
      "Rubrum Advising sent RDI a draft consulting contract post-ADLM",
      own,
    ),
    "Rubrumadvising — ADLM Follow-Up – Draft Contract",
    "a relationship-shaped name is not a name; fall back to the work",
  );
  // A proposal that names actual work is kept, even when it mentions the user.
  assert.equal(
    matterNameFrom(
      "Rubrum Advising consulting contract",
      "Re: ADLM Follow-Up",
      "rubrumadvising",
      "x",
      own,
    ),
    "Rubrum Advising consulting contract",
  );
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

// --- Naming: a raw notification subject is never a matter name ---
{
  // The model's own name wins when it's a real concern.
  assert.equal(
    matterNameFrom("Roche anti-TPO pricing", "RE: something", "roche", ""),
    "Roche anti-TPO pricing",
  );
  // A transport-prefixed model name is rejected in favour of the code.
  assert.equal(
    matterNameFrom(
      "INFORM: New post in discussion: 024146-Jul2026",
      "INFORM: New post in discussion: 024146-Jul2026 by Raiane Sousa Gaspar",
      "roche",
      "discussion about RD007704 stability",
    ),
    "Roche RD007704",
  );
  // No model name, no code: strip the noise and qualify with the counterparty.
  assert.equal(
    matterNameFrom(undefined, "RE: Strep A remnant samples", "sekisui", ""),
    "Sekisui — Strep A remnant samples",
  );
  // Never returns an empty name.
  assert.equal(matterNameFrom(undefined, "", "", ""), "Untitled matter");
}

console.log("v2-matter-key: OK");
