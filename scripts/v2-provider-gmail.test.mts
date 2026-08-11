/**
 * Task 4 gate (Gmail): the Gmail adapter translates real Gmail REST payloads
 * and passes the shared provider contract, driven by a mocked fetch.
 */
import assert from "node:assert/strict";
import { runProviderContract, type ContractHarness } from "../src/lib/v2/providers/contract.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function gmailMessage(id: string, epoch: number, from: string, subject: string) {
  return {
    id,
    threadId: id.split("-")[0],
    snippet: `snippet ${id}`,
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(epoch),
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "To", value: "me@example.com" },
        { name: "Cc", value: "cc@example.com" },
        { name: "Subject", value: subject },
      ],
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { size: 4, data: b64url("body") } },
        { mimeType: "text/html", body: { size: 11, data: b64url("<p>body</p>") } },
      ],
    },
  };
}

const THREADS: Record<string, { id: string; messages: ReturnType<typeof gmailMessage>[] }> = {
  c0: {
    id: "c0",
    messages: [
      gmailMessage("c0-m2", 1_600_000_200_000, "sender@example.com", "Thread zero"),
      gmailMessage("c0-m1", 1_600_000_100_000, "sender@example.com", "Thread zero"),
    ],
  },
  c1: {
    id: "c1",
    messages: [
      gmailMessage("c1-m1", 1_600_000_100_000, "sender@example.com", "Thread one"),
      gmailMessage("c1-m2", 1_600_000_150_000, "sender@example.com", "Thread one"),
    ],
  },
  c2: {
    id: "c2",
    messages: [gmailMessage("c2-m1", 1_600_000_100_000, "vendor@roche.com", "Roche pricing")],
  },
  c3: {
    id: "c3",
    messages: [
      {
        ...gmailMessage("c3-m1", 1_600_000_100_000, "sender@example.com", "Already archived"),
        labelIds: ["ARCHIVE"],
      },
    ],
  },
  s0: {
    id: "s0",
    messages: [
      gmailMessage("s0-m2", 1_600_000_300_000, "me@example.com", "Sent thread"),
      gmailMessage("s0-m1", 1_600_000_250_000, "me@example.com", "Sent thread"),
    ],
  },
  s1: {
    id: "s1",
    messages: [gmailMessage("s1-m1", 1_600_000_200_000, "me@example.com", "Sent one")],
  },
  t0: {
    id: "t0",
    messages: [
      gmailMessage("t0-m2", 1_600_000_400_000, "sender@example.com", "Trash thread"),
      gmailMessage("t0-m1", 1_600_000_350_000, "sender@example.com", "Trash thread"),
    ],
  },
};

let lastSendRaw = "";

const mockFetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? "GET";

  if (method === "GET" && u.includes("/threads?")) {
    const q = new URL(u).searchParams;
    const query = q.get("q") ?? "";
    const pageToken = q.get("pageToken");
    if (query.includes("Roche")) {
      return json({ threads: [{ id: "c2" }], resultSizeEstimate: 1 });
    }
    if (query.includes("in:sent")) {
      if (!pageToken) {
        return json({ threads: [{ id: "s0" }], nextPageToken: "p2", resultSizeEstimate: 2 });
      }
      return json({ threads: [{ id: "s1" }], resultSizeEstimate: 2 });
    }
    if (query.includes("in:trash")) {
      return json({ threads: [{ id: "t0" }], resultSizeEstimate: 1 });
    }
    // in:inbox — paginate 3 threads at pageSize 2.
    if (!pageToken) {
      return json({ threads: [{ id: "c0" }, { id: "c1" }], nextPageToken: "p2", resultSizeEstimate: 3 });
    }
    return json({ threads: [{ id: "c2" }], resultSizeEstimate: 3 });
  }

  const threadGet = u.match(/\/threads\/([^?]+)\?format=full/);
  if (method === "GET" && threadGet) {
    const t = THREADS[decodeURIComponent(threadGet[1])];
    return json({ id: t.id, messages: t.messages });
  }

  if (method === "POST" && u.endsWith("/messages/send")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    lastSendRaw = typeof body.raw === "string" ? Buffer.from(body.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";
    return json({ id: "sent-1", threadId: body.threadId ?? "sent-1" });
  }

  const trash = u.match(/\/messages\/([^/]+)\/trash$/);
  if (method === "POST" && trash) {
    // c1-m2 is the flagged partial failure.
    if (trash[1] === "c1-m2") return new Response("nope", { status: 400 });
    return json({ id: trash[1] });
  }

  const modify = u.match(/\/messages\/([^/]+)\/modify$/);
  if (method === "POST" && modify) {
    if (modify[1] === "c1-m2") return new Response("nope", { status: 400 });
    if (modify[1] === "gone-m1") return new Response("gone", { status: 404 });
    return json({ id: modify[1] });
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
    provider: new GmailProvider({
      accessToken: "test-token",
      accountEmail: "me@example.com",
      fetchImpl: mockFetch,
      pageSize: 2,
    }),
    threadId: "c0",
    partialFailThreadId: "c1",
    searchTerm: "Roche",
    expectedInboxTotal: 3,
    expectedSentTotal: 2,
    expectedTrashTotal: 1,
    sentThreadId: "s0",
    trashThreadId: "t0",
  };
}

await runProviderContract(makeHarness);

// Spot-check translation fidelity beyond the contract.
const provider = new GmailProvider({
  accessToken: "t",
  accountEmail: "me@example.com",
  fetchImpl: mockFetch,
  pageSize: 2,
});
const convo = await provider.getConversation("c0");
assert.equal(convo.messages[0].bodyHtml, "<p>body</p>");
assert.equal(convo.messages[0].from.email, "sender@example.com");
assert.equal(convo.messages[0].isUnread, true);
assert.match(provider.nativeUrl("c0"), /mail\.google\.com/);

// Reply-all derives recipients from the thread (sender + other recipients,
// excluding self) and threads the reply.
await provider.reply({ conversationId: "c0", all: true, bodyHtml: "<p>ok</p>" }, "k");
assert.match(lastSendRaw, /To: .*sender@example\.com/);
assert.match(lastSendRaw, /cc@example\.com/);
assert.ok(!/To:.*\bme@example\.com\b/.test(lastSendRaw), "must not reply to self");

// State-setting idempotency: already-archived threads and 404-after-move are no-ops.
const archived = await provider.mutateConversation("c3", "archive", "idem-1");
assert.equal(archived.failed.length, 0);
assert.equal(archived.processed.length, 1);
const archivedAgain = await provider.mutateConversation("c3", "archive", "idem-2");
assert.equal(archivedAgain.failed.length, 0);

THREADS.gone = {
  id: "gone",
  messages: [gmailMessage("gone-m1", 1_600_000_100_000, "sender@example.com", "Gone")],
};
const gone = await provider.mutateConversation("gone", "archive", "idem-3");
assert.equal(gone.failed.length, 0);
assert.equal(gone.processed.length, 1);

console.log("v2-provider-gmail: OK");
