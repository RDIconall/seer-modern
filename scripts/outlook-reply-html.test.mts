/**
 * Outlook reply / reply-all places the composer's plain-text body into the
 * Microsoft Graph `comment` field. Graph writes that string verbatim into an
 * HTML body (see the createReply example: the comment is the text between
 * `<body>` and `<b>From:</b>`). These tests fail until that comment is
 * HTML-encoded. The Gmail rich-text part is left as HTML on purpose.
 *
 * Graph template the stand-in copies, character for character around the
 * comment:
 *   microsoft-graph-docs-contrib api-reference/beta/api/message-createreply.md
 *   request comment at the documented example, response body.content
 *   `<html>\r\n<body>` + comment + `\r\n<b>From:</b> ...`
 * The v1.0 reply action this app calls creates that reply message in HTML
 * and takes the same `comment` parameter (api-reference/v1.0/api/message-reply.md).
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { JSDOM } from "jsdom";
import { replyGraphMessage } from "../src/lib/mail/graph.ts";
import { sendGmailMessage } from "../src/lib/mail/gmail.ts";

const dataDir = path.join(tmpdir(), "seer-outlook-reply-html-test");
process.env.SEER_DATA_DIR = dataDir;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;

/** What the sender sees as ordinary text, including a link, an image, and quotes. */
const PLAIN =
  'Please open <a href="https://example.invalid/phish">this</a>\n' +
  'and <img src="https://example.invalid/pixel.png" alt="x">\n' +
  'Tom & Jerry said "go" and \'stop\'';

/**
 * The composer's display markup for that same draft. Angle brackets are
 * escaped, so the editor shows the tags as text. The send payload posts
 * `body` (PLAIN) separately from this `html`.
 */
const DISPLAY_HTML = PLAIN.replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\n/g, "<br>");

type Call = { url: string; method: string; body?: string };

function installFetch(
  respond: (url: string, init: RequestInit | undefined) => Response,
) {
  const calls: Call[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (
      init?.method ??
      (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")
    ).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body });
    return respond(url, init);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = previous;
    },
  };
}

function emptyAccepted() {
  return new Response(null, { status: 202 });
}

/**
 * Graph's documented reply HTML: the comment is concatenated between
 * `<body>` and the quoted-header `<b>From:</b>`, with no encoding step.
 */
function graphReplyHtml(comment: string): string {
  return (
    "<html>\r\n<body>" +
    comment +
    "\r\n<b>From:</b> Sender<br>\r\n<b>Sent:</b> Friday<br>\r\n</body>\r\n</html>"
  );
}

