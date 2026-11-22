/**
 * Department filing must accept a name only when it equals an entry on the
 * user's function list. A deep-read or clustering name that merely starts
 * a list entry, or that a list entry starts, is unsorted — the first list
 * row must not win. An exact list entry stays that entry, including when a
 * shorter entry is also a prefix of it.
 *
 * These assertions fail while prefix matching and unchecked model strings
 * are still in the brief. Run:
 *   node --experimental-test-module-mocks --import tsx scripts/org-unit-filing.test.mts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";

process.env.SEER_DATA_DIR = mkdtempSync(path.join(tmpdir(), "seer-org-filing-"));
for (const name of [
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "SEER_V2_DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
]) {
  delete process.env[name];
}

const require = createRequire(import.meta.url);
const realAi = await import(pathToFileURL(require.resolve("ai")).href);

/** Model transcripts, keyed by message id. The stand-in does not interpret
 * the mail; it returns the department string the schema then validates. */
const deepReadOrg = new Map<string, string>();
const deepReadDisposition = new Map<string, "matter" | "record" | "fyi" | "disposable">();
let clusterMatters: {
  id: string;
  title: string;
  orgUnit: string;
  emailIds: string[];
}[] = [];
const modelPrompts: string[] = [];

mock.module("ai", {
  namedExports: {
    Output: realAi.Output,
    async generateText(opts: {
      system?: string;
      prompt?: string;
      output?: {
        parseCompleteOutput: (
          options: { text: string },
          context: {
            response: { id: string; timestamp: Date; modelId: string };
            usage: { inputTokens: number; outputTokens: number; totalTokens: number };
            finishReason: string;
          },
        ) => Promise<unknown>;
      };
    }) {
      const prompt = String(opts.prompt ?? "");
      const system = String(opts.system ?? "");
      modelPrompts.push(prompt);
      const parsed = JSON.parse(prompt) as unknown;
      let transcript: unknown;
      if (system.includes("disposable end") || Array.isArray(parsed)) {
        const rows = parsed as { id: string }[];
        transcript = {
          summary: "",
          themes: [
            {
              theme: "Notices",
              line: "Notices that ask for nothing.",
              emailIds: rows.map((row) => row.id),
            },
          ],
        };
      } else if (system.includes("chief of staff") || prompt.includes('"inbox"')) {
        transcript = {
          summary: "Contracts are waiting to be filed.",
          matters: clusterMatters.map((matter) => ({
            id: matter.id,
            title: matter.title,
            goal: "The contract is filed under the right department.",
            category: "contract",
            orgUnit: matter.orgUnit,
            orgConfidence: 0.8,
            people: [],
            narrative: "The countersigned copy is back.",
            nextAction: "File the contract",
            owner: "you",
            urgency: 2,
            emailIds: matter.emailIds,
          })),
        };
      } else if (system.includes("You read a CEO") || prompt.includes('"body"')) {
        const payload = parsed as { emails: { id: string }[] };
        transcript = {
          records: payload.emails.map((email) => {
            const disposition = deepReadDisposition.get(email.id) ?? "record";
            const orgUnit = deepReadOrg.get(email.id) ?? "sales — contracting";
            return {
              id: email.id,
              kind: "contract",
              oneLine: "Roche returned the countersigned customer CDA.",
              ask:
                disposition === "matter"
                  ? "File the countersigned customer CDA"
                  : "nothing — informational",
              owner: disposition === "matter" ? "you" : "nobody",
              entities: ["Roche"],
              awaitsSignature: false,
              orgUnit,
              orgConfidence: 0.4,
              importance: disposition === "matter" ? 2 : 0,
              disposition,
              ...(disposition === "matter"
                ? {
                    matterTitle: "Roche countersigned CDA",
                    matterWhy: "The executed customer CDA is back and needs a department.",
                  }
                : {}),
            };
          }),
        };
      } else {
        throw new Error(`unexpected model call: ${system.slice(0, 80)}`);
      }
      if (!opts.output?.parseCompleteOutput) {
        throw new Error("model call did not use Output.object schema validation");
      }
      const output = await opts.output.parseCompleteOutput(
        { text: JSON.stringify(transcript) },
        {
          response: { id: "fixture", timestamp: new Date(), modelId: "fixture" },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: "stop",
        },
      );
      return { output };
    },
  },
});

const { readEmails } = await import("../src/lib/inbox/understanding.ts");
const { buildBrief, loadBrief } = await import("../src/lib/inbox/matters.ts");
const { saveFunctions } = await import("../src/lib/store/functions.ts");
const { saveMatterFix } = await import("../src/lib/store/matter-fixes.ts");
const { mergeUnderstanding, loadUnderstanding } = await import(
  "../src/lib/store/understanding-store.ts"
);
import type { EmailItem } from "../src/lib/inbox/types.ts";
import type { Brief } from "../src/lib/inbox/matters.ts";
import type { Understanding } from "../src/lib/inbox/understanding.ts";

