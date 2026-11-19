/**
 * Outlook conversation hydration must stop before it retains an unbounded
 * Graph thread. These limits are the spec a fix has to meet (tighter limits
 * are fine). The cases call OutlookProvider, which is the code scheduled sync,
 * push wake, reply, forward, move, mutation, and synthetic attachment lookup
 * all run. They fail while every next page is appended to one array.
 *
 *   OUTLOOK_CONVERSATION_MESSAGE_CAP — messages kept from one conversation
 *   OUTLOOK_CONVERSATION_RESPONSE_BYTE_CAP — raw Graph response bytes read
 *     for that conversation (a single response or the sum of its pages)
 *   OUTLOOK_CONVERSATION_READ_SLACK — one extra read chunk may cross the cap
 *
 * Run: tsx scripts/v2-outlook-conversation-bound.test.mts
 */
import assert from "node:assert/strict";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import type { MutationAction } from "../src/lib/v2/providers/types.ts";

/** Messages one conversation load may keep. */
export const OUTLOOK_CONVERSATION_MESSAGE_CAP = 200;
/** Raw response bytes one conversation load may read before it stops. */
export const OUTLOOK_CONVERSATION_RESPONSE_BYTE_CAP = 2 * 1024 * 1024;
/** Node's fetch prefetches one 64KiB chunk before the caller reads the body. */
export const OUTLOOK_CONVERSATION_READ_SLACK = 64 * 1024;

const CONV = "AAQkAttackerThread";
const FUTURE_DEADLINE_MS = () => Date.now() + 60_000;

type Fixture = {
  total: number;
  /** Graph server-side page: one message per page even when $top is larger. */
  onePerPage: boolean;
  body: (index: number) => string;
  contentLength: boolean;
};

type Stats = {
  conversationGets: number;
  bytesPulled: number;
  responseBytes: number;
};

function fullMessage(index: number, html: string) {
  return {
    id: `msg-${index}`,
    conversationId: CONV,
    subject: "Rate update",
    from: { emailAddress: { address: "attacker@example.com", name: "Attacker" } },
    toRecipients: [{ emailAddress: { address: "me@example.com", name: "Me" } }],
    ccRecipients: [] as unknown[],
    receivedDateTime: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    bodyPreview: "preview",
    body: { contentType: "html", content: html },
    isRead: true,
    hasAttachments: true,
    parentFolderId: "mail-folder",
    attachments: [
      {
        id: `att-${index}`,
        name: "note.txt",
        contentType: "text/plain",
        size: 4,
      },
    ],
  };
}

function applySelect(
  message: Record<string, unknown>,
  select: string | null,
): Record<string, unknown> {
  if (!select) return message;
  const fields = select.split(",").map((field) => field.trim());
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in message) picked[field] = message[field];
  }
  return picked;
}

function countedJson(
  payload: unknown,
  stats: Stats,
  contentLength: boolean,
): Response {
  const encoded = Buffer.from(JSON.stringify(payload));
  stats.responseBytes += encoded.byteLength;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 32 * 1024, encoded.length);
      const chunk = encoded.subarray(offset, end);
      offset = end;
      stats.bytesPulled += chunk.byteLength;
      controller.enqueue(Uint8Array.from(chunk));
    },
  });
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength) headers.set("content-length", String(encoded.byteLength));
  return new Response(stream, { status: 200, headers });
}

function makeProvider(fixture: Fixture, stats: Stats): OutlookProvider {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = String(url);
    const decoded = decodeURIComponent(raw);
    if (method !== "GET") {
      return new Response(null, { status: 202 });
    }
    if (decoded.includes("/mailFolders/") && decoded.includes("/messages")) {
      return countedJson(
        {
          "@odata.count": 1,
          value: [
            {
              id: "inbox-1",
              conversationId: CONV,
              subject: "Rate update",
              from: {
                emailAddress: { address: "attacker@example.com", name: "Attacker" },
              },
              toRecipients: [{ emailAddress: { address: "me@example.com" } }],
              receivedDateTime: "2026-01-01T00:00:00Z",
              bodyPreview: "preview",
              isRead: true,
              hasAttachments: false,
            },
          ],
        },
        // Folder listing is not the conversation body this cap covers.
        { conversationGets: 0, bytesPulled: 0, responseBytes: 0 },
        true,
      );
    }
    if (
      decoded.includes("conversationId eq") ||
      decoded.includes("conversationPage=")
    ) {
      const parsed = new URL(raw);
      const page = Number(parsed.searchParams.get("conversationPage") ?? "0");
      const requestedTop = Number(parsed.searchParams.get("$top") ?? "50");
      const top =
        Number.isFinite(requestedTop) && requestedTop > 0 ? requestedTop : 50;
      // The adapter asks for 50. Graph may still return a shorter page and a
      // next link (server-side paging). Never invent more than $top items.
      const pageSize = fixture.onePerPage ? 1 : Math.min(top, 50);
      const start = page * pageSize;
      const select = parsed.searchParams.get("$select");
      const value = [];
      for (let i = start; i < Math.min(start + pageSize, fixture.total); i++) {
        value.push(applySelect(fullMessage(i, fixture.body(i)), select));
      }
      const payload: Record<string, unknown> = { value };
      if (start + pageSize < fixture.total) {
        const next = new URL(parsed.toString());
        next.searchParams.set("conversationPage", String(page + 1));
        payload["@odata.nextLink"] = next.toString();
      }
      stats.conversationGets += 1;
      return countedJson(payload, stats, fixture.contentLength);
    }
    throw new Error(`unexpected ${method} ${raw}`);
  }) as typeof fetch;

  return new OutlookProvider({
    accessToken: "test-token",
    accountEmail: "me@example.com",
    fetchImpl,
  });
}

