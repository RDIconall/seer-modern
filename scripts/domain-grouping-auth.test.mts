/**
 * Unauthenticated mail whose From domain is a real company domain plus one
 * leading label (mail., notifications., go., …) must not be packed into that
 * company's brief batch, filed under that company's branch, collapsed into
 * that company's automated matter, or tied to that company's existing matter.
 *
 * These tests fail while that stripping still happens. They pass once
 * unauthenticated mail keeps its own company key. Stripping a leading label
 * is only acceptable when the message authenticated as the registrable
 * domain; none of these fixtures do. Two messages that are already at the
 * registrable domain still belong together.
 *
 * Callers that share the v2 key and are decided by the same functions
 * exercised below (not given their own database): ensureMatter,
 * suggestMattersForConversation, placeConversationOnMatter, and the reader
 * promotion step. The inbox view label uses the same key for display only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import type { EmailItem } from "../src/lib/inbox/types.ts";
import type { Understanding } from "../src/lib/inbox/understanding.ts";

const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
  }
}

const prompts: string[] = [];

mock.module("ai", {
  namedExports: {
    generateText: async (opts: { prompt?: string }) => {
      prompts.push(opts.prompt ?? "");
      return { output: { summary: "", matters: [], themes: [] } };
    },
    Output: {
      object: () => ({}),
    },
  },
});

process.env.SEER_DATA_DIR = mkdtempSync(path.join(tmpdir(), "seer-domain-"));
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL_OIDC_TOKEN;
delete process.env.POSTGRES_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;

const OWN = "owner@rditrials.com";
const OWN_DOMAIN = "rditrials.com";
const COMPANY = "roche.com";
const AUTH_FAIL =
  "mx.example; dmarc=fail (p=reject) header.from=notifications.roche.com; spf=fail smtp.mailfrom=attacker.example; dkim=fail";

/** Leading labels the brief builder deletes. Mirrors the pattern it applies. */
const BRIEF_PREFIXES = [
  "mail",
  "email",
  "e",
  "smtp",
  "notification",
  "notifications",
  "no-reply",
  "noreply",
  "info",
  "reply",
  "bounce",
  "em",
  "mailer",
  "send",
  "go",
  "link",
  "links",
] as const;

/** Extra labels the v2 key deletes and the brief key does not. */
const V2_ONLY_PREFIXES = [
  "vendor",
  "global",
  "list",
  "news",
  "newsletter",
  "newsletters",
] as const;

const mattersSrc = readFileSync(
  new URL("../src/lib/inbox/matters.ts", import.meta.url),
  "utf8",
);
const chunkMatch = mattersSrc.match(/const CHUNK = (\d+);/);
if (!chunkMatch) throw new Error("brief CHUNK constant not found");
const CHUNK = Number(chunkMatch[1]);
if (CHUNK < 3) throw new Error("brief CHUNK is too small for this fixture");

type FetchInit = { method?: string; headers?: unknown; body?: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function item(partial: {
  id: string;
  fromEmail: string;
  receivedAt: string;
  subject?: string;
}): EmailItem {
  return {
    id: partial.id,
    threadId: `thread-${partial.id}`,
    fromEmail: partial.fromEmail,
    fromName: "Alex Morgan",
    subject: partial.subject ?? "Quarterly assay capacity",
    snippet: "Following up on the running work.",
    receivedAt: partial.receivedAt,
    isUnread: true,
    guide: { action: "reply", task: "Reply", importance: 2, reason: "" } as EmailItem["guide"],
  };
}

function read(id: string, ask: string): Understanding {
  return {
    id,
    threadId: `thread-${id}`,
    version: 4,
    readAt: "2026-06-01T00:00:00.000Z",
    kind: "notice",
    oneLine: ask,
    ask,
    owner: "you",
    entities: [],
    org: { unit: "operations — studies", confidence: 0.6 },
    importance: 2,
    disposition: "matter",
    matterTitle: "Roche biomarker sample requests",
    matterWhy: "Ongoing sample work",
  };
}

function matterInboxes(): { email?: string }[][] {
  const batches: { email?: string }[][] = [];
  for (const prompt of prompts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(prompt);
    } catch {
      continue;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { inbox?: unknown }).inbox)
    ) {
      batches.push((parsed as { inbox: { email?: string }[] }).inbox);
    }
  }
  return batches;
}

