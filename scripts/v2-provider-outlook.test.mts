/**
 * Task 4 gate (Outlook): the Graph adapter translates real Graph payloads and
 * passes the shared provider contract, driven by a mocked fetch. Conversation
 * mutations act per message across the conversation, so partial failure is
 * reported.
 */
import assert from "node:assert/strict";
import { runProviderContract, type ContractHarness } from "../src/lib/v2/providers/contract.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";

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
};

let lastReplyAll = false;

const mockFetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? "GET";

  // Folder total for coverage reconciliation.
  if (method === "GET" && u.includes("/mailFolders/inbox?$select=totalItemCount")) {
    return json({ totalItemCount: 3 });
  }

  // Inbox sync (first page + paged second page).
  if (method === "GET" && u.includes("/mailFolders/inbox/messages")) {
    if (!u.includes("skip=1")) {
      return json({
        value: [...CONVOS.c0, ...CONVOS.c1],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?skip=1",
      });
    }
    return json({ value: [...CONVOS.c2] });
  }

  // Conversation messages by conversationId filter (URL is percent-encoded).
  const conv = decodeURIComponent(u).match(/conversationId eq '([^']+)'/);
  if (method === "GET" && u.includes("$filter") && conv) {
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

console.log("v2-provider-outlook: OK");