function assertEncodedComment(comment: string, plain: string) {
  assert.equal(
    comment.includes("<") || comment.includes(">"),
    false,
    `comment still contains a raw tag: ${comment}`,
  );
  assert.equal(comment.includes('"'), false, "double quotes must be encoded");
  assert.equal(comment.includes("'"), false, "single quotes must be encoded");
  const withoutEntities = comment.replace(
    /&(?:amp|lt|gt|quot|apos|#39|#x27|#34|#x22);/gi,
    "",
  );
  assert.equal(
    withoutEntities.includes("&"),
    false,
    `ampersand must be encoded: ${comment}`,
  );

  const doc = new JSDOM(graphReplyHtml(comment)).window.document;
  const injected = doc.body.querySelectorAll(
    "a, img, script, iframe, object, embed, link, style",
  );
  assert.equal(
    injected.length,
    0,
    `Graph HTML rendered attacker markup: ${[...injected].map((el) => el.outerHTML).join(" ")}`,
  );
  const from = doc.body.querySelector("b");
  assert.ok(from, "quoted-header marker missing from the Graph template");
  let visible = "";
  for (const node of [...doc.body.childNodes]) {
    if (node === from) break;
    visible += node.textContent ?? "";
  }
  assert.equal(visible.replace(/\r?\n$/, ""), plain);
}

function commentFromCalls(calls: Call[], replyAll: boolean): string {
  const path = replyAll ? "/replyAll" : "/reply";
  const call = calls.find(
    (entry) => entry.method === "POST" && entry.url.includes(path),
  );
  assert.ok(call, `no POST ${path}`);
  const payload = JSON.parse(call.body ?? "{}") as { comment?: string };
  assert.equal(typeof payload.comment, "string");
  return payload.comment as string;
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.stack ?? e.message : e}`);
  }
}

console.log("outlook reply html");

await check("Graph reply encodes plain text before the HTML comment", async () => {
  const fetchMock = installFetch(() => emptyAccepted());
  try {
    await replyGraphMessage("token-placeholder", "msg-1", PLAIN, false);
    assertEncodedComment(commentFromCalls(fetchMock.calls, false), PLAIN);
  } finally {
    fetchMock.restore();
  }
});

await check("Graph reply-all encodes plain text before the HTML comment", async () => {
  const fetchMock = installFetch(() => emptyAccepted());
  try {
    await replyGraphMessage("token-placeholder", "msg-1", PLAIN, true);
    const comment = commentFromCalls(fetchMock.calls, true);
    assert.equal(
      fetchMock.calls.some((call) => call.url.includes("/reply") && !call.url.includes("/replyAll")),
      false,
      "reply-all must not post to the single-recipient reply endpoint",
    );
    assertEncodedComment(comment, PLAIN);
  } finally {
    fetchMock.restore();
  }
});

mock.module("@/lib/mail/session", {
  namedExports: {
    requireMailSession: async () => ({
      accessToken: "token-placeholder",
      provider: "microsoft-entra-id" as const,
      email: "owner@example.com",
      name: "Owner",
      accountId: "account-1",
    }),
  },
});

mock.module("@/lib/store/replied-threads", {
  namedExports: {
    recordRepliedThread: async () => {},
  },
});

const { POST } = await import("../src/app/api/send/route.ts");

function graphMessage() {
  return new Response(
    JSON.stringify({
      id: "msg-1",
      conversationId: "conv-1",
      subject: "Question",
      bodyPreview: "preview",
      body: { contentType: "text", content: "original" },
      receivedDateTime: "2026-08-01T00:00:00Z",
      isRead: true,
      from: { emailAddress: { name: "Sender", address: "sender@example.com" } },
      toRecipients: [
        { emailAddress: { name: "Owner", address: "owner@example.com" } },
      ],
      ccRecipients: [],
      internetMessageId: "<m@example.invalid>",
      hasAttachments: false,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function routeFetch(url: string): Response {
  if (url.includes("/replyAll") || url.endsWith("/reply")) return emptyAccepted();
  if (url.includes("/mailFolders")) {
    return new Response(JSON.stringify({ value: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/messages/")) return graphMessage();
  return emptyAccepted();
}

async function postSend(mode: "reply" | "replyAll") {
  const fetchMock = installFetch((url) => routeFetch(url));
  try {
    mkdirSync(dataDir, { recursive: true });
    const response = await POST(
      new Request("http://localhost/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          to: "sender@example.com",
          subject: "Re: Question",
          body: PLAIN,
          html: `<p>${DISPLAY_HTML}</p><p><strong>approved bold</strong></p>`,
          replyToId: "msg-1",
        }),
      }),
    );
    const json = (await response.json()) as { ok?: boolean; error?: string };
    assert.equal(response.status, 200, json.error ?? "send failed");
    assert.equal(json.ok, true);
    const comment = commentFromCalls(fetchMock.calls, mode === "replyAll");
    assert.equal(
      comment.includes("approved bold") || comment.includes("<strong>"),
      false,
      "the rich-text HTML part must not be sent as the Graph comment",
    );
    assertEncodedComment(comment, PLAIN);
  } finally {
    fetchMock.restore();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await check(
  "send route reply posts the plain body as an encoded Graph comment",
  () => postSend("reply"),
);

await check(
  "send route reply-all posts the plain body as an encoded Graph comment",
  () => postSend("replyAll"),
);

await check("Graph's documented template renders a raw comment as HTML", async () => {
  const doc = new JSDOM(graphReplyHtml(PLAIN)).window.document;
  assert.equal(
    doc.querySelector("a")?.getAttribute("href"),
    "https://example.invalid/phish",
  );
  assert.equal(
    doc.querySelector("img")?.getAttribute("src"),
    "https://example.invalid/pixel.png",
  );
  assert.equal(doc.body.querySelector("b")?.textContent, "From:");
});

await check("Gmail send keeps the rich-text HTML part", async () => {
  const fetchMock = installFetch(
    () =>
      new Response(JSON.stringify({ id: "m1", threadId: "t1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  try {
    await sendGmailMessage("token-placeholder", {
      to: "someone@example.com",
      subject: "Hello",
      body: PLAIN,
      html: '<p><a href="https://example.invalid/ok">ok</a></p>',
    });
    const raw = (JSON.parse(fetchMock.calls.at(-1)?.body ?? "{}") as { raw?: string }).raw;
    assert.ok(raw);
    const mime = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    assert.ok(mime.includes('<p><a href="https://example.invalid/ok">ok</a></p>'));
  } finally {
    fetchMock.restore();
  }
});

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