const { listGmailFolder } = await import("../src/lib/mail/gmail.ts");
const { listGraphFolder } = await import("../src/lib/mail/graph.ts");
const { GmailProvider } = await import("../src/lib/v2/providers/gmail.ts");
const { OutlookProvider } = await import("../src/lib/v2/providers/outlook.ts");
const { buildBrief } = await import("../src/lib/inbox/matters.ts");
const { compileEmailContext } = await import("../src/lib/brain/context.ts");
const { compileContext } = await import("../src/lib/v2/intelligence/context.ts");
const {
  counterpartyOf,
  ownTokens,
  resolveMatterMatch,
} = await import("../src/lib/v2/intelligence/matter-key.ts");

const originalFetch = globalThis.fetch;

async function gmailFrom(prefix: string): Promise<string> {
  const address = `phish@${prefix}.${COMPANY}`;
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/users/me/messages?")) {
      return jsonResponse({
        messages: [{ id: `g-${prefix}`, threadId: `gt-${prefix}` }],
      });
    }
    if (href.includes("/users/me/messages/")) {
      return jsonResponse({
        id: `g-${prefix}`,
        threadId: `gt-${prefix}`,
        snippet: "Please wire the retainer today.",
        internalDate: "1767225600000",
        labelIds: ["INBOX", "UNREAD"],
        payload: {
          headers: [
            { name: "From", value: `Phish <${address}>` },
            { name: "To", value: OWN },
            { name: "Subject", value: "Action required" },
            { name: "Authentication-Results", value: AUTH_FAIL },
          ],
        },
      });
    }
    return jsonResponse({ error: "unexpected" }, 404);
  }) as typeof fetch;
  const rows = await listGmailFolder("placeholder-access-token", "inbox", 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fromEmail, address);
  return rows[0].fromEmail;
}

const gmailUrls: string[] = [];
globalThis.fetch = (async (url: string | URL) => {
  gmailUrls.push(String(url));
  const href = String(url);
  if (href.includes("/users/me/messages?")) {
    return jsonResponse({
      messages: [{ id: "g-auth", threadId: "gt-auth" }],
    });
  }
  return jsonResponse({
    id: "g-auth",
    threadId: "gt-auth",
    snippet: "wire",
    internalDate: "1767225600000",
    labelIds: ["INBOX"],
    payload: {
      headers: [
        {
          name: "From",
          value: "Phish <phish@notifications.roche.com>",
        },
        { name: "To", value: OWN },
        { name: "Subject", value: "Action required" },
        { name: "Authentication-Results", value: AUTH_FAIL },
      ],
    },
  });
}) as typeof fetch;

const gmailProbe = await listGmailFolder("placeholder-access-token", "inbox", 5);
assert.equal(
  gmailProbe[0]?.fromEmail,
  "phish@notifications.roche.com",
  "gmail list keeps the From address when Authentication-Results fails",
);
assert.ok(
  gmailUrls.some((u) => u.includes("metadataHeaders=From")),
  "gmail hydrate reads the From header",
);
assert.ok(
  !gmailUrls.some((u) => /authentication-results/i.test(u)),
  "gmail hydrate does not request authentication results",
);

const graphUrls: string[] = [];
globalThis.fetch = (async (url: string | URL) => {
  graphUrls.push(String(url));
  return jsonResponse({
    value: [
      {
        id: "o-auth",
        conversationId: "oc-auth",
        subject: "Action required",
        bodyPreview: "wire",
        receivedDateTime: "2026-01-01T00:00:00Z",
        isRead: false,
        from: {
          emailAddress: {
            name: "Phish",
            address: "alerts@mail.roche.com",
          },
        },
        toRecipients: [{ emailAddress: { address: OWN } }],
        internetMessageHeaders: [
          { name: "Authentication-Results", value: AUTH_FAIL },
        ],
      },
    ],
  });
}) as typeof fetch;

