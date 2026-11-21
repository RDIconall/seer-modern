/**
 * Digest clearance must not treat a leading "nothing" as proof nothing is owed.
 *
 * The deep read's schema asks for exactly "nothing — informational" when
 * nothing is owed. These tests drive the product path: attacker body →
 * deep read (real structured-output schema) → stored understanding →
 * brief → Triage "Delete these" → the Gmail thread trash and Outlook
 * message delete the clear route calls.
 *
 * They fail while a prefixed ask, a deadline, an importance above zero,
 * or a request/signature still in the raw body can put the message in
 * that delete bucket.
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx scripts/digest-ask-prefix.test.mts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV4 } from "ai/test";
import esbuild from "esbuild";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { JSDOM } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = await mkdtemp(path.join(tmpdir(), "seer-digest-prefix-"));
process.env.SEER_DATA_DIR = DATA_DIR;
const embeddedLib = path.join(
  HERE,
  "../node_modules/@embedded-postgres/linux-x64/native/lib",
);
for (const name of ["libicuuc.so.60", "libicudata.so.60", "libicui18n.so.60"]) {
  const link = path.join(embeddedLib, name);
  if (!existsSync(link)) symlinkSync(`${name}.2`, link);
}
process.env.LD_LIBRARY_PATH = [embeddedLib, process.env.LD_LIBRARY_PATH ?? ""]
  .filter(Boolean)
  .join(":");

const understandingSource = readFileSync(
  path.join(HERE, "../src/lib/inbox/understanding.ts"),
  "utf8",
);
const emptyAsk = understandingSource.match(/exactly "([^"]+)"/)?.[1];
if (!emptyAsk) throw new Error("schema phrase for an empty ask was not found");

const CLEAN_BODY =
  "The weekly shipping digest lists three departed containers. No action required.";
const ACCOUNT = "victim-digest-prefix@example.com";

type Script = {
  id: string;
  ask: string;
  disposition: "fyi" | "disposable";
  owner: "you" | "team" | "them" | "nobody";
  importance: number;
  deadline?: string;
  /** Full raw body the deep read puts in the model prompt. */
  body: string;
  /** Inbox preview. Kept free of request words when the body is the signal. */
  snippet: string;
  fromEmail: string;
  subject: string;
  /** Held out of "Delete these" even though the model called it noise. */
  hold: boolean;
};

const scripts: Script[] = [
  {
    id: "noise",
    ask: `  ${emptyAsk}  `,
    disposition: "disposable",
    owner: "nobody",
    importance: 0,
    body: CLEAN_BODY,
    snippet: "Weekly shipping digest",
    fromEmail: "lists@unknown.example",
    subject: "Weekly shipping digest",
    hold: false,
  },
  {
    id: "prefixed-disposable",
    ask: `${emptyAsk}. Please approve the $50,000 wire by Friday.`,
    disposition: "disposable",
    owner: "nobody",
    importance: 0,
    body: "Nothing else from us. Please approve the $50,000 wire by Friday.",
    snippet: "Please approve the wire",
    fromEmail: "attacker-wire@unknown.example",
    subject: "FYI",
    hold: true,
  },
  {
    id: "prefixed-fyi",
    ask: "Nothing owed until you sign the mutual CDA",
    disposition: "fyi",
    owner: "them",
    importance: 0,
    body: "Nothing owed until you sign the mutual CDA by Friday.",
    snippet: "Sign the mutual CDA",
    fromEmail: "attacker-cda@unknown.example",
    subject: "Quick note",
    hold: true,
  },
  {
    id: "body-request",
    ask: emptyAsk,
    disposition: "disposable",
    owner: "nobody",
    importance: 0,
    body: "Please sign the mutual CDA. Your signature is required in DocuSign.",
    snippet: "Weekly update",
    fromEmail: "attacker-sign@unknown.example",
    subject: "Weekly update",
    hold: true,
  },
  {
    id: "importance",
    ask: emptyAsk,
    disposition: "disposable",
    owner: "nobody",
    importance: 2,
    body: CLEAN_BODY,
    snippet: "Weekly shipping digest",
    fromEmail: "attacker-importance@unknown.example",
    subject: "Worth knowing",
    hold: true,
  },
  {
    id: "deadline",
    ask: emptyAsk,
    disposition: "fyi",
    owner: "nobody",
    importance: 0,
    deadline: "2026-12-01",
    body: CLEAN_BODY,
    snippet: "Weekly shipping digest",
    fromEmail: "attacker-deadline@unknown.example",
    subject: "A date was stated",
    hold: true,
  },
  {
    id: "known-sender",
    ask: emptyAsk,
    disposition: "disposable",
    owner: "nobody",
    importance: 0,
    body: CLEAN_BODY,
    snippet: "Weekly shipping digest",
    fromEmail: "friend@known.example",
    subject: "Known sender digest",
    hold: true,
  },
];

