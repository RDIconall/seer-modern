/**
 * Spec for unbounded attachment bytes on mailbox send.
 *
 * These checks fail while a signed-in caller can hand the v2 send command, or
 * the legacy Gmail/Graph send helpers, attachment blobs the compose UI would
 * have refused. They pass once every outbound send path refuses — before a
 * provider HTTP call, before MIME is joined or wrapped, and before the v2
 * command bus reserves a receipt — when any of these is true:
 *
 * - more than five attachments
 * - sizeBytes is negative or greater than 3_000_000
 * - contentBase64 does not match the legacy alphabet ^[A-Za-z0-9+/]*={0,2}$
 * - decoded bytes exceed 3_000_000 even when sizeBytes is smaller
 * - filename is empty
 * - HTML or legacy plain body length exceeds 3_000_000 characters
 *
 * A single attachment of exactly 3_000_000 decoded bytes, a send of five small
 * files, and a short body must still be delivered to the provider.
 *
 * Run: npx tsx scripts/unbounded-attachment-send.test.mts
 */
import assert from "node:assert/strict";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { sendGmailMessage } from "../src/lib/mail/gmail.ts";
import { replyGraphMessage, sendGraphMessage } from "../src/lib/mail/graph.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import type { OutboundAttachment } from "../src/lib/v2/providers/types.ts";
import { startTestDb, type TestDb } from "./v2-testdb.mts";

const MAX_ATTACHMENT_BYTES = 3_000_000;
const MAX_BODY_CHARS = 3_000_000;
const TOKEN = "test-access-token";
const FROM = "sender@rditrials.com";
const TO = "person@example.com";

const atLimit = Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x61).toString("base64");
const overLimit = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61).toString("base64");
const oneByte = Buffer.alloc(1, 0x61).toString("base64");
const overBody = "x".repeat(MAX_BODY_CHARS + 1);

type Spy = {
  fetchCalls: number;
  maxBody: number;
  mimeJoined: boolean;
  wrapped: boolean;
  utf8Mime: boolean;
  providerJson: boolean;
  maxUtf8: number;
  maxJson: number;
};

function file(filename: string, contentBase64: string, sizeBytes: number): OutboundAttachment {
  return { filename, mimeType: "text/plain", contentBase64, sizeBytes };
}

function blankSpy(): Spy {
  return {
    fetchCalls: 0,
    maxBody: 0,
    mimeJoined: false,
    wrapped: false,
    utf8Mime: false,
    providerJson: false,
    maxUtf8: 0,
    maxJson: 0,
  };
}

/**
 * Watch the steps encodeRaw / buildMime / Graph JSON actually perform:
 * 76-column wrapping, joining a MIME document, Buffer.from(utf8) of that
 * document, and JSON.stringify of a provider body that carries `raw` or
 * `contentBytes`.
 */
function installSpies(spy: Spy): () => void {
  const originalFrom = Buffer.from;
  const originalMatch = String.prototype.match;
  const originalJoin = Array.prototype.join;
  const originalStringify = JSON.stringify;

  Buffer.from = function bufferFromSpy(this: unknown, ...args: unknown[]) {
    const value = args[0];
    const encoding = args[1];
    if ((encoding === "utf8" || encoding === "utf-8") && typeof value === "string") {
      spy.maxUtf8 = Math.max(spy.maxUtf8, value.length);
      if (value.includes("MIME-Version: 1.0")) spy.utf8Mime = true;
    }
    return originalFrom.apply(this as never, args as never);
  } as typeof Buffer.from;

  String.prototype.match = function matchSpy(this: string, regexp: RegExp | string) {
    if (regexp instanceof RegExp && regexp.source === ".{1,76}") spy.wrapped = true;
    return originalMatch.call(this, regexp as never);
  };

  Array.prototype.join = function joinSpy(this: unknown[], separator?: string) {
    const out = originalJoin.call(this, separator);
    if (typeof out === "string" && out.includes("MIME-Version: 1.0")) spy.mimeJoined = true;
    return out;
  };

  JSON.stringify = function stringifySpy(value: unknown, replacer?: unknown, space?: unknown) {
    const out = originalStringify.call(JSON, value, replacer as never, space as never);
    if (typeof out === "string") {
      spy.maxJson = Math.max(spy.maxJson, out.length);
      if (out.includes('"contentBytes"') || out.includes('"raw"')) spy.providerJson = true;
    }
    return out;
  };

  return () => {
    Buffer.from = originalFrom;
    String.prototype.match = originalMatch;
    Array.prototype.join = originalJoin;
    JSON.stringify = originalStringify;
  };
}