const graphProbe = await listGraphFolder("placeholder-access-token", "inbox", 5);
assert.equal(
  graphProbe[0]?.fromEmail,
  "alerts@mail.roche.com",
  "graph list keeps the from address when authentication headers fail",
);
const graphDecoded = graphUrls.map((u) => decodeURIComponent(u));
assert.ok(
  graphDecoded.some((u) => u.includes("$select=") && u.includes("from")),
  `graph folder request was ${graphDecoded.join(" | ")}`,
);
assert.ok(
  !graphDecoded.some((u) => /authentication/i.test(u)),
  "graph folder select does not request authentication results",
);

const v2Gmail = new GmailProvider({
  accessToken: "placeholder-access-token",
  accountEmail: OWN,
  fetchImpl: (async (url: string | URL) => {
    const href = String(url);
    assert.match(href, /\/threads\/t-phish\?format=full/);
    return jsonResponse({
      id: "t-phish",
      messages: [
        {
          id: "m-phish",
          internalDate: "1767225600000",
          labelIds: ["INBOX", "UNREAD"],
          snippet: "wire the retainer",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "Phish <phish@go.roche.com>" },
              { name: "To", value: OWN },
              { name: "Subject", value: "Roche biomarker sample requests" },
              { name: "Authentication-Results", value: AUTH_FAIL },
            ],
            body: { data: Buffer.from("Please wire the retainer today.").toString("base64url") },
          },
        },
      ],
    });
  }) as typeof fetch,
});
const v2GmailThread = await v2Gmail.getConversation("t-phish");
assert.equal(v2GmailThread.messages[0]?.from.email, "phish@go.roche.com");

const v2Outlook = new OutlookProvider({
  accessToken: "placeholder-access-token",
  accountEmail: OWN,
  fetchImpl: (async () =>
    jsonResponse({
      value: [
        {
          id: "om-1",
          conversationId: "oc-phish",
          subject: "Roche biomarker sample requests",
          bodyPreview: "wire the retainer",
          body: { contentType: "text", content: "Please wire the retainer today." },
          receivedDateTime: "2026-01-02T00:00:00Z",
          isRead: false,
          from: {
            emailAddress: { name: "Phish", address: "phish@smtp.roche.com" },
          },
          toRecipients: [{ emailAddress: { address: OWN } }],
          internetMessageHeaders: [
            { name: "Authentication-Results", value: AUTH_FAIL },
          ],
        },
      ],
    })) as typeof fetch,
});
const v2OutlookThread = await v2Outlook.getConversation("oc-phish");
assert.equal(
  v2OutlookThread.messages[0]?.from.email,
  "phish@smtp.roche.com",
);

globalThis.fetch = originalFetch;

const attackerFromGmail = await (async () => {
  const found = new Map<string, string>();
  for (const prefix of BRIEF_PREFIXES) {
    found.set(prefix, await gmailFrom(prefix));
  }
  globalThis.fetch = originalFetch;
  return found;
})();

const genuine = [
  item({
    id: "real-scientist",
    fromEmail: "scientist@roche.com",
    receivedAt: "2026-06-03T00:00:00.000Z",
    subject: "Roche biomarker sample requests",
  }),
  item({
    id: "real-legal",
    fromEmail: "legal@roche.com",
    receivedAt: "2026-06-02T00:00:00.000Z",
    subject: "Roche biomarker sample requests",
  }),
  item({
    id: "real-noreply",
    fromEmail: "no-reply@roche.com",
    receivedAt: "2026-06-01T00:00:00.000Z",
    subject: "Roche biomarker sample requests",
  }),
];