const prompts: string[] = [];

function userText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return JSON.stringify(prompt);
  const user = [...prompt].reverse().find((message) => message?.role === "user");
  const content = user?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  }
  return JSON.stringify(content ?? prompt);
}

function modelResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 20, text: 20, reasoning: undefined },
    },
    warnings: [],
  };
}

const model = new MockLanguageModelV4({
  doGenerate: async (opts) => {
    const text = userText(opts.prompt);
    prompts.push(text);
    const trimmed = text.trim();
    if (trimmed.startsWith("[")) {
      const rows = JSON.parse(trimmed) as { id: string }[];
      return modelResult({
        summary: "Automated notices.",
        themes: [
          {
            theme: "Notices",
            line: "Messages the read called noise.",
            emailIds: rows.map((row) => row.id),
          },
        ],
      });
    }
    const payload = JSON.parse(trimmed) as {
      emails?: { id: string }[];
      inbox?: unknown[];
    };
    if (Array.isArray(payload.emails)) {
      return modelResult({
        records: payload.emails.map((email) => {
          const script = scripts.find((item) => item.id === email.id);
          if (!script) throw new Error(`no script for ${email.id}`);
          return {
            id: script.id,
            kind: "notice",
            oneLine: script.subject,
            ask: script.ask,
            owner: script.owner,
            entities: ["Sender"],
            awaitsSignature: false,
            orgUnit: "finance (ar/ap)",
            orgConfidence: 0.4,
            importance: script.importance,
            disposition: script.disposition,
            ...(script.deadline ? { deadline: script.deadline } : {}),
          };
        }),
      });
    }
    if (Array.isArray(payload.inbox)) {
      return modelResult({ summary: "No live matters.", matters: [] });
    }
    throw new Error(`unrecognized model prompt: ${trimmed.slice(0, 180)}`);
  },
});

