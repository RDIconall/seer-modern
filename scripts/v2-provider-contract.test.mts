/**
 * Task 3 gate: the fake provider — the executable reference behavior — passes
 * the shared provider contract. Gmail and Outlook reuse this same suite.
 */
import { runProviderContract, type ContractHarness } from "../src/lib/v2/providers/contract.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { providerFetch, ProviderHttpError } from "../src/lib/v2/providers/http.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";
import assert from "node:assert/strict";

function msg(
  id: string,
  sentAt: string,
  extra: Partial<Message> & { folder?: "inbox" | "sent" | "trash" } = {},
): Message & { folder: "inbox" | "sent" | "trash"; failMutation?: boolean } {
  const folder = extra.folder ?? "inbox";
  return {
    providerMessageId: id,
    from: { email: "sender@example.com", name: "Sender" },
    to: [{ email: "me@example.com" }],
    cc: [{ email: "cc@example.com" }],
    sentAt,
    snippet: "snippet",
    bodyHtml: "<p>body</p>",
    bodyText: "body",
    isUnread: true,
    isOutgoing: folder === "sent",
    attachments: [],
    folder,
    ...extra,
  } as Message & { folder: "inbox" | "sent" | "trash"; failMutation?: boolean };
}

async function makeHarness(): Promise<ContractHarness> {
  // 250 inbox conversations forces multi-page pagination at pageSize 100.
  const conversations = Array.from({ length: 250 }, (_, i) => ({
    providerConversationId: `c${i}`,
    subject: i === 5 ? "Roche pricing thread" : `Subject ${i}`,
    messages: [msg(`c${i}-m1`, "2026-08-01T10:00:00Z")],
  }));
  // A real multi-message thread, ordered out of sequence to test sorting.
  conversations[0].messages = [
    msg("c0-m2", "2026-08-02T10:00:00Z"),
    msg("c0-m1", "2026-08-01T10:00:00Z"),
  ];
  // A thread with one message flagged to fail mutation.
  conversations[1].messages = [
    msg("c1-m1", "2026-08-01T10:00:00Z"),
    msg("c1-m2", "2026-08-01T11:00:00Z", { }) as Message & { folder: "inbox"; failMutation?: boolean },
  ];
  (conversations[1].messages[1] as { failMutation?: boolean }).failMutation = true;

  // 120 sent conversations — multi-page at pageSize 100.
  for (let i = 0; i < 120; i++) {
    const id = `s${i}`;
    conversations.push({
      providerConversationId: id,
      subject: `Sent ${i}`,
      messages: [msg(`${id}-m1`, "2026-08-03T10:00:00Z", { folder: "sent", isOutgoing: true })],
    });
  }
  conversations.push({
    providerConversationId: "s-thread",
    subject: "Sent thread",
    messages: [
      msg("s-thread-m2", "2026-08-04T10:00:00Z", { folder: "sent", isOutgoing: true }),
      msg("s-thread-m1", "2026-08-03T10:00:00Z", { folder: "sent", isOutgoing: true }),
    ],
  });

  // 40 trash conversations.
  for (let i = 0; i < 40; i++) {
    const id = `t${i}`;
    conversations.push({
      providerConversationId: id,
      subject: `Trash ${i}`,
      messages: [msg(`${id}-m1`, "2026-08-05T10:00:00Z", { folder: "trash" })],
    });
  }
  conversations.push({
    providerConversationId: "t-thread",
    subject: "Trash thread",
    messages: [
      msg("t-thread-m2", "2026-08-06T10:00:00Z", { folder: "trash" }),
      msg("t-thread-m1", "2026-08-05T10:00:00Z", { folder: "trash" }),
    ],
  });

  return {
    provider: new FakeProvider({ conversations, pageSize: 100 }),
    threadId: "c0",
    partialFailThreadId: "c1",
    searchTerm: "Roche",
    expectedInboxTotal: 250,
    expectedSentTotal: 121,
    expectedTrashTotal: 41,
    sentThreadId: "s-thread",
    trashThreadId: "t-thread",
  };
}

await runProviderContract(makeHarness);

// --- HTTP behavior: retry then succeed, without waiting on real backoff ------
{
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) {
      return new Response("", { status: 503, headers: { "retry-after": "0" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const body = await providerFetch(
    "https://example.com/x",
    { method: "GET" },
    { provider: "test", fetchImpl, sleep: async () => {} },
  );
  assert.deepEqual(body, { ok: true });
  assert.equal(calls, 2, "must retry a 503 then succeed");
}

// State-setting POSTs are intentionally single-attempt: a timeout or 5xx is
// ambiguous and must be resolved by the outbox/idempotency layer, never by
// replaying the provider mutation inside the HTTP helper.
{
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("provider failed", { status: 503 });
  }) as unknown as typeof fetch;
  await assert.rejects(() =>
    providerFetch(
      "https://example.com/send",
      { method: "POST" },
      { provider: "test", fetchImpl, sleep: async () => {} },
    ),
  );
  assert.equal(calls, 1, "a POST 5xx must not be retried");
}
{
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new Error("socket closed after provider accepted the request");
  }) as unknown as typeof fetch;
  await assert.rejects(() =>
    providerFetch(
      "https://example.com/send",
      { method: "POST" },
      { provider: "test", fetchImpl, sleep: async () => {} },
    ),
  );
  assert.equal(calls, 1, "a POST network error must not be retried");
}

// Empty 2xx body is success (Graph 202 on send).
{
  const fetchImpl = (async () =>
    new Response("", { status: 202 })) as unknown as typeof fetch;
  const body = await providerFetch(
    "https://example.com/send",
    { method: "POST" },
    { provider: "test", fetchImpl, sleep: async () => {} },
  );
  assert.equal(body, null, "empty 2xx must be treated as success");
}

// A 4xx is a structured, non-retryable error.
{
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("bad request", { status: 400 });
  }) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      providerFetch(
        "https://example.com/x",
        { method: "GET" },
        { provider: "test", fetchImpl, sleep: async () => {} },
      ),
    (e) => e instanceof ProviderHttpError && e.status === 400,
  );
  assert.equal(calls, 1, "4xx must not be retried");
}

console.log("v2-provider-contract: OK");