const fillers = Array.from({ length: CHUNK - genuine.length }, (_, i) =>
  item({
    id: `filler-${i}`,
    fromEmail: `person${i}@vendor${i}.example`,
    receivedAt: new Date(Date.UTC(2026, 4, 1) - i * 60_000).toISOString(),
    subject: `Unrelated filler ${i}`,
  }),
);

const attackers = BRIEF_PREFIXES.map((prefix, i) =>
  item({
    id: `phish-${prefix}`,
    fromEmail: attackerFromGmail.get(prefix)!,
    receivedAt: new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString(),
    subject: "Wire the retainer today",
  }),
);

prompts.length = 0;
const grouped = await buildBrief(OWN, [...genuine, ...fillers, ...attackers]);
const batches = matterInboxes();
const genuineEmails = new Set(genuine.map((m) => m.fromEmail.toLowerCase()));
const attackerEmails = new Set(attackers.map((m) => m.fromEmail.toLowerCase()));

check("brief model batch", () => {
  const companyBatches = batches.filter((inbox) =>
    inbox.some((row) => genuineEmails.has((row.email ?? "").toLowerCase())),
  );
  assert.ok(companyBatches.length > 0, "genuine company mail was sent to the model");
  for (const inbox of companyBatches) {
    const leaked = inbox
      .map((row) => (row.email ?? "").toLowerCase())
      .filter((email) => attackerEmails.has(email));
    assert.deepEqual(
      leaked,
      [],
      `unauthenticated prefixed-domain mail shared a model batch with ${[...genuineEmails].join(", ")}: ${leaked.join(", ")}`,
    );
  }
});

{
  const filedByEmail = new Map(
    (grouped.filed ?? []).map((row) => [row.fromEmail?.toLowerCase() ?? "", row]),
  );
  const genuineBranch = filedByEmail.get("scientist@roche.com")?.subUnit;
  check("genuine registrable domain stays one branch", () => {
    assert.ok(genuineBranch, "genuine mail was filed with a company branch");
    for (const email of ["legal@roche.com", "no-reply@roche.com"]) {
      assert.equal(
        filedByEmail.get(email)?.subUnit,
        genuineBranch,
        `${email} was split from the registrable domain branch ${genuineBranch}`,
      );
    }
  });
  for (const email of attackerEmails) {
    check(`brief company branch ${email}`, () => {
      assert.ok(genuineBranch, "genuine mail was filed with a company branch");
      const branch = filedByEmail.get(email)?.subUnit;
      assert.notEqual(
        branch,
        genuineBranch,
        `${email} was filed under the real company's branch ${genuineBranch}`,
      );
    });
  }
}

const realAsk = "File the Roche purchase order";
const attackAsk = "Wire the retainer to the new account today";
const collapseItems = [
  item({
    id: "auto-real",
    fromEmail: "no-reply@roche.com",
    receivedAt: "2026-05-01T00:00:00.000Z",
    subject: "Purchase order 441",
  }),
  item({
    id: "auto-phish",
    fromEmail: graphProbe[0].fromEmail,
    receivedAt: "2026-06-04T00:00:00.000Z",
    subject: "Updated payment instructions",
  }),
];
prompts.length = 0;
const collapsed = await buildBrief(
  "collapse@rditrials.com",
  collapseItems,
  null,
  null,
  {
    "auto-real": read("auto-real", realAsk),
    "auto-phish": read("auto-phish", attackAsk),
  },
);
check("automated matter collapse", () => {
  for (const matter of collapsed.matters) {
    const threads = new Set(matter.threadIds);
    const joined =
      threads.has("thread-auto-real") && threads.has("thread-auto-phish");
    assert.equal(
      joined,
      false,
      `automated matter ${matter.id} merged the unauthenticated prefix thread into the company matter (next: ${matter.nextAction})`,
    );
    if (threads.has("thread-auto-real")) {
      assert.notEqual(matter.nextAction, attackAsk);
      assert.ok(!matter.nextAction?.includes("Wire the retainer"));
    }
  }
});