const REGISTRY = [
  "board",
  "sales — leads",
  "sales — new requests",
  "sales — contracting",
  "operations — studies",
];

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

function mail(id: string, body: string): EmailItem & { body: string } {
  return {
    id,
    threadId: `thread-${id}`,
    fromEmail: `ada.${id}@roche.example`,
    fromName: "Ada Roche",
    subject: "Countersigned customer CDA",
    snippet: body.slice(0, 140),
    body,
    receivedAt: "2026-08-01T15:04:00.000Z",
    isUnread: false,
  };
}

function filedUnit(brief: Brief, id: string): string | undefined {
  return brief.filed?.find((row) => row.emailId === id)?.orgUnit;
}

function matterUnit(brief: Brief, threadId: string): string | undefined {
  return brief.matters.find((matter) => matter.threadIds.includes(threadId))?.orgUnit;
}

function digestUnit(brief: Brief, id: string): string | undefined {
  for (const theme of brief.digest?.themes ?? []) {
    const item = theme.items?.find((row) => row.id === id);
    if (item) return item.orgUnit;
  }
  return undefined;
}

const bodies = {
  cdaPrefix:
    "Please file this countersigned customer CDA with sales. The department name to use is sales.",
  opsPrefix:
    "Route this running study notice to operations. The department name to use is operations.",
  longPrefix:
    "File the exhibit with sales — contracting — exhibit A, not with the leads queue.",
  boardPrefix: "This is a boardroom booking. The department name to use is boardroom.",
  exact: "File this executed SOW under sales — contracting.",
  exactCase: "File this executed SOW under Sales — Contracting.",
  exactMiddle: "This quote is sales — new requests, not the leads queue.",
  padded: "The department name to use is sales, with surrounding spaces in the model field.",
  promo: "This countersigned customer CDA is live work. The department name to use is sales.",
  clustered: "Cluster this contract. The model card will name a department that is not on the list.",
  clusteredLong:
    "Cluster this study under operations — studies — ALXN, which is not itself a list entry.",
  clusteredExact: "Cluster this quote under sales — new requests.",
  corrected: "Cluster this, then keep the user's own department correction.",
  digest: "Newsletter. The department name to use is sales. Nothing is asked.",
};

const messages = [
  mail("cda-prefix", bodies.cdaPrefix),
  mail("ops-prefix", bodies.opsPrefix),
  mail("long-prefix", bodies.longPrefix),
  mail("board-prefix", bodies.boardPrefix),
  mail("exact", bodies.exact),
  mail("exact-case", bodies.exactCase),
  mail("exact-middle", bodies.exactMiddle),
  mail("padded", bodies.padded),
  mail("promo", bodies.promo),
  mail("clustered", bodies.clustered),
  mail("clustered-long", bodies.clusteredLong),
  mail("clustered-exact", bodies.clusteredExact),
  mail("corrected", bodies.corrected),
  mail("digest-sales", bodies.digest),
];

const account = "filing-check@example.com";
await saveFunctions(account, REGISTRY);

for (const [id, unit] of [
  ["cda-prefix", "sales"],
  ["ops-prefix", "operations"],
  ["long-prefix", "sales — contracting — exhibit A"],
  ["board-prefix", "boardroom"],
  ["exact", "sales — contracting"],
  ["exact-case", "Sales — Contracting"],
  ["exact-middle", "sales — new requests"],
  ["padded", " sales "],
  ["promo", "sales"],
  ["clustered", "sales — contracting"],
  ["clustered-long", "operations — studies"],
  ["clustered-exact", "sales — new requests"],
  ["corrected", "sales — contracting"],
  ["digest-sales", "sales"],
] as const) {
  deepReadOrg.set(id, unit);
}
deepReadDisposition.set("promo", "matter");
deepReadDisposition.set("digest-sales", "disposable");

clusterMatters = [
  {
    id: "clustered-matter",
    title: "Roche contract in the wrong pile",
    orgUnit: "sales",
    emailIds: ["clustered"],
  },
  {
    id: "clustered-long-matter",
    title: "ALXN study",
    orgUnit: "operations — studies — ALXN",
    emailIds: ["clustered-long"],
  },
  {
    id: "clustered-exact-matter",
    title: "Roche quote",
    orgUnit: "sales — new requests",
    emailIds: ["clustered-exact"],
  },
  {
    id: "corrected-matter",
    title: "User already corrected this",
    orgUnit: "sales",
    emailIds: ["corrected"],
  },
];

const records = await readEmails(messages, {
  functions: REGISTRY,
  concurrency: 2,
  fetchBody: async () => {
    throw new Error("the message body was already on the inbound mail");
  },
});
const understanding: Record<string, Understanding> = Object.fromEntries(
  records.map((record) => [record.id, record]),
);
await mergeUnderstanding(account, records, new Set(messages.map((m) => m.id)));
await saveMatterFix(account, "corrected-matter", "sales — contracting");

