/**
 * Gmail sync must keep the message body a mail client would show.
 *
 * A sender can put one text/plain and one text/html part in the outer
 * multipart/alternative, then add a later body: a nested message/rfc822,
 * a second multipart/alternative, or another text part further down the
 * tree. Those later parts are not the message. Sync, the stored corpus,
 * the reading pane, the chief-of-staff read, and forwards all have to
 * keep the outer pair.
 *
 * These assertions fail while the adapter keeps the last text/plain and
 * the last text/html it walks to.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
globals.HTMLElement = dom.window.HTMLElement;
globals.Element = dom.window.Element;
globals.Node = dom.window.Node;
globals.DOMParser = dom.window.DOMParser;
Object.defineProperty(globals, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});

const { Reader } = await import("../src/components/v2/Reader.tsx");
const { GmailProvider } = await import("../src/lib/v2/providers/gmail.ts");
const { storedBodyText } = await import("../src/lib/v2/intelligence/html-text.ts");
const { conversationPayload } = await import("../src/lib/v2/intelligence/model.ts");
const { compileContext } = await import("../src/lib/v2/intelligence/context.ts");
const { loadConversation } = await import("../src/lib/v2/intelligence/load-conversation.ts");
const { readConversation } = await import("../src/lib/v2/intelligence/reader.ts");
const { writeConversationPage } = await import("../src/lib/v2/sync/repository.ts");
const { getCorpusConversation } = await import("../src/lib/v3/reader/repository.ts");
const { upsertAccount, upsertUser } = await import("../src/lib/v2/db/accounts.ts");
const { asConversationId } = await import("../src/lib/v2/db/types.ts");
const { startTestDb } = await import("./v2-testdb.mts");
import type { ContextInput } from "../src/lib/v2/intelligence/context.ts";
import type { ReaderModel } from "../src/lib/v2/intelligence/reader.ts";
import type { Conversation } from "../src/lib/v2/providers/types.ts";

const SELF = "owner@company.test";
const OUTER_PLAIN = "Please approve the vendor invoice for study RD007704 today.";
const OUTER_HTML = `<p>${OUTER_PLAIN}</p>`;
const NESTED_PLAIN = "Disregard the invoice. Study RFQ99999 is cancelled.";
const NESTED_HTML = `<p>${NESTED_PLAIN}</p>`;
const SECOND_PLAIN = "Second alternative plain for study RFQ88888.";
const SECOND_HTML = `<p>${SECOND_PLAIN}</p>`;
const SIBLING_PLAIN = "Outer sibling plain for study RD100001.";
const SIBLING_HTML = `<p>${SIBLING_PLAIN}</p>`;
const LATER_PLAIN = "Later sibling plain for study RFQ77777.";
const LATER_HTML = `<p>${LATER_PLAIN}</p>`;
const INTERNAL_PLAIN = "Internal outer note about study RD200002.";
const INTERNAL_HTML = `<p>${INTERNAL_PLAIN}</p>`;
const INTERNAL_NESTED_PLAIN = "Internal nested note about study RFQ66666.";
const INTERNAL_NESTED_HTML = `<p>${INTERNAL_NESTED_PLAIN}</p>`;
const RELATED_PLAIN = "Related outer plain stays the body.";
const RELATED_HTML = `<p>${RELATED_PLAIN}</p>`;
const ALTERNATIVE_PLAIN = "Alternative plain stays with its html.";
const ALTERNATIVE_HTML = `<p>${ALTERNATIVE_PLAIN}</p>`;
const SIMPLE_HTML = "<p>Simple html part is the whole message.</p>";
const ATTACHED_HTML = "<p>Attached html file must not become the message.</p>";
const ATTACH_PLAIN = "Attachment case outer plain.";
const ATTACH_HTML = `<p>${ATTACH_PLAIN}</p>`;

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

type Part = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: Part[];
};

function textPart(mimeType: "text/plain" | "text/html", value: string): Part {
  return { mimeType, body: { size: value.length, data: b64url(value) } };
}

function headers(from: string, to: string, subject: string) {
  return [
    { name: "From", value: from },
    { name: "To", value: to },
    { name: "Subject", value: subject },
  ];
}

function message(
  id: string,
  from: string,
  to: string,
  subject: string,
  payload: Part,
  snippet: string,
) {
  return {
    id,
    threadId: id,
    snippet,
    labelIds: ["INBOX", "UNREAD"],
    internalDate: "1700000000000",
    payload: { ...payload, headers: headers(from, to, subject) },
  };
}

const THREADS: Record<string, { id: string; messages: ReturnType<typeof message>[] }> = {
  "thread-rfc822": {
    id: "thread-rfc822",
    messages: [
      message(
        "msg-rfc822",
        "Alex Vendor <alex@vendor.example>",
        SELF,
        "Invoice approval",
        {
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [textPart("text/plain", OUTER_PLAIN), textPart("text/html", OUTER_HTML)],
            },
            {
              mimeType: "message/rfc822",
              filename: "forwarded.eml",
              body: { attachmentId: "att-eml", size: 120 },
              parts: [
                {
                  mimeType: "multipart/alternative",
                  parts: [
                    textPart("text/plain", NESTED_PLAIN),
                    textPart("text/html", NESTED_HTML),
                  ],
                },
              ],
            },
          ],
        },
        "Please approve the vendor invoice",
      ),
    ],
  },
  "thread-second-alternative": {
    id: "thread-second-alternative",
    messages: [
      message(
        "msg-second",
        "Alex Vendor <alex@vendor.example>",
        SELF,
        "Second alternative",
        {
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [textPart("text/plain", OUTER_PLAIN), textPart("text/html", OUTER_HTML)],
            },
            {
              mimeType: "multipart/alternative",
              parts: [textPart("text/plain", SECOND_PLAIN), textPart("text/html", SECOND_HTML)],
            },
          ],
        },
        "Please approve the vendor invoice",
      ),
    ],
  },
  "thread-sibling": {
    id: "thread-sibling",
    messages: [
      message(
        "msg-sibling",
        "Alex Vendor <alex@vendor.example>",
        SELF,
        "Later sibling",
        {
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                textPart("text/plain", SIBLING_PLAIN),
                textPart("text/html", SIBLING_HTML),
              ],
            },
            textPart("text/html", LATER_HTML),
            textPart("text/plain", LATER_PLAIN),
          ],
        },
        "Outer sibling plain",
      ),
    ],
  },
  "thread-internal": {
    id: "thread-internal",
    messages: [
      message(
        "msg-internal",
        "Sam Colleague <sam@company.test>",
        SELF,
        "Internal note",
        {
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                textPart("text/plain", INTERNAL_PLAIN),
                textPart("text/html", INTERNAL_HTML),
              ],
            },
            {
              mimeType: "message/rfc822",
              filename: "inner.eml",
              body: { attachmentId: "att-inner", size: 80 },
              parts: [
                {
                  mimeType: "text/html",
                  body: {
                    size: INTERNAL_NESTED_HTML.length,
                    data: b64url(INTERNAL_NESTED_HTML),
                  },
                },
              ],
            },
          ],
        },
        "Internal outer note",
      ),
    ],
  },
  "thread-related": {
    id: "thread-related",
    messages: [
      message(
        "msg-related",
        "Alex Vendor <alex@vendor.example>",
        SELF,
        "With logo",
        {
          mimeType: "multipart/related",
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                textPart("text/plain", RELATED_PLAIN),
                textPart("text/html", RELATED_HTML),
              ],
            },
            {
              mimeType: "image/png",
              filename: "logo.png",
              body: { attachmentId: "att-logo", size: 4 },
            },
          ],
        },
        "Related outer plain",
      ),
    ],
  },
  "thread-alternative": {
    id: "thread-alternative",
    messages: [
      message(
        "msg-alternative",
        "Alex Vendor <alex@vendor.example>",
        SELF,
        "Plain alternative",
        {
          mimeType: "multipart/alternative",
          parts: [
            textPart("text/html", ALTERNATIVE_HTML),
            textPart("text/plain", ALTERNATIVE_PLAIN),
          ],
        },
        "Alternative plain",
      ),
    ],
  },
  "thread-simple": {
    id: "thread-simple",
    messages: [
      message(
        "msg-simple",
        "Alex Vendor <alex@vendor.example>",
        SELF,
        "Simple",
        textPart("text/html", SIMPLE_HTML),
        "Simple html part",
      ),
    ],
  },
  "thread-attachment": {
    id: "thread-attachment",
    messages: [
      message(
        "msg-attachment",
        "Alex Vendor <alex@vendor.example>",
        SELF,
        "Html file",
        {
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [textPart("text/plain", ATTACH_PLAIN), textPart("text/html", ATTACH_HTML)],
            },
            {
              mimeType: "text/html",
              filename: "note.html",
              body: {
                attachmentId: "att-note",
                size: ATTACHED_HTML.length,
                data: b64url(ATTACHED_HTML),
              },
            },
          ],
        },
        "Attachment case outer plain",
      ),
    ],
  },
};

let lastSendRaw = "";

const mockFetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? "GET";
  if (method === "GET" && u.includes("/threads?")) {
    const query = new URL(u).searchParams.get("q") ?? "";
    if (query.includes("in:inbox")) {
      return json({
        threads: Object.keys(THREADS).map((id) => ({ id })),
        resultSizeEstimate: Object.keys(THREADS).length,
      });
    }
    if (query.includes("RD007704")) {
      return json({ threads: [{ id: "thread-rfc822" }], resultSizeEstimate: 1 });
    }
    return json({ threads: [], resultSizeEstimate: 0 });
  }
  const threadGet = u.match(/\/threads\/([^/?]+)\?format=full/);
  if (method === "GET" && threadGet) {
    const thread = THREADS[decodeURIComponent(threadGet[1])];
    if (!thread) return new Response("not found", { status: 404 });
    return json(thread);
  }
  if (method === "POST" && u.endsWith("/messages/send")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { raw?: string; threadId?: string };
    lastSendRaw =
      typeof body.raw === "string"
        ? Buffer.from(body.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
        : "";
    return json({ id: "sent-1", threadId: body.threadId ?? "sent-1" });
  }
  return new Response(`unexpected ${method} ${u}`, { status: 500 });
}) as unknown as typeof fetch;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function provider(): GmailProvider {
  return new GmailProvider({
    accessToken: "placeholder-access-token",
    accountEmail: SELF,
    fetchImpl: mockFetch,
    pageSize: 20,
  });
}

function byId(page: { conversations: Conversation[] }, id: string): Conversation {
  const found = page.conversations.find((conversation) => conversation.providerConversationId === id);
  assert.ok(found, `syncFolder returned ${id}`);
  return found;
}

function assertBody(
  conversation: Conversation,
  plain: string,
  html: string,
  absent: string[],
): void {
  const message = conversation.messages[0];
  assert.ok(message, "conversation has a message");
  assert.equal(message.bodyText, plain);
  assert.equal(message.bodyHtml, html);
  assert.equal(storedBodyText(message), plain);
  const payload = conversationPayload(conversation);
  assert.equal(payload.messages[0]?.body, plain);
  for (const phrase of absent) {
    assert.equal(message.bodyText?.includes(phrase), false, `plain text includes ${phrase}`);
    assert.equal(message.bodyHtml?.includes(phrase), false, `html includes ${phrase}`);
    assert.equal(payload.messages[0]?.body.includes(phrase), false, `classifier body includes ${phrase}`);
  }
}

function renderReader(conversation: Conversation, focusMessageId?: string): string {
  return renderToString(
    createElement(Reader, {
      provider: "google",
      conversation,
      ownEmail: SELF,
      focusMessageId,
      onReply() {},
      onReplyAll() {},
      onForward() {},
      onArchive() {},
      onDelete() {},
    }),
  ).replace(/<!--[\s\S]*?-->/g, "");
}

const failures: string[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const gmail = provider();
const page = await gmail.syncFolder("inbox");
const rfc822 = byId(page, "thread-rfc822");
const second = byId(page, "thread-second-alternative");
const sibling = byId(page, "thread-sibling");
const internal = byId(page, "thread-internal");
const related = byId(page, "thread-related");
const alternative = byId(page, "thread-alternative");
const simple = byId(page, "thread-simple");
const attachment = byId(page, "thread-attachment");

await check("nested message/rfc822 does not replace the outer body", () => {
  assertBody(rfc822, OUTER_PLAIN, OUTER_HTML, ["RFQ99999", "Disregard the invoice"]);
});

await check("a later multipart/alternative does not replace the outer body", () => {
  assertBody(second, OUTER_PLAIN, OUTER_HTML, ["RFQ88888", "Second alternative plain"]);
});

await check("a later mixed sibling does not replace the outer body", () => {
  assertBody(sibling, SIBLING_PLAIN, SIBLING_HTML, ["RFQ77777", "Later sibling plain"]);
});

await check("an internal nested message/rfc822 does not replace the outer body", () => {
  assertBody(internal, INTERNAL_PLAIN, INTERNAL_HTML, ["RFQ66666", "Internal nested note"]);
});

await check("multipart/related keeps the alternative and the inline image", () => {
  assertBody(related, RELATED_PLAIN, RELATED_HTML, []);
  assert.deepEqual(
    related.messages[0]?.attachments.map((item) => item.filename),
    ["logo.png"],
  );
});

await check("one multipart/alternative keeps its html and plain parts", () => {
  assertBody(alternative, ALTERNATIVE_PLAIN, ALTERNATIVE_HTML, []);
});

await check("a single text/html part is the message", () => {
  const message = simple.messages[0];
  assert.equal(message?.bodyHtml, SIMPLE_HTML);
  assert.equal(message?.bodyText, null);
});

await check("a text/html attachment does not become the message", () => {
  assertBody(attachment, ATTACH_PLAIN, ATTACH_HTML, ["Attached html file"]);
  assert.deepEqual(
    attachment.messages[0]?.attachments.map((item) => item.filename),
    ["note.html"],
  );
});

await check("search hydrates the same outer body", async () => {
  const found = await gmail.search("RD007704");
  assertBody(found.conversations[0], OUTER_PLAIN, OUTER_HTML, ["RFQ99999"]);
});

await check("forward quotes the outer html", async () => {
  await gmail.forward(
    {
      conversationId: "thread-rfc822",
      to: [{ email: "colleague@company.test" }],
      bodyHtml: "<p>Passing this along</p>",
    },
    "forward-key",
  );
  assert.match(lastSendRaw, /Passing this along/);
  assert.match(lastSendRaw, /RD007704/);
  assert.doesNotMatch(lastSendRaw, /RFQ99999/);
  assert.doesNotMatch(lastSendRaw, /Disregard the invoice/);
});

await check("reading pane renders the outer html when it has no quote marker", () => {
  const html = renderReader(rfc822);
  assert.match(html, /Please approve the vendor invoice for study RD007704 today/);
  assert.doesNotMatch(html, /RFQ99999/);
  assert.doesNotMatch(html, /Disregard the invoice/);
});

await check("internal branch pane renders the outer html", () => {
  const html = renderReader(internal, "msg-internal");
  assert.match(html, /Internal outer note about study RD200002/);
  assert.doesNotMatch(html, /RFQ66666/);
  assert.doesNotMatch(html, /Internal nested note/);
});

await check("matter match uses the outer body", () => {
  const context: ContextInput = {
    ownDomain: "company.test",
    ownEmail: SELF,
    people: [],
    interests: [],
    matters: [
      {
        id: "matter-outer",
        title: "Outer invoice",
        codes: ["RD007704"],
        counterparty: "vendor",
        userAuthored: false,
      },
      {
        id: "matter-nested",
        title: "Nested cancellation",
        codes: ["RFQ99999"],
        counterparty: "vendor",
        userAuthored: false,
      },
    ],
  };
  const compiled = compileContext(rfc822, context);
  assert.equal(compiled.candidateMatterId, "matter-outer");
});

const db = await startTestDb();
try {
  const userId = await upsertUser(SELF);
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: SELF,
  });
  await writeConversationPage(
    accountId,
    "inbox",
    page.conversations,
    [],
  );

  const stored = await db.pool.query<{
    provider_message_id: string;
    body_html: string | null;
    body_text: string | null;
  }>(
    `select provider_message_id, body_html, body_text
       from seer.messages
      where account_id = $1
      order by provider_message_id`,
    [accountId],
  );
  const storedById = new Map(stored.rows.map((row) => [row.provider_message_id, row]));

  await check("sync stores the outer html and plain text", () => {
    const row = storedById.get("msg-rfc822");
    assert.equal(row?.body_html, OUTER_HTML);
    assert.equal(row?.body_text, OUTER_PLAIN);
  });

  const conversationRow = await db.pool.query<{ id: string }>(
    `select id from seer.conversations
      where account_id = $1 and provider_conversation_id = $2`,
    [accountId, "thread-rfc822"],
  );
  const conversationId = conversationRow.rows[0]?.id;
  assert.ok(conversationId, "stored conversation id");

  const corpus = await getCorpusConversation(accountId, conversationId, "google");
  await check("corpus reader loads the outer body", () => {
    assert.equal(corpus?.conversation.messages[0]?.bodyHtml, OUTER_HTML);
    assert.equal(corpus?.conversation.messages[0]?.bodyText, OUTER_PLAIN);
  });

  await check("reading pane renders the stored outer html", () => {
    assert.ok(corpus);
    const html = renderReader(corpus.conversation);
    assert.match(html, /RD007704/);
    assert.doesNotMatch(html, /RFQ99999/);
  });

  const outerMatter = await db.pool.query<{ id: string }>(
    `insert into seer.matters (account_id, title, org_unit)
     values ($1, $2, $3) returning id`,
    [accountId, "Outer invoice", "vendor"],
  );
  const nestedMatter = await db.pool.query<{ id: string }>(
    `insert into seer.matters (account_id, title, org_unit)
     values ($1, $2, $3) returning id`,
    [accountId, "Nested cancellation", "vendor"],
  );
  await db.pool.query(
    `insert into seer.matter_codes (matter_id, code) values ($1, $2), ($3, $4)`,
    [outerMatter.rows[0].id, "RD007704", nestedMatter.rows[0].id, "RFQ99999"],
  );

  const loaded = await loadConversation(conversationId);
  assert.ok(loaded, "loadConversation returned the thread");
  let classifiedBody = "";
  const model: ReaderModel = async (input) => {
    classifiedBody = input.conversation.messages.map((item) => item.bodyText ?? "").join("\n");
    return {
      home: "matter",
      summary: "Review the invoice",
      rationale: "The message asks for a review",
      owner: "you",
      ask: "Please approve the invoice",
      obligation: true,
      matterRef: "Vendor note",
      yields: [],
      evidence: [],
    };
  };
  const decision = await readConversation({
    accountId,
    conversationId: asConversationId(conversationId),
    conversation: loaded,
    context: {
      ownDomain: "company.test",
      ownEmail: SELF,
      people: [],
      interests: [],
      matters: [
        {
          id: outerMatter.rows[0].id,
          title: "Outer invoice",
          codes: ["RD007704"],
          counterparty: "vendor",
          userAuthored: false,
        },
        {
          id: nestedMatter.rows[0].id,
          title: "Nested cancellation",
          codes: ["RFQ99999"],
          counterparty: "vendor",
          userAuthored: false,
        },
      ],
    },
    model,
  });

  await check("chief-of-staff read classifies the outer text", () => {
    assert.match(classifiedBody, /RD007704/);
    assert.doesNotMatch(classifiedBody, /RFQ99999/);
  });

  await check("filing ties the conversation to the outer study", () => {
    assert.equal(decision.home, "matter");
    assert.equal(decision.matterId, outerMatter.rows[0].id);
  });
} finally {
  await db.stop();
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
