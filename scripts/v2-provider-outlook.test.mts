/**
 * Task 4 gate (Outlook): the Graph adapter translates real Graph payloads and
 * passes the shared provider contract, driven by a mocked fetch. Conversation
 * mutations act per message across the conversation, so partial failure is
 * reported.
 */
import assert from "node:assert/strict";
import { runProviderContract, type ContractHarness } from "../src/lib/v2/providers/contract.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import { isProviderReconcileError } from "../src/lib/v2/providers/mutation-idempotent.ts";
import { ProviderHttpError } from "../src/lib/v2/providers/http.ts";

function graphMsg(id: string, convId: string, when: string, from: string, subject: string) {
  return {
    id,
    conversationId: convId,
    subject,
    from: { emailAddress: { address: from, name: from } },
    toRecipients: [{ emailAddress: { address: "me@example.com" } }],
    ccRecipients: [{ emailAddress: { address: "cc@example.com" } }],
    receivedDateTime: when,
    bodyPreview: `preview ${id}`,
    body: { contentType: "html", content: "<p>body</p>" },
    isRead: false,
    hasAttachments: false,
  };
}

const CONVOS: Record<string, ReturnType<typeof graphMsg>[]> = {
  c0: [
    graphMsg("c0-m2", "c0", "2026-08-02T10:00:00Z", "sender@example.com", "Thread zero"),
    graphMsg("c0-m1", "c0", "2026-08-01T10:00:00Z", "sender@example.com", "Thread zero"),
  ],
  c1: [
    graphMsg("c1-m1", "c1", "2026-08-01T10:00:00Z", "sender@example.com", "Thread one"),
    graphMsg("c1-m2", "c1", "2026-08-01T11:00:00Z", "sender@example.com", "Thread one"),
  ],
  c2: [graphMsg("c2-m1", "c2", "2026-08-01T10:00:00Z", "vendor@roche.com", "Roche pricing")],
  c3: [
    {
      ...graphMsg("c3-m1", "c3", "2026-08-01T10:00:00Z", "sender@example.com", "Archived"),
      parentFolderId: "archive",
    },
  ],
  s0: [
    graphMsg("s0-m2", "s0", "2026-08-03T10:00:00Z", "me@example.com", "Sent thread"),
    graphMsg("s0-m1", "s0", "2026-08-02T10:00:00Z", "me@example.com", "Sent thread"),
  ],
  s1: [graphMsg("s1-m1", "s1", "2026-08-02T10:00:00Z", "me@example.com", "Sent one")],
  t0: [
    graphMsg("t0-m2", "t0", "2026-08-05T10:00:00Z", "sender@example.com", "Trash thread"),
    graphMsg("t0-m1", "t0", "2026-08-04T10:00:00Z", "sender@example.com", "Trash thread"),
  ],
};

let lastReplyAll = false;

const mockFetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? "GET";

  // Folder totals for coverage reconciliation.
  if (method === "GET" && u.includes("/mailFolders/inbox?$select=totalItemCount")) {
    return json({ totalItemCount: 3 });
  }
  if (method === "GET" && u.includes("/mailFolders/sentitems?$select=totalItemCount")) {
    return json({ totalItemCount: 2 });
  }
  if (method === "GET" && u.includes("/mailFolders/deleteditems?$select=totalItemCount")) {
    return json({ totalItemCount: 1 });
  }

  // Inbox sync — only c0-m2 on page 1; c0-m1 appears on page 2 (split thread).
  if (method === "GET" && u.includes("/mailFolders/inbox/messages")) {
    if (!u.includes("skip=1")) {
      return json({
        value: [CONVOS.c0[0], ...CONVOS.c1],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?skip=1",
      });
    }
    return json({ value: [CONVOS.c2[0], CONVOS.c0[1]] });
  }

  // Sent sync.
  if (method === "GET" && u.includes("/mailFolders/sentitems/messages")) {
    if (!u.includes("skip=1")) {
      return json({
        value: [...CONVOS.s0],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?skip=1",
      });
    }
    return json({ value: [...CONVOS.s1] });
  }

  // Trash sync.
  if (method === "GET" && u.includes("/mailFolders/deleteditems/messages")) {
    return json({ value: [...CONVOS.t0] });
  }

  // Conversation messages by conversationId filter (URL is percent-encoded).
  const conv = decodeURIComponent(u).match(/conversationId eq '([^']+)'/);
  if (method === "GET" && u.includes("$filter") && conv) {
    if (conv[1] === "missing-thread") {
      return new Response("not found", { status: 404 });
    }
    if (conv[1] === "empty-thread") {
      return json({ value: [] });
    }
    return json({ value: CONVOS[conv[1]] ?? [] });
  }

  // Search.
  if (method === "GET" && u.includes("/messages?$search")) {
    return json({ value: CONVOS.c2 });
  }

  // Reply / replyAll / forward / move / sendMail.
  const reply = u.match(/\/messages\/([^/]+)\/(reply|replyAll)$/);
  if (method === "POST" && reply) {
    lastReplyAll = reply[2] === "replyAll";
    return new Response("", { status: 202 });
  }
  const move = u.match(/\/messages\/([^/]+)\/move$/);
  if (method === "POST" && move) {
    if (move[1] === "c1-m2") return new Response("nope", { status: 400 });
    if (move[1] === "gone-m1") return new Response("gone", { status: 404 });
    return json({ id: move[1] });
  }
  if (method === "POST" && u.endsWith("/sendMail")) {
    return new Response("", { status: 202 });
  }

  throw new Error(`unexpected request: ${method} ${u}`);
}) as unknown as typeof fetch;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function makeHarness(): Promise<ContractHarness> {
  return {
    provider: new OutlookProvider({
      accessToken: "test-token",
      accountEmail: "me@example.com",
      fetchImpl: mockFetch,
      pageSize: 50,
    }),
    threadId: "c0",
    partialFailThreadId: "c1",
    searchTerm: "Roche",
    expectedInboxTotal: 3,
    expectedSentTotal: 2,
    expectedTrashTotal: 1,
    sentThreadId: "s0",
    trashThreadId: "t0",
    splitPageThreadId: "c0",
    splitPageThreadMessageCount: 2,
  };
}

