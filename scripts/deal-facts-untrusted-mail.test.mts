/**
 * Deal facts must not ride along on mail just because the subject, preview,
 * or guide task cites a study/opportunity code.
 *
 * A sender is tied to an opportunity only when opportunity.owner is that
 * sender's email address (case-insensitive). A sender is tied to a study
 * only when a site for that study code has an investigator value containing
 * that sender's email address. The display name is not a tie: the attacker
 * chooses it. These tests expect the registry label and the live account,
 * stage, amount, close date, status, and investigator names to be copied
 * only for a tied sender. Anyone else keeps the code as an untrusted
 * string, with none of those fields stored on the row.
 *
 * The model call is stubbed (scripts/deal-facts-ai-stub.mjs, wired by
 * scripts/deal-facts-tsconfig.json). Clustering only decides which ids
 * land in a matter; the assertions are on the registry copy that
 * buildBrief performs after that call.
 *
 * Run:
 *   ./node_modules/.bin/tsx --tsconfig scripts/deal-facts-tsconfig.json \
 *     scripts/deal-facts-untrusted-mail.test.mts
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EmailItem, Guide } from "../src/lib/inbox/types.ts";
import type { UnderstandingMap } from "../src/lib/inbox/understanding.ts";
import type { SalesforceRegistry } from "../src/lib/crm/registry.ts";

for (const key of [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "SEER_V2_DATABASE_URL",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
]) {
  delete process.env[key];
}
process.env.SEER_DATA_DIR = mkdtempSync(
  path.join(tmpdir(), "seer-deal-facts-"),
);

const { buildBrief } = await import("../src/lib/inbox/matters.ts");
const { saveSalesforce } = await import("../src/lib/store/salesforce.ts");
const { createMatter } = await import("../src/lib/store/manual-matters.ts");
const { compileEmailContext } = await import("../src/lib/brain/context.ts");
const { buildExportRows, toCsv } = await import("../src/lib/inbox/export.ts");

const BUYER = "buyer@northwind.example";
const PI = "pi@northwind.example";
const ATTACKER = "phish@unrelated.test";
const OPP_CODE = "RFQ44021";
const STUDY_CODE = "RCD_2818";
const CLOSED_CODE = "RFQ44022";

const PRIVATE = [
  "Northwind Therapeutics",
  "Kinetic panel",
  "$2.5M",
  "Negotiation/Review",
  "2026-12-15",
  "Cardio kinetic assay",
  "Priya Raman",
  "Enrolling",
  "Awarded panel",
  "$880k",
  "Closed Won",
  "2026-01-02",
];

const REGISTRY: SalesforceRegistry = {
  studies: [
    {
      code: "RCD_2818",
      name: "Cardio kinetic assay",
      account: "Northwind Therapeutics",
      status: "Enrolling",
    },
  ],
  opportunities: [
    {
      code: "RFQ 44021",
      name: "Kinetic panel",
      account: "Northwind Therapeutics",
      stage: "Negotiation/Review",
      amount: 2_500_000,
      closeDate: "2026-12-15",
      owner: BUYER,
    },
    {
      code: "RFQ44022",
      name: "Awarded panel",
      account: "Northwind Therapeutics",
      stage: "Closed Won",
      amount: 880_180,
      closeDate: "2026-01-02",
      owner: BUYER,
    },
  ],
  sites: [
    {
      name: "Site 14",
      investigator: `Priya Raman <${PI}>`,
      city: "Austin",
      studyCode: "RCD_2818",
      status: "Active",
    },
  ],
  source: "report",
};

function norm(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function mail(input: {
  id: string;
  fromEmail: string;
  fromName?: string;
  subject?: string;
  snippet?: string;
  threadId?: string;
  receivedAt?: string;
  task?: string;
}): EmailItem {
  const guide = input.task
    ? ({ task: input.task } as Guide)
    : undefined;
  return {
    id: input.id,
    threadId: input.threadId ?? input.id,
    fromEmail: input.fromEmail,
    fromName: input.fromName ?? "Outside Sender",
    subject: input.subject ?? "Hello",
    snippet: input.snippet ?? "A short note with no code.",
    receivedAt: input.receivedAt ?? "2026-11-20T15:00:00.000Z",
    isUnread: true,
    ...(guide ? { guide } : {}),
  };
}

function clusterAs(emailId: string) {
  process.env.SEER_TEST_CLUSTER_MODE = "include";
  process.env.SEER_TEST_MATTER_JSON = JSON.stringify({
    id: `matter-${emailId}`,
    title: "Inbound request",
    goal: "Decide whether this request is real",
    category: "read",
    orgUnit: "operations — studies",
    orgConfidence: 0.4,
    people: [],
    narrative: "A sender asked about a code.",
    nextAction: "Check who this is",
    owner: "you",
    urgency: 2,
    status: "active",
    emailIds: [emailId],
  });
}

function clusterFails() {
  process.env.SEER_TEST_CLUSTER_MODE = "throw";
  delete process.env.SEER_TEST_MATTER_JSON;
}

let seq = 0;
function account(): string {
  seq += 1;
  return `owner-${seq}@desk.example`;
}

async function rebuild(
  items: EmailItem[],
  understanding: UnderstandingMap = {},
  known: string[] = [],
) {
  const who = account();
  await saveSalesforce(who, REGISTRY);
  const brief = await buildBrief(
    who,
    items,
    null,
    null,
    understanding,
    new Set(known),
  );
  return { who, brief };
}

function assertNoPrivate(label: string, value: unknown) {
  const text = JSON.stringify(value);
  for (const fact of PRIVATE) {
    assert.equal(
      text.includes(fact),
      false,
      `${label} stored registry fact "${fact}"`,
    );
  }
}

function assertUntrustedCode(label: string, subUnit: string | undefined, code: string) {
  assert.ok(subUnit, `${label} dropped the code`);
  assert.equal(
    norm(subUnit),
    norm(code),
    `${label} subUnit ${JSON.stringify(subUnit)} is not the untrusted code ${code}`,
  );
}

function matterFor(brief: Awaited<ReturnType<typeof buildBrief>>, emailId: string) {
  return brief.matters.find((m) => m.emailIds.includes(emailId));
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.error(
      `  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`,
    );
  }
}

await check(
  "filed attacker subject does not take the opportunity label",
  async () => {
    clusterFails();
    const item = mail({
      id: "a-subject",
      fromEmail: ATTACKER,
      fromName: "Pat Example",
      subject: `Question about ${OPP_CODE}`,
    });
    const { brief } = await rebuild([item]);
    const filed = brief.filed.find((row) => row.emailId === item.id);
    assert.ok(filed, "attacker mail was not filed");
    assertUntrustedCode("filed subject", filed.subUnit, OPP_CODE);
    assertNoPrivate("filed subject", filed);
    const csv = toCsv(buildExportRows(brief));
    assert.equal(csv.includes(ATTACKER), true);
    assertNoPrivate("inbox csv", csv);
  },
);

await check(
  "filed attacker preview does not take the study label",
  async () => {
    clusterFails();
    const item = mail({
      id: "a-preview",
      fromEmail: ATTACKER,
      subject: "Quick question",
      snippet: "Can you look at rcd-2818 when you have a moment?",
    });
    const { brief } = await rebuild([item]);
    const filed = brief.filed.find((row) => row.emailId === item.id);
    assert.ok(filed, "attacker mail was not filed");
    assertUntrustedCode("filed preview", filed.subUnit, STUDY_CODE);
    assertNoPrivate("filed preview", filed);
    assertNoPrivate("preview csv", toCsv(buildExportRows(brief)));
  },
);

await check(
  "clustered attacker message does not receive live opportunity facts",
  async () => {
    const item = mail({
      id: "a-cluster",
      fromEmail: ATTACKER,
      fromName: BUYER,
      subject: "Re: rfq-44021",
      snippet: "Sending the wire details for this opportunity.",
    });
    clusterAs(item.id);
    const { brief } = await rebuild([item]);
    const matter = matterFor(brief, item.id);
    assert.ok(matter, "attacker mail was not placed in a matter");
    assert.equal(matter.crm?.amount, undefined);
    assert.equal(matter.crm?.stage, undefined);
    assert.equal(matter.crm?.account, undefined);
    assert.equal(matter.crm?.closeDate, undefined);
    assert.equal(matter.crm?.investigators, undefined);
    assertUntrustedCode("clustered subject", matter.subUnit, OPP_CODE);
    assertNoPrivate("clustered matter", matter);
    const exported = buildExportRows(brief).find(
      (row) => row.fromEmail === ATTACKER,
    );
    assert.ok(exported, "attacker row missing from export");
    assertUntrustedCode("export subUnit", exported.subUnit, OPP_CODE);
    assertNoPrivate("cluster csv", toCsv(buildExportRows(brief)));
  },
);

await check(
  "clustered attacker preview does not receive investigators",
  async () => {
    const item = mail({
      id: "a-investigators",
      fromEmail: ATTACKER,
      subject: "Site update",
      snippet: "The packet for RCD 2818 is attached.",
    });
    clusterAs(item.id);
    const { brief } = await rebuild([item]);
    const matter = matterFor(brief, item.id);
    assert.ok(matter, "study mail was not placed in a matter");
    assert.equal(matter.crm?.investigators, undefined);
    assert.equal(matter.crm?.status, undefined);
    assert.equal(matter.crm?.account, undefined);
    assertUntrustedCode("study preview", matter.subUnit, STUDY_CODE);
    assertNoPrivate("study matter", matter);
  },
);

await check(
  "guide task is not a second channel for registry facts",
  async () => {
    const item = mail({
      id: "a-task",
      fromEmail: ATTACKER,
      subject: "Following up",
      snippet: "Please see the note below.",
      task: `Do it: confirm ${OPP_CODE}`,
    });
    clusterAs(item.id);
    const { brief } = await rebuild([item]);
    const matter = matterFor(brief, item.id);
    assert.ok(matter, "task mail was not placed in a matter");
    assert.equal(matter.crm?.amount, undefined);
    assertUntrustedCode("guide task", matter.subUnit, OPP_CODE);
    assertNoPrivate("guide task", matter);
  },
);

await check(
  "a closed stage on the cited opportunity does not relabel the attacker",
  async () => {
    const item = mail({
      id: "a-closed",
      fromEmail: ATTACKER,
      subject: `Status ${CLOSED_CODE}`,
    });
    clusterAs(item.id);
    const { brief } = await rebuild([item]);
    const matter = matterFor(brief, item.id);
    assert.ok(matter, "closed-code mail was not placed in a matter");
    assert.notEqual(matter.status, "looks-closed");
    assert.equal(matter.crm?.stage, undefined);
    assert.equal(matter.crm?.amount, undefined);
    assertUntrustedCode("closed code", matter.subUnit, CLOSED_CODE);
    assertNoPrivate("closed matter", matter);
  },
);

await check(
  "newest attacker message does not inherit facts from an older tied sender",
  async () => {
    const older = mail({
      id: "thread-old",
      threadId: "thread-1",
      fromEmail: BUYER,
      fromName: "Buyer",
      subject: "Intro",
      snippet: "Nice to meet you.",
      receivedAt: "2026-11-19T12:00:00.000Z",
    });
    const newer = mail({
      id: "thread-new",
      threadId: "thread-1",
      fromEmail: ATTACKER,
      fromName: "Buyer",
      subject: `Following up on ${OPP_CODE}`,
      receivedAt: "2026-11-20T18:00:00.000Z",
    });
    clusterAs(newer.id);
    const { brief } = await rebuild([older, newer]);
    const matter = matterFor(brief, newer.id);
    assert.ok(matter, "thread was not placed in a matter");
    assert.equal(matter.emails?.[0]?.fromEmail, ATTACKER);
    assert.equal(matter.crm?.amount, undefined);
    assertUntrustedCode("thread row", matter.subUnit, OPP_CODE);
    assertNoPrivate("thread matter", matter);
  },
);

await check(
  "a known sender is not tied to every code they type",
  async () => {
    const item = mail({
      id: "a-known",
      fromEmail: ATTACKER,
      subject: OPP_CODE,
    });
    clusterAs(item.id);
    const { brief } = await rebuild([item], {}, [ATTACKER]);
    const matter = matterFor(brief, item.id);
    assert.ok(matter, "known sender mail was not placed in a matter");
    assert.equal(matter.crm?.amount, undefined);
    assertNoPrivate("known sender", matter);
  },
);

await check(
  "a sender tied to one code does not receive a different code's facts",
  async () => {
    const item = mail({
      id: "buyer-other",
      fromEmail: BUYER,
      fromName: "Buyer",
      subject: `Please review ${STUDY_CODE}`,
    });
    clusterAs(item.id);
    const { brief } = await rebuild([item]);
    const matter = matterFor(brief, item.id);
    assert.ok(matter, "tied sender's other code was not placed");
    assert.equal(matter.crm?.investigators, undefined);
    assert.equal(matter.crm?.status, undefined);
    assertUntrustedCode("other code", matter.subUnit, STUDY_CODE);
    assertNoPrivate("other code", matter);
  },
);

await check(
  "promoted read keeps the code and not the registry label",
  async () => {
    clusterFails();
    const item = mail({
      id: "a-promoted",
      fromEmail: ATTACKER,
      subject: `Contract ${OPP_CODE}`,
    });
    const understanding: UnderstandingMap = {
      [item.id]: {
        id: item.id,
        threadId: item.id,
        version: 4,
        readAt: "2026-11-20T15:00:00.000Z",
        kind: "request",
        oneLine: "Someone sent a note",
        ask: "Reply with a time",
        owner: "you",
        entities: [],
        org: { unit: "operations — studies", confidence: 0.5 },
        importance: 2,
        disposition: "matter",
        matterTitle: "Inbound request",
        matterWhy: "The read called it a matter",
      },
    };
    const { brief } = await rebuild([item], understanding);
    const matter = matterFor(brief, item.id);
    assert.ok(matter, "promoted mail was not a matter");
    assert.equal(matter.crm, undefined);
    assertUntrustedCode("promoted", matter.subUnit, OPP_CODE);
    assertNoPrivate("promoted", matter);
    assertNoPrivate("promoted csv", toCsv(buildExportRows(brief)));
  },
);

await check(
  "a manual matter does not copy registry facts onto untied mail",
  async () => {
    clusterFails();
    const item = mail({
      id: "a-manual",
      fromEmail: ATTACKER,
      subject: `Notes ${OPP_CODE}`,
    });
    const who = account();
    await saveSalesforce(who, REGISTRY);
    await createMatter(who, {
      title: "Grouped by hand",
      emailIds: [item.id],
    });
    const brief = await buildBrief(who, [item], null, null, {}, new Set());
    const matter = matterFor(brief, item.id);
    assert.ok(matter, "manual matter did not keep the message");
    assertUntrustedCode("manual", matter.subUnit, OPP_CODE);
    assertNoPrivate("manual", matter);
    assertNoPrivate("manual csv", toCsv(buildExportRows(brief)));
  },
);

await check(
  "the tied opportunity owner still receives that opportunity's facts",
  async () => {
    const item = mail({
      id: "buyer-own",
      fromEmail: "Buyer@Northwind.example",
      fromName: "Buyer",
      subject: `Pricing for ${OPP_CODE}`,
    });
    clusterAs(item.id);
    const { brief } = await rebuild([item]);
    const matter = matterFor(brief, item.id);
    assert.ok(matter, "owner mail was not placed in a matter");
    assert.equal(matter.crm?.amount, 2_500_000);
    assert.equal(matter.crm?.stage, "Negotiation/Review");
    assert.equal(matter.crm?.account, "Northwind Therapeutics");
    assert.equal(matter.crm?.closeDate, "2026-12-15");
    assert.equal(matter.subUnit?.includes("$2.5M"), true);
    assert.equal(matter.subUnit?.includes("Kinetic panel"), true);
    const csv = toCsv(buildExportRows(brief));
    assert.equal(csv.includes("$2.5M"), true);
    assert.equal(csv.includes("Kinetic panel"), true);
  },
);

await check(
  "the tied study address still receives that study's investigators",
  async () => {
    const item = mail({
      id: "pi-own",
      fromEmail: PI,
      fromName: "Priya",
      subject: "Hello",
      snippet: `Update on ${STUDY_CODE}`,
    });
    clusterAs(item.id);
    const { brief } = await rebuild([item]);
    const matter = matterFor(brief, item.id);
    assert.ok(matter, "investigator mail was not placed in a matter");
    assert.equal(matter.crm?.status, "Enrolling");
    assert.equal(matter.crm?.account, "Northwind Therapeutics");
    assert.deepEqual(matter.crm?.investigators, [`Priya Raman <${PI}>`]);
    assert.equal(matter.subUnit?.includes("Cardio kinetic assay"), true);
  },
);

await check(
  "context for an untied sender does not include live deal facts",
  async () => {
    const compiled = compileEmailContext(
      {
        fromEmail: ATTACKER,
        fromName: BUYER,
        subject: `Please pay against ${OPP_CODE}`,
        snippet: `Also see ${STUDY_CODE}.`,
      },
      {
        accountEmail: "owner@desk.example",
        ownDomain: "desk.example",
        salesforce: REGISTRY,
      },
    );
    assert.equal(compiled.text.includes("$2.5M"), false);
    assert.equal(compiled.text.includes("[system]"), false);
    assert.equal(compiled.text.includes("Negotiation/Review"), false);
    assert.equal(compiled.text.includes("2026-12-15"), false);
    assert.equal(compiled.text.includes("Northwind Therapeutics"), false);
    assert.equal(compiled.text.includes("Priya Raman"), false);
    assert.equal(compiled.text.includes("Cardio kinetic assay"), false);
    assert.equal(
      compiled.refs.some((ref) => ref.startsWith("crm:")),
      false,
    );
  },
);

await check(
  "context for the tied owner still includes that opportunity",
  async () => {
    const compiled = compileEmailContext(
      {
        fromEmail: BUYER,
        fromName: "Buyer",
        subject: OPP_CODE,
        snippet: "Sending the latest quote.",
      },
      {
        accountEmail: "owner@desk.example",
        ownDomain: "desk.example",
        salesforce: REGISTRY,
      },
    );
    assert.equal(compiled.text.includes("$2.5M"), true);
    assert.equal(compiled.text.includes("Negotiation/Review"), true);
    assert.equal(compiled.text.includes("[system]"), true);
    assert.equal(
      compiled.refs.includes(`crm:${norm(OPP_CODE)}`),
      true,
    );
  },
);

await check(
  "mail with no code does not pick up a registry label",
  async () => {
    clusterFails();
    const item = mail({
      id: "plain",
      fromEmail: ATTACKER,
      subject: "Lunch Thursday",
      snippet: "Are you free at noon?",
    });
    const { brief } = await rebuild([item]);
    const filed = brief.filed.find((row) => row.emailId === item.id);
    assert.ok(filed, "plain mail was not filed");
    assertNoPrivate("plain mail", filed);
    assert.equal(filed.subUnit?.includes("$2.5M"), false);
  },
);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall deal-fact tests passed");