function retained(value: unknown): { messages: number; bodyBytes: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as {
    messages?: { bodyHtml: string | null; bodyText: string | null }[];
    conversations?: {
      messages: { bodyHtml: string | null; bodyText: string | null }[];
    }[];
  };
  const messages = record.conversations
    ? record.conversations.flatMap((conversation) => conversation.messages)
    : record.messages;
  if (!messages) return null;
  let bodyBytes = 0;
  for (const message of messages) {
    bodyBytes += message.bodyHtml?.length ?? 0;
    bodyBytes += message.bodyText?.length ?? 0;
  }
  return { messages: messages.length, bodyBytes };
}

async function assertBounded(
  name: string,
  fixture: Fixture,
  limits: { maxGets: number; maxBytes: number },
  run: (provider: OutlookProvider) => Promise<unknown>,
): Promise<void> {
  const stats: Stats = { conversationGets: 0, bytesPulled: 0, responseBytes: 0 };
  const provider = makeProvider(fixture, stats);
  let result: unknown;
  let thrown: unknown;
  try {
    result = await run(provider);
  } catch (error) {
    thrown = error;
  }
  const kept = retained(result);
  const detail = `${name}: pages=${stats.conversationGets} (max ${limits.maxGets}), bytesRead=${stats.bytesPulled} (max ${limits.maxBytes}), responseBytes=${stats.responseBytes}, keptMessages=${kept?.messages ?? "n/a"}, keptBodyBytes=${kept?.bodyBytes ?? "n/a"}, thrown=${thrown instanceof Error ? thrown.name : Boolean(thrown)}`;
  assert.ok(stats.conversationGets <= limits.maxGets, detail);
  assert.ok(stats.bytesPulled <= limits.maxBytes, detail);
  if (kept) {
    assert.ok(kept.messages <= OUTLOOK_CONVERSATION_MESSAGE_CAP, detail);
    assert.ok(kept.bodyBytes <= OUTLOOK_CONVERSATION_RESPONSE_BYTE_CAP, detail);
  }
}

const manySmall: Fixture = {
  total: 1_000,
  onePerPage: false,
  body: () => "<p>x</p>",
  contentLength: true,
};

const accumulated: Fixture = {
  total: 4,
  onePerPage: true,
  body: () => "A".repeat(1024 * 1024),
  contentLength: true,
};

function oversized(contentLength: boolean): Fixture {
  return {
    total: 1,
    onePerPage: true,
    body: () =>
      "B".repeat(
        OUTLOOK_CONVERSATION_RESPONSE_BYTE_CAP +
          OUTLOOK_CONVERSATION_READ_SLACK +
          256 * 1024,
      ),
    contentLength,
  };
}

const countLimits = {
  maxGets: OUTLOOK_CONVERSATION_MESSAGE_CAP / 50,
  maxBytes: OUTLOOK_CONVERSATION_RESPONSE_BYTE_CAP + OUTLOOK_CONVERSATION_READ_SLACK,
};

const byteLimits = {
  // Four 1MiB pages are offered. Two fit under the cap; a third may start and
  // must be abandoned before the cap plus one chunk. The fourth must not.
  maxGets: 3,
  maxBytes: OUTLOOK_CONVERSATION_RESPONSE_BYTE_CAP + OUTLOOK_CONVERSATION_READ_SLACK,
};