const brief = await buildBrief(
  account,
  messages,
  null,
  { messages: messages.length, threads: messages.length },
  understanding,
  new Set(),
);
const stored = await loadBrief(account);
const storedUnderstanding = await loadUnderstanding(account);

console.log("org unit filing");

check("every inbound body reached the deep-read prompt", () => {
  const joined = modelPrompts.join("\n");
  for (const body of Object.values(bodies)) {
    assert.ok(joined.includes(body), `missing body in model prompt: ${body}`);
  }
});

check("the deep read stored a department for every message", () => {
  assert.equal(records.length, messages.length);
  assert.equal(Object.keys(storedUnderstanding).length, messages.length);
});

check("a short sales name is not filed as the first sales row", () => {
  assert.equal(filedUnit(brief, "cda-prefix"), "unsorted");
  assert.equal(filedUnit(stored, "cda-prefix"), "unsorted");
});

check("a short operations name is not filed as the first operations row", () => {
  assert.equal(filedUnit(brief, "ops-prefix"), "unsorted");
});

check("a name that only starts with a list entry is unsorted", () => {
  assert.equal(filedUnit(brief, "long-prefix"), "unsorted");
  assert.notEqual(filedUnit(brief, "long-prefix"), "sales — contracting");
});

check("a name that a list entry only starts is unsorted", () => {
  assert.equal(filedUnit(brief, "board-prefix"), "unsorted");
  assert.notEqual(filedUnit(brief, "board-prefix"), "board");
});

check("whitespace around a short name does not prefix-match", () => {
  assert.equal(filedUnit(brief, "padded"), "unsorted");
});

check("an exact list entry is filed as that entry", () => {
  assert.equal(filedUnit(brief, "exact"), "sales — contracting");
  assert.equal(filedUnit(brief, "exact-middle"), "sales — new requests");
});

check("exact matching ignores case and keeps the list spelling", () => {
  assert.equal(filedUnit(brief, "exact-case"), "sales — contracting");
});

check("a promoted deep-read matter does not take the first sales row", () => {
  assert.equal(matterUnit(brief, "thread-promo"), "unsorted");
  assert.equal(filedUnit(brief, "promo"), undefined);
});

check("a model matter keeps a department only when it equals a list entry", () => {
  const wrong = brief.matters.find((matter) => matter.id === "clustered-matter");
  const long = brief.matters.find((matter) => matter.id === "clustered-long-matter");
  const exact = brief.matters.find((matter) => matter.id === "clustered-exact-matter");
  assert.ok(wrong);
  assert.ok(long);
  assert.ok(exact);
  assert.equal(wrong.orgUnit, "unsorted");
  assert.equal(long.orgUnit, "unsorted");
  assert.equal(exact.orgUnit, "sales — new requests");
  assert.equal(
    stored?.matters.find((matter) => matter.id === "clustered-matter")?.orgUnit,
    "unsorted",
  );
  assert.equal(
    stored?.matters.find((matter) => matter.id === "clustered-long-matter")?.orgUnit,
    "unsorted",
  );
});

check("a user's own department correction that equals a list entry is kept", () => {
  const corrected = brief.matters.find((matter) => matter.id === "corrected-matter");
  assert.equal(corrected?.orgUnit, "sales — contracting");
});

check("digest mail with a short department name is not grouped as sales leads", () => {
  assert.equal(digestUnit(brief, "digest-sales"), "unsorted");
  assert.equal(digestUnit(stored, "digest-sales"), "unsorted");
});

check("prefix filing does not count the contract under sales leads", () => {
  const leads = brief.accounting?.mappedByCategory.find(
    (row) => row.category === "sales — leads",
  );
  assert.equal(leads, undefined);
  const promo = brief.matters.find((matter) => matter.threadIds.includes("thread-promo"));
  assert.equal(promo?.orgUnit, "unsorted");
});

// A shorter list entry that is a prefix of a longer exact entry must not win.
const exactAccount = "exact-over-prefix@example.com";
const exactRegistry = ["sales", "sales — leads", "sales — contracting"];
await saveFunctions(exactAccount, exactRegistry);
deepReadOrg.set("exact-over-prefix", "sales — leads");
deepReadDisposition.set("exact-over-prefix", "record");
clusterMatters = [];
const exactMessage = mail(
  "exact-over-prefix",
  "This is the leads queue, sales — leads, and must not collapse to sales.",
);
const exactRecords = await readEmails([exactMessage], {
  functions: exactRegistry,
  fetchBody: async () => {
    throw new Error("the message body was already on the inbound mail");
  },
});
const exactBrief = await buildBrief(
  exactAccount,
  [exactMessage],
  null,
  null,
  Object.fromEntries(exactRecords.map((record) => [record.id, record])),
  new Set(),
);

check("an exact longer entry wins over a shorter entry that is its prefix", () => {
  assert.equal(filedUnit(exactBrief, "exact-over-prefix"), "sales — leads");
});

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