function providerFetch(spy: Spy): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    spy.fetchCalls += 1;
    spy.maxBody = Math.max(spy.maxBody, body.length);
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.includes("gmail.googleapis.com")) {
      return new Response(
        JSON.stringify({
          id: "t1",
          messages: [
            {
              id: "m1",
              threadId: "t1",
              internalDate: "1700000000000",
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "From", value: "person@example.com" },
                  { name: "To", value: FROM },
                  { name: "Subject", value: "Hello" },
                ],
                body: { size: 2, data: "aGk" },
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "GET") {
      return new Response(
        JSON.stringify({
          value: [
            {
              id: "m1",
              conversationId: "t1",
              subject: "Hello",
              from: { emailAddress: { address: "person@example.com" } },
              toRecipients: [{ emailAddress: { address: FROM } }],
              receivedDateTime: "2026-01-01T00:00:00Z",
              bodyPreview: "hi",
              body: { contentType: "Text", content: "hi" },
              isRead: true,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("gmail.googleapis.com")) {
      return new Response(JSON.stringify({ id: "m1", threadId: "t1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("", { status: 202 });
  }) as typeof fetch;
}

function encoded(spy: Spy): boolean {
  return (
    spy.fetchCalls > 0 ||
    spy.mimeJoined ||
    spy.wrapped ||
    spy.utf8Mime ||
    spy.providerJson ||
    spy.maxUtf8 > 100_000 ||
    spy.maxJson > 100_000
  );
}

async function expectRefused(run: (fetchImpl: typeof fetch) => Promise<unknown>): Promise<void> {
  const spy = blankSpy();
  const restore = installSpies(spy);
  const fetchImpl = providerFetch(spy);
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    let outcome: unknown;
    let threw = false;
    try {
      outcome = await run(fetchImpl);
    } catch (cause) {
      threw = true;
      outcome = cause;
    }
    const commandRefusal =
      !!outcome &&
      typeof outcome === "object" &&
      "ok" in outcome &&
      (outcome as { ok: unknown }).ok === false;
    const refused = threw || commandRefusal;
    if (!refused || encoded(spy)) {
      throw new Error(
        `expected refusal before MIME wrapping or provider encoding; ` +
          `refused=${refused} fetchCalls=${spy.fetchCalls} maxBody=${spy.maxBody} ` +
          `mimeJoined=${spy.mimeJoined} wrapped=${spy.wrapped} utf8Mime=${spy.utf8Mime} ` +
          `providerJson=${spy.providerJson} maxUtf8=${spy.maxUtf8} maxJson=${spy.maxJson}`,
      );
    }
  } finally {
    globalThis.fetch = previous;
    restore();
  }
}

function gmail(fetchImpl: typeof fetch): GmailProvider {
  return new GmailProvider({ accessToken: TOKEN, accountEmail: FROM, fetchImpl });
}

function outlook(fetchImpl: typeof fetch): OutlookProvider {
  return new OutlookProvider({ accessToken: TOKEN, accountEmail: FROM, fetchImpl });
}

async function expectGmailDelivered(
  run: (fetchImpl: typeof fetch) => Promise<unknown>,
  needle: string,
): Promise<void> {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify({ id: "m1", threadId: "t1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await run(fetchImpl);
  } finally {
    globalThis.fetch = previous;
  }
  const sent = calls.find((call) => call.url.includes("/messages/send"));
  assert.ok(sent, "Gmail messages.send was not called");
  const raw = (JSON.parse(sent.body) as { raw?: string }).raw ?? "";
  const pad = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
  const mime = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString(
    "utf8",
  );
  assert.ok(mime.includes(needle), "sent MIME does not contain the attachment payload");
  assert.ok(mime.includes("MIME-Version: 1.0"));
}

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (cause) {
    failures.push(name);
    console.error(`  FAIL ${name}`);
    console.error(`       ${cause instanceof Error ? cause.message : cause}`);
  }
}

const badAttachments: { name: string; attachments: OutboundAttachment[] }[] = [
  {
    name: "six attachments",
    attachments: Array.from({ length: 6 }, (_, index) => file(`f${index}.txt`, oneByte, 1)),
  },
  {
    name: "declared size over 3MB",
    attachments: [file("a.txt", oneByte, MAX_ATTACHMENT_BYTES + 1)],
  },
  {
    name: "negative declared size",
    attachments: [file("a.txt", oneByte, -1)],
  },
  {
    name: "decoded bytes over 3MB while sizeBytes is 4",
    attachments: [file("a.txt", overLimit, 4)],
  },
  {
    name: "non-base64 alphabet",
    attachments: [file("a.txt", "!!!!", 4)],
  },
  {
    name: "whitespace inside base64",
    attachments: [file("a.txt", `${oneByte.slice(0, 2)}\n${oneByte.slice(2)}`, 1)],
  },
  {
    name: "empty filename",
    attachments: [file("", oneByte, 1)],
  },
];

console.log("unbounded attachment send");

for (const bad of badAttachments) {
  await check(`GmailProvider refuses ${bad.name} before encoding`, () =>
    expectRefused((fetchImpl) =>
      gmail(fetchImpl).send(
        {
          to: [{ email: TO }],
          subject: "s",
          bodyHtml: "<p>hi</p>",
          attachments: bad.attachments,
        },
        "k",
      ),
    ),
  );

  await check(`OutlookProvider refuses ${bad.name} before encoding`, () =>
    expectRefused((fetchImpl) =>
      outlook(fetchImpl).send(
        {
          to: [{ email: TO }],
          subject: "s",
          bodyHtml: "<p>hi</p>",
          attachments: bad.attachments,
        },
        "k",
      ),
    ),
  );

  await check(`sendGmailMessage refuses ${bad.name} before encoding`, () =>
    expectRefused(() =>
      sendGmailMessage(TOKEN, {
        to: TO,
        subject: "s",
        body: "hi",
        attachments: bad.attachments,
      }),
    ),
  );

  await check(`sendGraphMessage refuses ${bad.name} before encoding`, () =>
    expectRefused(() =>
      sendGraphMessage(TOKEN, {
        to: TO,
        subject: "s",
        body: "hi",
        attachments: bad.attachments,
      }),
    ),
  );
}

await check("GmailProvider refuses an oversize HTML body before encoding", () =>
  expectRefused((fetchImpl) =>
    gmail(fetchImpl).send(
      { to: [{ email: TO }], subject: "s", bodyHtml: overBody },
      "k",
    ),
  ),
);

await check("OutlookProvider refuses an oversize HTML body before encoding", () =>
  expectRefused((fetchImpl) =>
    outlook(fetchImpl).send(
      { to: [{ email: TO }], subject: "s", bodyHtml: overBody },
      "k",
    ),
  ),
);

await check("GmailProvider reply refuses an oversize body before any thread fetch", () =>
  expectRefused((fetchImpl) =>
    gmail(fetchImpl).reply({ conversationId: "t1", all: false, bodyHtml: overBody }, "k"),
  ),
);

await check("GmailProvider forward refuses an oversize body before any thread fetch", () =>
  expectRefused((fetchImpl) =>
    gmail(fetchImpl).forward(
      { conversationId: "t1", to: [{ email: TO }], bodyHtml: overBody },
      "k",
    ),
  ),
);

await check("OutlookProvider reply refuses an oversize body before any thread fetch", () =>
  expectRefused((fetchImpl) =>
    outlook(fetchImpl).reply({ conversationId: "t1", all: false, bodyHtml: overBody }, "k"),
  ),
);

await check("OutlookProvider forward refuses an oversize body before any thread fetch", () =>
  expectRefused((fetchImpl) =>
    outlook(fetchImpl).forward(
      { conversationId: "t1", to: [{ email: TO }], bodyHtml: overBody },
      "k",
    ),
  ),
);

await check("sendGmailMessage refuses an oversize plain body before encoding", () =>
  expectRefused(() =>
    sendGmailMessage(TOKEN, { to: TO, subject: "s", body: overBody }),
  ),
);

await check("sendGmailMessage refuses an oversize HTML body before encoding", () =>
  expectRefused(() =>
    sendGmailMessage(TOKEN, { to: TO, subject: "s", body: "hi", html: overBody }),
  ),
);

await check("sendGraphMessage refuses an oversize plain body before encoding", () =>
  expectRefused(() => sendGraphMessage(TOKEN, { to: TO, subject: "s", body: overBody })),
);

await check("sendGraphMessage refuses an oversize HTML body before encoding", () =>
  expectRefused(() =>
    sendGraphMessage(TOKEN, { to: TO, subject: "s", body: "hi", html: overBody }),
  ),
);

await check("replyGraphMessage refuses an oversize comment before encoding", () =>
  expectRefused(() => replyGraphMessage(TOKEN, "msg-1", overBody, false)),
);

await check("GmailProvider still sends one attachment of exactly 3MB", () =>
  expectGmailDelivered(
    (fetchImpl) =>
      gmail(fetchImpl).send(
        {
          to: [{ email: TO }],
          subject: "s",
          bodyHtml: "<p>hi</p>",
          attachments: [file("limit.txt", atLimit, MAX_ATTACHMENT_BYTES)],
        },
        "k",
      ),
    "YWFh",
  ),
);

await check("GmailProvider still sends five small attachments", async () => {
  const calls: string[] = [];
  await expectGmailDelivered((fetchImpl) => {
    const wrapped = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(String(input));
      return fetchImpl(input, init);
    }) as typeof fetch;
    return gmail(wrapped).send(
      {
        to: [{ email: TO }],
        subject: "s",
        bodyHtml: "<p>hi</p>",
        attachments: Array.from({ length: 5 }, (_, index) => file(`f${index}.txt`, oneByte, 1)),
      },
      "k",
    );
  }, "filename=\"f4.txt\"");
  assert.equal(calls.length, 1);
});

await check("sendGmailMessage still sends one attachment of exactly 3MB", () =>
  expectGmailDelivered(
    () =>
      sendGmailMessage(TOKEN, {
        to: TO,
        subject: "s",
        body: "hi",
        attachments: [file("limit.txt", atLimit, MAX_ATTACHMENT_BYTES)],
      }),
    "YWFh",
  ),
);

await check("sendGraphMessage still sends five small attachments", async () => {
  const calls: { url: string; body: string }[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response("", { status: 202 });
  }) as typeof fetch;
  try {
    await sendGraphMessage(TOKEN, {
      to: TO,
      subject: "s",
      body: "hi",
      attachments: Array.from({ length: 5 }, (_, index) => file(`f${index}.txt`, oneByte, 1)),
    });
  } finally {
    globalThis.fetch = previous;
  }
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("/me/sendMail"));
  const payload = JSON.parse(calls[0].body) as {
    message?: { attachments?: { name?: string; contentBytes?: string }[] };
  };
  assert.equal(payload.message?.attachments?.length, 5);
  assert.equal(payload.message?.attachments?.[4]?.contentBytes, oneByte);
});

let db: TestDb | undefined;
try {
  db = await startTestDb();
  const userId = await upsertUser("attach-dos@rditrials.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "attach-dos@rditrials.com",
  });

  async function counts(): Promise<{ receipts: number; events: number }> {
    const receipts = await db!.pool.query<{ n: number }>(
      "select count(*)::int as n from seer.command_receipts where account_id = $1",
      [accountId],
    );
    const events = await db!.pool.query<{ n: number }>(
      "select count(*)::int as n from seer.events where account_id = $1",
      [accountId],
    );
    return { receipts: receipts.rows[0].n, events: events.rows[0].n };
  }

  await check("executeCommand still sends five small attachments", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(String(input));
      void init;
      return new Response(JSON.stringify({ id: "m-ok", threadId: "t-ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const result = await executeCommand(
      { accountId, provider: gmail(fetchImpl) },
      {
        type: "send",
        to: [TO],
        subject: "hello",
        bodyHtml: "<p>hi</p>",
        attachments: Array.from({ length: 5 }, (_, index) => file(`f${index}.txt`, oneByte, 1)),
      },
      "key-allowed-send",
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("/messages/send"));
  });

  async function refuseCommand(
    name: string,
    command: Parameters<typeof executeCommand>[1],
  ) {
    await check(`executeCommand refuses ${name} before a receipt or encoding`, async () => {
      const before = await counts();
      await expectRefused((fetchImpl) =>
        executeCommand({ accountId, provider: gmail(fetchImpl) }, command, `key-${name}`),
      );
      const after = await counts();
      assert.deepEqual(
        after,
        before,
        "refusal wrote a command receipt or event before rejecting the payload",
      );
    });
  }

  for (const bad of badAttachments) {
    await refuseCommand(bad.name, {
      type: "send",
      to: [TO],
      subject: "s",
      bodyHtml: "<p>hi</p>",
      attachments: bad.attachments,
    });
  }

  await refuseCommand("oversize send body", {
    type: "send",
    to: [TO],
    subject: "s",
    bodyHtml: overBody,
  });

  await refuseCommand("oversize reply body", {
    type: "reply",
    providerConversationId: "t1",
    all: false,
    bodyHtml: overBody,
  });

  await refuseCommand("oversize forward body", {
    type: "forward",
    providerConversationId: "t1",
    to: [TO],
    bodyHtml: overBody,
  });

  await check("executeCommand still sends one attachment of exactly 3MB", async () => {
    const result = await executeCommand(
      {
        accountId,
        provider: gmail(
          (async () =>
            new Response(JSON.stringify({ id: "m-limit", threadId: "t-limit" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })) as typeof fetch,
        ),
      },
      {
        type: "send",
        to: [TO],
        subject: "s",
        bodyHtml: "<p>hi</p>",
        attachments: [file("limit.txt", atLimit, MAX_ATTACHMENT_BYTES)],
      },
      "key-exact-limit",
    );
    assert.equal(result.ok, true, result.error);
  });
} finally {
  await db?.stop();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall passed");
