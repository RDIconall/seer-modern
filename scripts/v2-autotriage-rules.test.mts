/**
 * Golden cases from the Python triage engine, plus a reduced anonymized
 * backtest fixture: zero false delete/archive on mail he kept before the
 * cutoff, and at least 55% exact-delete catch.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classify,
  loadBundledRules,
} from "../src/lib/v2/autotriage/rules.ts";
import type { ClassifyContext } from "../src/lib/v2/autotriage/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CUT = "2026-10-17T01:30:00Z";

const rules = loadBundledRules();
const ctx: ClassifyContext = {
  correspondents: new Set([
    "lara@rditrials.com",
    "ceo@acme.com",
    "alice.q@example.com",
    "partner@rditrials.com",
    "scientist@roche.com",
    "counsel@goodwinlaw.com",
  ]),
  repliedConversations: new Set(["C1"]),
};

function action(
  addr: string,
  subject: string,
  extra: {
    conversationId?: string;
    flagged?: boolean;
    categories?: string[];
    receivedAt?: string;
  } = {},
) {
  return classify({ addr, subject, ...extra }, ctx, rules).action;
}

assert.equal(
  action("clinops@rditrials.com", "ClinOps digest"),
  "archive",
  "address rule beats allowlisted domain",
);
assert.equal(
  action("someone@roche.com", "Canceled: sync"),
  "review",
  "human at allowlisted domain is protected",
);
assert.equal(
  action("lara@rditrials.com", "Canceled: 1:1"),
  "review",
  "corresponded human is protected",
);
assert.equal(
  action("noreply@calendar.roche.com", "Canceled: x"),
  "delete",
  "Roche automated calendar can be filtered",
);
assert.equal(action("global.mybuy@roche.com", "New RFQ event"), "keep");
assert.equal(action("newsletter@labmanager.com", "Weekly"), "delete");
assert.equal(
  action("x@labmanager.com", "hi", { conversationId: "C1" }),
  "review",
  "thread he replied in is protected",
);
assert.equal(action("renewals@gusto.com", "anything"), "keep");
assert.equal(action("dse_na2@docusign.net", "Completed: MSA"), "save-doc");
assert.equal(
  action("adobesign@adobesign.com", "Signature requested on NDA"),
  "keep",
);
assert.equal(
  action("no-reply@enotices.dmvonline.ca.gov", "Registration"),
  "keep",
);
assert.equal(action("stranger@newco.io", "Quick question"), "unknown");
assert.equal(action("a@b.com", "x", { flagged: true }), "keep");
assert.equal(
  action("alerts@shop.test", "Respond today", {
    categories: ["Superhuman Respond"],
  }),
  "keep",
);

const receipt = classify(
  { addr: "hit-reply@linkedin.com", subject: "Your receipt for ads" },
  ctx,
  rules,
);
assert.equal(receipt.action, "archive", "receipt guard never deletes");
assert.match(receipt.reason, /receipt/i);

const freshCode = classify(
  {
    addr: "noreply@newco.io",
    subject: "Your verification code is 123456",
    receivedAt: "2026-10-17T12:00:00Z",
  },
  ctx,
  rules,
  { now: new Date("2026-10-17T12:30:00Z") },
);
assert.notEqual(
  freshCode.action,
  "delete",
  "fresh verification codes stay until 24h",
);

const staleCode = classify(
  {
    addr: "noreply@newco.io",
    subject: "Your verification code is 123456",
    receivedAt: "2026-10-16T10:00:00Z",
  },
  ctx,
  rules,
  { now: new Date("2026-10-17T12:00:00Z") },
);
assert.equal(staleCode.action, "delete", "verification codes delete after 24h");

type Decision = { addr: string; subj: string; act: string; t: string };
const decisions = JSON.parse(
  readFileSync(
    path.join(HERE, "../src/lib/v2/autotriage/fixtures/decisions.json"),
    "utf8",
  ),
) as Decision[];

let keptBefore = 0;
let falseOnKept = 0;
let hisDeletes = 0;
let exactDeletes = 0;

for (const row of decisions) {
  const result = classify({ addr: row.addr, subject: row.subj }, ctx, rules);
  if (row.act === "keep" && row.t < CUT) {
    keptBefore += 1;
    if (result.action === "delete" || result.action === "archive") {
      falseOnKept += 1;
    }
  }
  if (row.act === "delete") {
    hisDeletes += 1;
    if (result.action === "delete") exactDeletes += 1;
  }
}

assert.equal(keptBefore > 0, true, "fixture has a pre-cutoff kept set");
assert.equal(
  falseOnKept,
  0,
  `false delete/archive on kept set: ${falseOnKept} of ${keptBefore}`,
);
assert.equal(hisDeletes > 0, true, "fixture has deletes");
assert.equal(
  exactDeletes / hisDeletes >= 0.55,
  true,
  `exact delete catch ${exactDeletes}/${hisDeletes} below 55%`,
);

console.log("v2-autotriage-rules: OK");
