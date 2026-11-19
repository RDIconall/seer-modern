/**
 * Opening a graded message must not upload an unbounded body to OpenAI.
 *
 * These tests fail while the vulnerability is present. They pass once:
 * - cleaned text longer than PUBLIC_CLASSIFY_CHAR_CAP (120_000, the same
 *   stop the public classifier route already uses) never calls
 *   api.openai.com chat completions
 * - a single open / classify sends at most MAX_GRAY_SENTENCES gray
 *   sentences, even when the body is under that character cap
 * - the chat-completions fetch aborts within OPENAI_ABORT_MS
 *
 * The deployment key is referenced only by the name OPENAI_API_KEY. The
 * value in this file is an obvious placeholder.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, before, test } from "node:test";
import { classifyMessage, type ClassifyResult } from "../src/lib/inbox/classify.ts";
import { buildActionGuideDetailed } from "../src/lib/inbox/action-guide.ts";
import {
  buildMailHistory,
  type MailHistory,
} from "../src/lib/inbox/mail-history.ts";
import { saveCachedHistory } from "../src/lib/inbox/mail-history-store.ts";
import { hybridClassifyEmailBody } from "../src/lib/nlp/hybrid-classify.ts";
import type { MailMessageListItem } from "../src/lib/mail/types.ts";

const PUBLIC_CLASSIFY_CHAR_CAP = 120_000;
const MAX_GRAY_SENTENCES = 32;
const OPENAI_ABORT_MS = 5_000;
const HANG_MS = 9_000;
const PLACEHOLDER_KEY = "test-openai-key";

const PLAIN = "The parcel rested quietly beside the glass.";
const KEYWORD = "Can you send this.";
const SUBJECT = "Can you review this";
const FROM = "Alex <attacker@gmail.com>";
const FROM_EMAIL = "attacker@gmail.com";

type Session = {
  email: string;
  accessToken: string;
  provider: "google" | "microsoft-entra-id";
  name: string;
  accountId: string;
};

const sessionBox: { current: Session | null } = { current: null };

mock.module("@/lib/mail/session", {
  namedExports: {
    requireMailSession: async () => sessionBox.current,
  },
});

type OpenAiCall = {
  url: string;
  body: string;
  signal: AbortSignal | undefined;
  authorization: string | null;
};

const openaiCalls: OpenAiCall[] = [];
let hangOpenAi = false;
const unexpectedUrls: string[] = [];

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function gmailFull(input: {
  id: string;
  threadId: string;
  subject: string;
  text?: string;
  html?: string;
}): unknown {
  const headers = [
    { name: "From", value: FROM },
    { name: "To", value: "Victim <victim@example.com>" },
    { name: "Subject", value: input.subject },
    { name: "Message-ID", value: "<attack@gmail.com>" },
  ];
  if (input.html != null && !input.text) {
    return {
      id: input.id,
      threadId: input.threadId,
      snippet: input.html.slice(0, 80),
      internalDate: String(Date.now()),
      labelIds: ["INBOX", "UNREAD"],
      payload: {
        mimeType: "text/html",
        headers,
        body: { data: b64url(input.html), size: input.html.length },
      },
    };
  }
  const text = input.text ?? "";
  return {
    id: input.id,
    threadId: input.threadId,
    snippet: text.slice(0, 80),
    internalDate: String(Date.now()),
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/plain",
      headers,
      body: { data: b64url(text), size: text.length },
    },
  };
}

const opened = {
  id: "msg-attack",
  threadId: "thread-attack",
  subject: SUBJECT,
  text: "",
  html: undefined as string | undefined,
};

function graphMessage(): unknown {
  return {
    id: opened.id,
    conversationId: opened.threadId,
    subject: opened.subject,
    bodyPreview: opened.text.slice(0, 80),
    body: { contentType: "text", content: opened.text },
    receivedDateTime: new Date().toISOString(),
    isRead: false,
    from: {
      emailAddress: { name: "Alex", address: FROM_EMAIL },
    },
    toRecipients: [
      { emailAddress: { name: "Victim", address: "victim@example.com" } },
    ],
    internetMessageId: "<attack@outlook.com>",
    hasAttachments: false,
  };
}

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.startsWith("https://api.openai.com/")) {
      const headers = new Headers(init?.headers);
      openaiCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : "",
        signal: init?.signal ?? undefined,
        authorization: headers.get("authorization"),
      });
      if (hangOpenAi) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, HANG_MS);
          const onAbort = () => {
            clearTimeout(timer);
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (init?.signal?.aborted) onAbort();
          else init?.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return json({
        choices: [{ message: { content: '{"items":[]}' } }],
      });
    }

    const token = new Headers(init?.headers).get("authorization") ?? "";
    if (url.includes("gmail.googleapis.com")) {
      if (url.includes("/users/me/labels")) return json({ labels: [] });
      if (url.includes("/threads/") && url.includes("format=minimal")) {
        return json({ messages: [{ id: opened.id }] });
      }
      if (url.includes("/threads/") && url.includes("format=metadata")) {
        return json({ messages: [] });
      }
      if (url.includes("format=full")) return json(gmailFull(opened));
      if (url.includes("/users/me/messages")) return json({ messages: [] });
      unexpectedUrls.push(url);
      return json({});
    }
    if (url.includes("people.googleapis.com")) {
      if (url.includes("otherContacts")) return json({ otherContacts: [] });
      return json({ connections: [] });
    }
    if (url.includes("www.googleapis.com/calendar/")) {
      if (token.includes("act-today")) {
        return json({
          items: [
            {
              id: "evt-1",
              summary: "Notes review",
              status: "confirmed",
              start: { dateTime: new Date(Date.now() + 86_400_000).toISOString() },
              attendees: [
                { email: FROM_EMAIL, responseStatus: "needsAction" },
                { email: "victim@example.com", self: true, responseStatus: "needsAction" },
              ],
            },
          ],
        });
      }
      return json({ items: [] });
    }
    if (url.includes("graph.microsoft.com")) {
      if (url.includes("/me/messages/") && url.includes("$select=")) {
        return json(graphMessage());
      }
      if (url.includes("conversationId")) return json({ value: [{ id: opened.id }] });
      if (url.includes("/contacts")) return json({ value: [] });
      if (url.includes("calendarView")) return json({ value: [] });
      if (url.includes("/mailFolders/")) return json({ value: [] });
      unexpectedUrls.push(url);
      return json({ value: [] });
    }
    unexpectedUrls.push(url);
    return json({});
  }) as typeof fetch;
}

function attackBody(plainCount: number, keywordCount = 8): string {
  const parts: string[] = [];
  for (let i = 0; i < keywordCount; i++) parts.push(KEYWORD);
  for (let i = 0; i < plainCount; i++) parts.push(PLAIN);
  return parts.join(" ");
}

function emptyHistory(accountEmail: string): MailHistory {
  return {
    accountEmail,
    builtAt: new Date().toISOString(),
    contacts: {},
    engagedCount: 0,
    contactCount: 0,
    repliedThreads: {},
  };
}

async function grayCount(body: string): Promise<number> {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await hybridClassifyEmailBody(body);
    return result.sentences.filter((s) => s.score >= 0.32 && s.score <= 0.68)
      .length;
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
}

function uploadedSentences(): string[] {
  const texts: string[] = [];
  for (const call of openaiCalls) {
    const payload = JSON.parse(call.body) as {
      messages?: { role?: string; content?: string }[];
    };
    const content = payload.messages?.find((m) => m.role === "user")?.content;
    assert.equal(typeof content, "string");
    const rows = JSON.parse(content as string) as { text?: string }[];
    for (const row of rows) {
      if (typeof row.text === "string") texts.push(row.text);
    }
  }
  return texts;
}

function assertNoOpenAiUpload(label: string) {
  assert.equal(
    openaiCalls.length,
    0,
    `${label} called chat completions ${openaiCalls.length} time(s) ` +
      `and forwarded ${openaiCalls.reduce((n, c) => n + c.body.length, 0)} request bytes`,
  );
}

let GET: (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;
let classifyPost: (request: Request) => Promise<Response>;

before(async () => {
  process.env.SEER_DATA_DIR = mkdtempSync(path.join(tmpdir(), "seer-openai-cap-"));
  process.env.NODE_ENV = "test";
  delete process.env.POSTGRES_URL;
  delete process.env.POSTGRES_PRISMA_URL;
  delete process.env.DATABASE_URL;
  delete process.env.SEER_V2_DATABASE_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  process.env.OPENAI_API_KEY = PLACEHOLDER_KEY;
  installFetch();
  const route = await import("../src/app/api/messages/[id]/route.ts");
  GET = route.GET;
  const nlp = await import("../src/app/api/nlp/classify/route.ts");
  classifyPost = nlp.POST;
});

async function openMessage(
  session: Session,
  opts?: { hang?: boolean },
): Promise<Response> {
  sessionBox.current = session;
  openaiCalls.length = 0;
  unexpectedUrls.length = 0;
  hangOpenAi = opts?.hang ?? false;
  const response = await GET(new Request("http://localhost/api/messages/msg-attack"), {
    params: Promise.resolve({ id: "msg-attack" }),
  });
  return response;
}

async function expectGradedOpen(
  session: Session,
  action: string,
  opts?: { hang?: boolean },
) {
  const response = await openMessage(session, opts);
  const jsonBody = (await response.json()) as {
    error?: string;
    classification?: { action?: string; debug?: { ruleId?: string } };
  };
  assert.equal(
    response.status,
    200,
    `open failed (${response.status}): ${jsonBody.error ?? "no error"} unexpected=${unexpectedUrls.join(" ")}`,
  );
  assert.equal(
    jsonBody.classification?.action,
    action,
    `graded ${jsonBody.classification?.action} via ${jsonBody.classification?.debug?.ruleId}`,
  );
  return jsonBody;
}

test("a cold Gmail plain-text open does not upload a body over the public cap", async () => {
  const body = attackBody(3_000, 80);
  assert.ok(body.length > PUBLIC_CLASSIFY_CHAR_CAP);
  assert.ok((await grayCount(body)) > MAX_GRAY_SENTENCES);
  opened.text = body;
  opened.html = undefined;
  opened.subject = SUBJECT;
  await expectGradedOpen(
    {
      email: "cold-text@example.com",
      accessToken: "mail-token",
      provider: "google",
      name: "Victim",
      accountId: "acct-cold-text",
    },
    "needs_review",
  );
  assertNoOpenAiUpload("GET /api/messages text/plain");
});

test("a cold Gmail HTML-only open does not upload a body over the public cap", async () => {
  const body = attackBody(3_000, 80);
  opened.text = "";
  opened.html = `<div>${body}</div>`;
  opened.subject = SUBJECT;
  await expectGradedOpen(
    {
      email: "cold-html@example.com",
      accessToken: "mail-token",
      provider: "google",
      name: "Victim",
      accountId: "acct-cold-html",
    },
    "needs_review",
  );
  assertNoOpenAiUpload("GET /api/messages text/html");
});

test("a cold Outlook plain-text open does not upload a body over the public cap", async () => {
  const body = attackBody(3_000, 80);
  opened.text = body;
  opened.html = undefined;
  opened.subject = SUBJECT;
  await expectGradedOpen(
    {
      email: "cold-outlook@example.com",
      accessToken: "mail-token",
      provider: "microsoft-entra-id",
      name: "Victim",
      accountId: "acct-cold-outlook",
    },
    "needs_review",
  );
  assertNoOpenAiUpload("GET /api/messages outlook");
});

test("an engaged Gmail sender graded respond does not upload a body over the public cap", async () => {
  const email = "engaged@example.com";
  const sent: MailMessageListItem = {
    id: "sent-1",
    threadId: "thread-sent",
    fromEmail: email,
    fromName: "Victim",
    peerEmail: FROM_EMAIL,
    subject: "Earlier note",
    snippet: "Hello",
    receivedAt: new Date().toISOString(),
    isUnread: false,
    labelIds: [],
  };
  await saveCachedHistory(buildMailHistory(email, [], [sent], []));
  const body = attackBody(3_000, 80);
  opened.text = body;
  opened.html = undefined;
  opened.subject = SUBJECT;
  await expectGradedOpen(
    {
      email,
      accessToken: "mail-token",
      provider: "google",
      name: "Victim",
      accountId: "acct-engaged",
    },
    "respond",
  );
  assertNoOpenAiUpload("GET /api/messages engaged respond");
});

test("a sender with an upcoming meeting graded act_today does not upload a body over the public cap", async () => {
  const body = attackBody(3_000, 80);
  opened.text = body;
  opened.html = undefined;
  opened.subject = SUBJECT;
  await expectGradedOpen(
    {
      email: "meeting@example.com",
      accessToken: "mail-token-act-today",
      provider: "google",
      name: "Victim",
      accountId: "acct-meeting",
    },
    "act_today",
  );
  assertNoOpenAiUpload("GET /api/messages act_today");
});

test("a graded open under the character cap sends at most the gray-sentence cap", async () => {
  const body = attackBody(200, 8);
  assert.ok(body.length < PUBLIC_CLASSIFY_CHAR_CAP);
  assert.ok((await grayCount(body)) > MAX_GRAY_SENTENCES);
  opened.text = body;
  opened.html = undefined;
  opened.subject = SUBJECT;
  await expectGradedOpen(
    {
      email: "capped@example.com",
      accessToken: "mail-token",
      provider: "google",
      name: "Victim",
      accountId: "acct-capped",
    },
    "needs_review",
  );
  const texts = uploadedSentences();
  assert.ok(texts.length <= MAX_GRAY_SENTENCES, `sent ${texts.length} gray sentences`);
  assert.ok(
    openaiCalls.every((call) => call.body.length <= PUBLIC_CLASSIFY_CHAR_CAP),
    "chat-completions body exceeded the public character cap",
  );
});

test("the public classifier route also caps gray sentences under its length check", async () => {
  const body = attackBody(200, 8);
  assert.ok(body.length < PUBLIC_CLASSIFY_CHAR_CAP);
  assert.ok((await grayCount(body)) > MAX_GRAY_SENTENCES);
  process.env.OPENAI_API_KEY = PLACEHOLDER_KEY;
  openaiCalls.length = 0;
  hangOpenAi = false;
  const response = await classifyPost(
    new Request("http://localhost/api/nlp/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body }),
    }),
  );
  assert.equal(response.status, 200);
  const texts = uploadedSentences();
  assert.ok(texts.length <= MAX_GRAY_SENTENCES, `public route sent ${texts.length} sentences`);
});

test("the public classifier route still refuses text over its length cap without calling OpenAI", async () => {
  const body = attackBody(3_000, 80);
  openaiCalls.length = 0;
  hangOpenAi = false;
  const response = await classifyPost(
    new Request("http://localhost/api/nlp/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body }),
    }),
  );
  assert.equal(response.status, 400);
  assertNoOpenAiUpload("POST /api/nlp/classify over cap");
});

test("buildActionGuideDetailed skips OpenAI for an over-cap body on every ask action", async () => {
  const body = attackBody(3_000, 80);
  const cases: { name: string; result: ClassifyResult }[] = [
    {
      name: "needs_review",
      result: classifyMessage(
        {
          fromEmail: FROM_EMAIL,
          fromName: "Alex",
          subject: SUBJECT,
          snippet: body.slice(0, 2_000),
        },
        null,
        emptyHistory("guide@example.com"),
      ),
    },
    {
      name: "respond",
      result: classifyMessage(
        {
          fromEmail: FROM_EMAIL,
          fromName: "Alex",
          subject: SUBJECT,
          snippet: body.slice(0, 2_000),
        },
        null,
        buildMailHistory(
          "guide@example.com",
          [],
          [
            {
              id: "sent-2",
              threadId: "thread-sent-2",
              fromEmail: "guide@example.com",
              fromName: "Victim",
              peerEmail: FROM_EMAIL,
              subject: "Earlier note",
              snippet: "Hello",
              receivedAt: new Date().toISOString(),
              isUnread: false,
            },
          ],
          [],
        ),
      ),
    },
    {
      name: "act_today",
      result: classifyMessage(
        {
          fromEmail: FROM_EMAIL,
          fromName: "Alex",
          subject: SUBJECT,
          snippet: PLAIN,
        },
        null,
        emptyHistory("guide@example.com"),
        { meeting: "Notes review · tomorrow" },
      ),
    },
  ];
  for (const entry of cases) {
    assert.equal(entry.result.action, entry.name, entry.result.debug.ruleId);
    openaiCalls.length = 0;
    hangOpenAi = false;
    process.env.OPENAI_API_KEY = PLACEHOLDER_KEY;
    await buildActionGuideDetailed(entry.result, SUBJECT, PLAIN, body, "Alex");
    assertNoOpenAiUpload(`buildActionGuideDetailed ${entry.name}`);
  }
});

test("a non-ask grade does not call OpenAI even for an over-cap body", async () => {
  const body = attackBody(3_000, 80);
  const result = classifyMessage(
    {
      fromEmail: "lists@example.com",
      fromName: "Lists",
      subject: "Office hours",
      snippet: "The parcel rested quietly beside the glass.",
    },
    null,
    emptyHistory("guide@example.com"),
  );
  assert.ok(
    result.action !== "respond" &&
      result.action !== "act_today" &&
      result.action !== "needs_review",
  );
  openaiCalls.length = 0;
  await buildActionGuideDetailed(result, "Office hours", PLAIN, body, "Lists");
  assertNoOpenAiUpload("non-ask guide");
});

test("chat completions abort within the short deadline when the server never answers", async () => {
  const sentence = "Can you review the notes from the workshop.";
  const gray = await grayCount(sentence);
  assert.equal(gray, 1);
  process.env.OPENAI_API_KEY = PLACEHOLDER_KEY;
  openaiCalls.length = 0;
  hangOpenAi = true;
  const started = Date.now();
  await hybridClassifyEmailBody(sentence);
  const elapsed = Date.now() - started;
  hangOpenAi = false;
  assert.equal(openaiCalls.length, 1);
  assert.ok(openaiCalls[0].signal, "chat completions was started with no AbortSignal");
  assert.equal(openaiCalls[0].signal?.aborted, true);
  assert.ok(
    elapsed < OPENAI_ABORT_MS + 2_500,
    `classifier waited ${elapsed}ms for OpenAI`,
  );
});

test("opening a small graded message aborts the OpenAI call within the short deadline", async () => {
  opened.text = "Can you review the notes from the workshop.";
  opened.html = undefined;
  opened.subject = SUBJECT;
  const started = Date.now();
  await expectGradedOpen(
    {
      email: "timeout@example.com",
      accessToken: "mail-token",
      provider: "google",
      name: "Victim",
      accountId: "acct-timeout",
    },
    "needs_review",
    { hang: true },
  );
  const elapsed = Date.now() - started;
  hangOpenAi = false;
  assert.equal(openaiCalls.length, 1);
  assert.equal(openaiCalls[0].signal?.aborted, true);
  assert.equal(openaiCalls[0].authorization, `Bearer ${PLACEHOLDER_KEY}`);
  assert.ok(elapsed < OPENAI_ABORT_MS + 2_500, `message open waited ${elapsed}ms`);
});

test("OPENAI_API_KEY unset skips the upload", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    openaiCalls.length = 0;
    hangOpenAi = false;
    await hybridClassifyEmailBody("Can you review the notes from the workshop.");
    assertNoOpenAiUpload("missing OPENAI_API_KEY");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