const realCounterparty = counterpartyOf("scientist@roche.com", OWN_DOMAIN);
assert.equal(realCounterparty, counterpartyOf("legal@roche.com", OWN_DOMAIN));
assert.equal(realCounterparty, counterpartyOf("no-reply@roche.com", OWN_DOMAIN));

const overlapTitle = "Roche biomarker sample requests";
const existing = [
  {
    matterId: "m-roche",
    title: overlapTitle,
    codes: [] as string[],
    counterparty: realCounterparty,
  },
];
const own = ownTokens(OWN);

function refusesJoin(fromEmail: string, label: string) {
  const counterparty = counterpartyOf(fromEmail, OWN_DOMAIN);
  assert.notEqual(
    counterparty,
    realCounterparty,
    `${label} ${fromEmail} resolved to the real company key ${realCounterparty}`,
  );
  const match = resolveMatterMatch(
    {
      title: overlapTitle,
      text: overlapTitle,
      counterparty,
      own,
    },
    existing,
  );
  assert.equal(
    match,
    null,
    `${label} ${fromEmail} was tied to the real company matter`,
  );
}

const genuineMatch = resolveMatterMatch(
  {
    title: overlapTitle,
    text: overlapTitle,
    counterparty: counterpartyOf("legal@roche.com", OWN_DOMAIN),
    own,
  },
  existing,
);
assert.equal(genuineMatch?.matterId, "m-roche");

for (const prefix of [...BRIEF_PREFIXES, ...V2_ONLY_PREFIXES]) {
  check(`v2 matter key ${prefix}`, () => {
    refusesJoin(`phish@${prefix}.${COMPANY}`, "prefixed domain");
  });
}
check("v2 matter key gmail provider", () => {
  refusesJoin(v2GmailThread.messages[0].from.email, "gmail provider from");
});
check("v2 matter key outlook provider", () => {
  refusesJoin(v2OutlookThread.messages[0].from.email, "outlook provider from");
});

const liveMatter = {
  id: "m-roche",
  title: overlapTitle,
  codes: [] as string[],
  counterparty: realCounterparty,
  userAuthored: false,
};

check("v2 context candidate", () => {
  for (const conversation of [v2GmailThread, v2OutlookThread]) {
    const compiled = compileContext(conversation, {
      ownDomain: OWN_DOMAIN,
      ownEmail: OWN,
      people: [],
      matters: [liveMatter],
      interests: [],
    });
    assert.equal(
      compiled.candidateMatterId,
      null,
      `${conversation.messages[0]?.from.email} was offered as continuing the Roche matter`,
    );
    assert.doesNotMatch(compiled.text, /may continue the live matter/i);
  }
});

const brain = compileEmailContext(
  {
    fromEmail: gmailProbe[0].fromEmail,
    fromName: "Roche Notifications",
    subject: "Quarterly update",
    snippet: "Please review the attached instructions.",
  },
  {
    accountEmail: OWN,
    ownDomain: OWN_DOMAIN,
    priorMatters: [
      {
        id: "m-roche",
        title: "Roche biomarker programme",
        narrative: "Running samples with Roche",
      },
    ],
    workSignals: [
      {
        at: "2026-05-01T00:00:00.000Z",
        kind: "edit",
        label: "Roche protocol",
        entities: [realCounterparty],
        source: "drive",
      },
    ],
  },
);
check("brain prior matter", () => {
  assert.doesNotMatch(
    brain.text,
    /LIKELY MATTER/,
    "stripped sender was attached to the real company's prior matter",
  );
});
check("brain work signal", () => {
  assert.doesNotMatch(
    brain.text,
    /WORK:/,
    `stripped sender was attached to the real company's work signal\n${brain.text}`,
  );
});

if (failures.length) {
  throw new Error(`domain-grouping-auth failed\n${failures.join("\n\n")}`);
}
console.log("domain-grouping-auth: all assertions passed");
