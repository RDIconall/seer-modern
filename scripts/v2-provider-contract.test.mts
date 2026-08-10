/**
 * Task 3 gate: the fake provider — the executable reference behavior — passes
 * the shared provider contract. Gmail and Outlook reuse this same suite.
 */
import { runProviderContract, type ContractHarness } from "../src/lib/v2/providers/contract.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { providerFetch, ProviderHttpError } from "../src/lib/v2/providers/http.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";
import assert from "node:assert/strict";

function msg(id: string, sentAt: string, extra: Partial<Message> = {}): Message & { folder: "inbox"; failMutation?: boolean } {
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
    isOutgoing: false,
    attachments: [],
    folder: "inbox",
    ...extra,
  } as Message & { folder: "inbox"; failMutation?: boolean };
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

  return {
    provider: new FakeProvider({ conversations, pageSize: 100 }),
    threadId: "c0",
    partialFailThreadId: "c1",
    searchTerm: "Roche",
    expectedInboxTotal: 250,
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