await runProviderContract(makeHarness);

// Translation + reply-all endpoint selection.
const provider = new OutlookProvider({
  accessToken: "t",
  accountEmail: "me@example.com",
  fetchImpl: mockFetch,
  pageSize: 50,
});
const convo = await provider.getConversation("c0");
assert.equal(convo.messages.length, 2);
assert.equal(convo.messages[0].sentAt, "2026-08-01T10:00:00Z"); // ordered oldest-first
assert.equal(convo.messages[0].bodyHtml, "<p>body</p>");
assert.equal(convo.messages[0].isUnread, true);

await provider.reply({ conversationId: "c0", all: true, bodyHtml: "<p>ok</p>" }, "k");
assert.equal(lastReplyAll, true, "reply-all must call the replyAll endpoint");
assert.match(provider.nativeUrl("c0"), /outlook\.office\.com/);

// Split-page hydration: folder page 1 lists only c0-m2 but syncFolder must emit both messages.
const page1 = await provider.syncFolder("inbox", null);
const split = page1.conversations.find((c) => c.providerConversationId === "c0");
assert.ok(split, "split-page thread must appear on first folder page");
assert.equal(split!.messages.length, 2);
assert.equal(split!.messages[0].sentAt, "2026-08-01T10:00:00Z");
assert.equal(split!.messages[0].bodyHtml, "<p>body</p>");

// State-setting idempotency: already-archived and 404-after-move are no-ops.
const archived = await provider.mutateConversation("c3", "archive", "idem-1");
assert.equal(archived.failed.length, 0);
assert.equal(archived.processed.length, 1);
CONVOS.gone = [
  graphMsg("gone-m1", "gone", "2026-08-01T10:00:00Z", "sender@example.com", "Gone"),
];
const gone = await provider.mutateConversation("gone", "archive", "idem-2");
assert.equal(gone.failed.length, 0);
assert.equal(gone.processed.length, 1);

// Initial conversation fetch 404 is ambiguous — must throw reconcile error.
await assert.rejects(
  () => provider.mutateConversation("missing-thread", "archive", "idem-missing"),
  (err: unknown) =>
    isProviderReconcileError(err) ||
    (err instanceof ProviderHttpError && err.status === 404),
);

// Graph 200 + empty value[] on initial fetch is ambiguous — reconcile, not no-op.
await assert.rejects(
  () => provider.mutateConversation("empty-thread", "archive", "idem-empty"),
  isProviderReconcileError,
);

// A large conversation hydration must stop before requesting another Graph
// page when the sync slice deadline expires.
{
  let hydrationPages = 0;
  const hugeThreadFetch = (async (url: string) => {
    const u = String(url);
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (u.includes("/mailFolders/inbox/messages")) {
      return json({
        value: [graphMsg("huge-m1", "huge", "2026-08-01T10:00:00Z", "sender@example.com", "Huge")],
      });
    }
    if (u.includes("$filter")) {
      hydrationPages++;
      return json({
        value: [
          graphMsg(
            `huge-page-${hydrationPages}`,
            "huge",
            "2026-08-01T10:00:00Z",
            "sender@example.com",
            "Huge",
          ),
        ],
        "@odata.nextLink": `${u}&page=${hydrationPages + 1}`,
      });
    }
    throw new Error(`unexpected huge-thread request: ${u}`);
  }) as unknown as typeof fetch;
  const hugeProvider = new OutlookProvider({
    accessToken: "test-token",
    accountEmail: "me@example.com",
    fetchImpl: hugeThreadFetch,
    pageSize: 1,
  });
  const started = Date.now();
  await assert.rejects(
    () =>
      hugeProvider.syncFolder("inbox", null, {
        deadlineMs: started + 20,
      }),
    /deadline|budget|aborted/i,
  );
  assert.ok(hydrationPages < 10, "deadline must stop before unbounded thread hydration");
  assert.ok(Date.now() - started < 500, "a huge thread must not starve later sync slices");
}

console.log("v2-provider-outlook: OK");