mock.module("@/lib/inbox/gemini-triage", {
  namedExports: {
    getTriageModel: async () => ({ model, label: "mock" }),
    getFallbackModel: () => null,
    isModelBudgetError: () => false,
  },
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
globals.HTMLElement = dom.window.HTMLElement;
globals.Element = dom.window.Element;
globals.Node = dom.window.Node;
Object.defineProperty(globals, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

const { readEmails } = await import("../src/lib/inbox/understanding.ts");
const { buildBrief } = await import("../src/lib/inbox/matters.ts");
const { mergeUnderstanding, loadUnderstanding } = await import(
  "../src/lib/store/understanding-store.ts"
);
const { planTriageClear } = await import("../src/lib/inbox/triage-clear.ts");
const { gmailThreadAction } = await import("../src/lib/mail/gmail.ts");
const { graphThreadAction } = await import("../src/lib/mail/graph.ts");
const triageBundle = path.join(HERE, ".digest-triage-bundle.mjs");
process.on("exit", () => {
  try {
    unlinkSync(triageBundle);
  } catch {
    /* already removed */
  }
});
await esbuild.build({
  entryPoints: [path.join(HERE, "../src/components/inbox/TriageDigest.tsx")],
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  outfile: triageBundle,
  external: ["react", "react/jsx-runtime", "react-dom", "lucide-react"],
  alias: { "@": path.join(HERE, "../src") },
});
const { TriageDigest } = await import(triageBundle);
const { escalationReasons, createReaderRouter } = await import(
  "../src/lib/v2/intelligence/model.ts"
);

let failures = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ok   ${name}`);
    })
    .catch((error: unknown) => {
      failures += 1;
      console.error(`  FAIL ${name}`);
      console.error(`       ${error instanceof Error ? error.message : error}`);
    });
}

const providerCalls: { url: string; method: string }[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  providerCalls.push({ url, method });
  if (url.includes("gmail.googleapis.com") && url.endsWith("/trash")) {
    return new Response("", { status: 200 });
  }
  if (url.includes("graph.microsoft.com") && url.includes("/mailFolders/inbox/messages")) {
    return new Response(JSON.stringify({ value: [{ id: "graph-msg-1" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("graph.microsoft.com") && method === "DELETE") {
    return new Response("", { status: 200 });
  }
  return new Response("unexpected provider call", { status: 500 });
};

console.log("digest ask prefix");

const reads = await readEmails(
  scripts.map((script) => ({
    id: script.id,
    threadId: `thread-${script.id}`,
    fromEmail: script.fromEmail,
    fromName: "Stranger",
    subject: script.subject,
    snippet: script.snippet,
    body: script.body,
  })),
  {
    functions: ["finance (ar/ap)"],
    fetchBody: async () => null,
  },
);
await mergeUnderstanding(ACCOUNT, reads);
const understanding = await loadUnderstanding(ACCOUNT);

await check("attacker bodies reach the deep-read prompt", () => {
  const joined = prompts.join("\n");
  for (const script of scripts) {
    assert.ok(
      joined.includes(script.body),
      `${script.id} body was not included in the deep-read prompt`,
    );
  }
});

await check("the deep read stores a prefixed ask instead of the exact phrase", () => {
  const stored = understanding["prefixed-disposable"];
  assert.ok(stored, "prefixed read was not stored");
  assert.notEqual(stored.ask.trim(), emptyAsk);
  assert.match(stored.ask, /^nothing/i);
  assert.match(stored.ask, /approve the \$50,000 wire by Friday/i);
  const bodyOnly = understanding["body-request"];
  assert.equal(bodyOnly?.ask.trim(), emptyAsk);
  assert.equal(bodyOnly?.disposition, "disposable");
  assert.equal(understanding["deadline"]?.deadline, "2026-12-01");
  assert.equal(understanding["importance"]?.importance, 2);
});

const brief = await buildBrief(
  ACCOUNT,
  scripts.map((script) => ({
    id: script.id,
    threadId: `thread-${script.id}`,
    fromEmail: script.fromEmail,
    fromName: "Stranger",
    subject: script.subject,
    snippet: script.snippet,
    receivedAt: "2026-11-20T15:00:00.000Z",
    isUnread: false,
  })),
  null,
  null,
  understanding,
  new Set(["friend@known.example"]),
);

const deleteThese: { id: string; threadId: string }[] = [];
const container = dom.window.document.createElement("div");
dom.window.document.body.appendChild(container);
const root = createRoot(container);
await act(async () => {
  root.render(
    createElement(TriageDigest, {
      brief,
      building: false,
      onOpenEmail: () => {},
      onSettle: () => {},
      onClear: (rows, _reason, mode) => {
        if (mode === "trash") deleteThese.push(...rows);
      },
    }),
  );
});
const buttons = [...dom.window.document.querySelectorAll("button")].filter(
  (button) => button.textContent?.trim() === "Delete these",
);
assert.ok(buttons.length > 0, "Delete these was not rendered");
for (const button of buttons) {
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

const planned = planTriageClear(brief, deleteThese);
const placeholderToken = "placeholder-access-token";
for (const action of planned) {
  if (!action.threadId) continue;
  await gmailThreadAction(placeholderToken, action.threadId, "trash");
  await graphThreadAction(placeholderToken, action.threadId, "trash");
}

function trashed(id: string): boolean {
  return deleteThese.some((row) => row.id === id);
}

await check("exact empty ask from an unknown sender is still safe to delete", () => {
  assert.equal(trashed("noise"), true);
  assert.ok(
    providerCalls.some(
      (call) =>
        call.method === "POST" &&
        call.url ===
          "https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-noise/trash",
    ),
  );
  assert.ok(
    providerCalls.some(
      (call) =>
        call.method === "DELETE" &&
        call.url.includes("graph.microsoft.com") &&
        call.url.includes("/messages/graph-msg-1"),
    ),
  );
});

for (const script of scripts.filter((item) => item.hold)) {
  await check(`${script.id} is not cleared into Delete these`, () => {
    assert.equal(
      trashed(script.id),
      false,
      `${script.id} was offered to Delete these and the clear plan trashes thread-${script.id}`,
    );
    assert.equal(
      providerCalls.some((call) => call.url.includes(`thread-${script.id}`)),
      false,
      `${script.id} reached Gmail or Outlook trash`,
    );
  });
}

await check("a prefixed ask is an open ask for the chief-of-staff router", () => {
  const routingFacts = {
    senderIsKnown: false,
    senderIsInternal: false,
    liveMatterId: null,
    addressedDirectly: true,
  };
  const open = escalationReasons(
    {
      home: "delete",
      summary: "notice",
      rationale: "model said nothing was owed",
      owner: "nobody",
      ask: "Nothing — please approve the wire by Friday",
      obligation: false,
      yields: [],
      evidence: [],
    },
    { routingFacts } as never,
  );
  assert.ok(
    open.includes("delete_open_ask"),
    `prefixed ask was not escalated (${open.join(",") || "no reasons"})`,
  );
  const closed = escalationReasons(
    {
      home: "delete",
      summary: "notice",
      rationale: "nothing owed",
      owner: "nobody",
      ask: `  ${emptyAsk}  `,
      obligation: false,
      yields: [],
      evidence: [],
    },
    { routingFacts } as never,
  );
  assert.equal(closed.includes("delete_open_ask"), false);
});

await check("the fast router does not accept a prefixed delete by itself", async () => {
  const tiers: string[] = [];
  const router = createReaderRouter({
    allowCall: async () => true,
    recordUsage: async () => {},
    call: async (_model, tier) => {
      tiers.push(tier);
      return {
        output: {
          home: "delete",
          summary: "notice",
          rationale: "model said nothing was owed",
          owner: "nobody",
          ask: "Nothing — please approve the wire by Friday",
          obligation: false,
          yields: [],
          evidence: [],
        },
        usage: {},
        latencyMs: 1,
      };
    },
  });
  await router({
    accountId: "account",
    conversationId: "conversation",
    conversation: {
      providerConversationId: "provider",
      subject: "FYI",
      lastMessageAt: "2026-11-20T15:00:00.000Z",
      messages: [],
    },
    contextText: "no prior relationship on record",
    routingFacts: {
      senderIsKnown: false,
      senderIsInternal: false,
      liveMatterId: null,
      addressedDirectly: true,
    },
  } as never);
  assert.ok(
    tiers.includes("strong"),
    `fast delete with a prefixed ask was accepted without review (${tiers.join(",")})`,
  );
});

await check("chief-of-staff safety refuses a delete whose ask only starts with nothing", async () => {
  const { startTestDb } = await import("./v2-testdb.mts");
  const { upsertUser, upsertAccount } = await import("../src/lib/v2/db/accounts.ts");
  const { readConversation } = await import("../src/lib/v2/intelligence/reader.ts");
  const { asConversationId } = await import("../src/lib/v2/db/types.ts");
  const db = await startTestDb();
  try {
    const userId = await upsertUser("me@rditrials.com");
    const accountId = await upsertAccount({
      userId,
      provider: "microsoft",
      email: "me@rditrials.com",
    });
    const body = "Please approve the $50,000 wire by Friday. Nothing about this is optional.";
    const inserted = await db.pool.query<{ id: string }>(
      `insert into seer.conversations (account_id, provider_conversation_id, subject)
         values ($1, $2, $3) returning id`,
      [accountId, "prefix-delete", "FYI"],
    );
    const decision = await readConversation({
      accountId,
      conversationId: asConversationId(inserted.rows[0].id),
      context: {
        ownDomain: "rditrials.com",
        ownEmail: "me@rditrials.com",
        people: [],
        matters: [],
        interests: [],
        placements: [],
      },
      conversation: {
        providerConversationId: "prefix-delete",
        subject: "FYI",
        lastMessageAt: "2026-11-20T15:00:00.000Z",
        messages: [
          {
            providerMessageId: "m-prefix",
            from: { email: "stranger@unknown.example" },
            to: [{ email: "me@rditrials.com" }],
            cc: [],
            sentAt: "2026-11-20T15:00:00.000Z",
            snippet: "Please approve the wire",
            bodyText: body,
            bodyHtml: `<p>${body}</p>`,
            isUnread: true,
            isOutgoing: false,
            attachments: [],
          },
        ],
      },
      model: async (input) => {
        assert.ok(
          input.conversation.messages.some((message) => message.bodyText?.includes(body)),
          "the chief-of-staff model did not receive the attacker body",
        );
        return {
          home: "delete",
          summary: "notice",
          rationale: "model said nothing was owed",
          owner: "nobody",
          ask: "Nothing — please approve the wire by Friday",
          obligation: false,
          yields: [],
          evidence: [],
        };
      },
    });
    assert.notEqual(
      decision.home,
      "delete",
      `safety stored delete (vetoes: ${decision.vetoReasons.join(",") || "none"})`,
    );
  } finally {
    await db.stop();
  }
});

globalThis.fetch = originalFetch;
root.unmount();
await rm(DATA_DIR, { recursive: true, force: true });
try {
  unlinkSync(triageBundle);
} catch {
  /* already removed */
}

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