const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}\n${message}`);
    console.error(`not ok - ${name}\n${message}\n`);
  }
}

await test(
  "syncFolder still returns a short thread that is under the cap",
  async () => {
    const stats: Stats = { conversationGets: 0, bytesPulled: 0, responseBytes: 0 };
    const provider = makeProvider(
      { total: 2, onePerPage: false, body: (i) => `<p>body ${i}</p>`, contentLength: true },
      stats,
    );
    const page = await provider.syncFolder("inbox", null, {
      deadlineMs: FUTURE_DEADLINE_MS(),
    });
    assert.equal(page.conversations.length, 1);
    assert.equal(page.conversations[0]?.messages.length, 2);
    assert.equal(page.conversations[0]?.messages[0]?.bodyHtml, "<p>body 0</p>");
    assert.equal(stats.conversationGets, 1);
  },
);

await test(
  "syncFolder stops after the message cap while the sync deadline is still open",
  async () => {
    await assertBounded("syncFolder count", manySmall, countLimits, (provider) =>
      provider.syncFolder("inbox", null, { deadlineMs: FUTURE_DEADLINE_MS() }),
    );
  },
);

await test(
  "syncFolder stops once accumulated conversation response bytes pass the cap",
  async () => {
    await assertBounded("syncFolder bytes", accumulated, byteLimits, (provider) =>
      provider.syncFolder("inbox", null, { deadlineMs: FUTURE_DEADLINE_MS() }),
    );
  },
);

await test(
  "syncFolder does not read a whole Graph page whose Content-Length is over the cap",
  async () => {
    await assertBounded(
      "syncFolder content-length",
      oversized(true),
      byteLimits,
      (provider) =>
        provider.syncFolder("inbox", null, { deadlineMs: FUTURE_DEADLINE_MS() }),
    );
  },
);

await test(
  "syncFolder does not buffer a whole oversized Graph page that omits Content-Length",
  async () => {
    await assertBounded(
      "syncFolder chunked",
      oversized(false),
      byteLimits,
      (provider) =>
        provider.syncFolder("inbox", null, { deadlineMs: FUTURE_DEADLINE_MS() }),
    );
  },
);

await test("getConversation stops after the message cap", async () => {
  await assertBounded("getConversation count", manySmall, countLimits, (provider) =>
    provider.getConversation(CONV),
  );
});

await test("getConversation stops once accumulated response bytes pass the cap", async () => {
  await assertBounded("getConversation bytes", accumulated, byteLimits, (provider) =>
    provider.getConversation(CONV),
  );
});

await test(
  "getConversation does not read a whole page whose Content-Length is over the cap",
  async () => {
    await assertBounded(
      "getConversation content-length",
      oversized(true),
      byteLimits,
      (provider) => provider.getConversation(CONV),
    );
  },
);

await test("reply stops after the message cap with no sync deadline", async () => {
  await assertBounded("reply count", manySmall, countLimits, (provider) =>
    provider.reply({ conversationId: CONV, all: false, bodyHtml: "<p>ok</p>" }, "key"),
  );
});

await test("reply stops once accumulated response bytes pass the cap", async () => {
  await assertBounded("reply bytes", accumulated, byteLimits, (provider) =>
    provider.reply({ conversationId: CONV, all: true, bodyHtml: "<p>ok</p>" }, "key"),
  );
});

await test(
  "reply does not buffer a whole oversized page that omits Content-Length",
  async () => {
    await assertBounded("reply chunked", oversized(false), byteLimits, (provider) =>
      provider.reply({ conversationId: CONV, all: false, bodyHtml: "<p>ok</p>" }, "key"),
    );
  },
);

await test("forward stops after the message cap with no sync deadline", async () => {
  await assertBounded("forward count", manySmall, countLimits, (provider) =>
    provider.forward(
      {
        conversationId: CONV,
        to: [{ email: "other@example.com" }],
        bodyHtml: "<p>ok</p>",
      },
      "key",
    ),
  );
});

await test("forward stops once accumulated response bytes pass the cap", async () => {
  await assertBounded("forward bytes", accumulated, byteLimits, (provider) =>
    provider.forward(
      {
        conversationId: CONV,
        to: [{ email: "other@example.com" }],
        bodyHtml: "<p>ok</p>",
      },
      "key",
    ),
  );
});

await test("moveConversation stops after the message cap with no sync deadline", async () => {
  await assertBounded("move count", manySmall, countLimits, (provider) =>
    provider.moveConversation(CONV, "archive", "key"),
  );
});

await test("moveConversation stops once accumulated response bytes pass the cap", async () => {
  await assertBounded("move bytes", accumulated, byteLimits, (provider) =>
    provider.moveConversation(CONV, "archive", "key"),
  );
});

const mutations: MutationAction[] = ["archive", "trash", "restore", "markUnread"];
for (const action of mutations) {
  await test(`mutateConversation ${action} stops after the message cap`, async () => {
    await assertBounded(`mutate ${action} count`, manySmall, countLimits, (provider) =>
      provider.mutateConversation(CONV, action, "key"),
    );
  });
  await test(
    `mutateConversation ${action} stops once accumulated response bytes pass the cap`,
    async () => {
      await assertBounded(`mutate ${action} bytes`, accumulated, byteLimits, (provider) =>
        provider.mutateConversation(CONV, action, "key"),
      );
    },
  );
}

if (failures.length > 0) {
  console.error(`${failures.length} test(s) failed`);
  process.exit(1);
}
console.log("all outlook conversation bound tests passed");
