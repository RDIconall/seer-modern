/**
 * Sender-controlled NUL bytes must not freeze a mailbox thread.
 *
 * These tests fail while the vulnerability is present. A message whose HTML
 * contains &#0; / &#x0; / &#0000;, or whose base64 part contains a 0x00 byte,
 * is decoded into U+0000 and written into seer.messages. Postgres rejects that
 * byte, the per-conversation savepoint rolls the thread back, and later syncs
 * repeat the failure. The same rollback happens when decodeEntities throws on
 * an out-of-range code point, and when any other provider string (subject,
 * snippet, addresses, attachment name) contains U+0000.
 *
 * After the fix, every case below stores the conversation, keeps the
 * surrounding text, and leaves no U+0000 in a text column. Run:
 *
 *   npx tsx scripts/v2-nul-mail-sync.test.mts
 */
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import type { AccountId } from "../src/lib/v2/db/types.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { loadConversation } from "../src/lib/v2/intelligence/load-conversation.ts";
import { getCorpusConversation } from "../src/lib/v3/reader/repository.ts";
import { getMailboxView } from "../src/lib/v3/mailbox/repository.ts";

const NUL = "\u0000";
const GMAIL_SELF = "nul-gmail@example.com";
const OUTLOOK_SELF = "nul-outlook@example.com";
const PAGE_SELF = "nul-page@example.com";

const LIVE_ORIGINAL = "2026-11-20T15:00:00.000Z";
const LIVE_POISON = "2026-11-24T15:00:00.000Z";
const LIVE_LATER = "2026-11-26T15:00:00.000Z";

type GmailThread = { id: string; messages: ReturnType<typeof gmailMessage>[] };
type FolderName = "inbox" | "sent" | "trash";

const failures: string[] = [];

async function check(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}\n${message}`);
  }
}

function b64(data: string | Buffer): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function bytesWithNul(before: string, after: string): Buffer {
  return Buffer.concat([
    Buffer.from(before, "utf8"),
    Buffer.from([0x00]),
    Buffer.from(after, "utf8"),
  ]);
}

function gmailMessage(opts: {
  id: string;
  threadId: string;
  iso: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  snippet?: string;
  mimeType: string;
  body?: { size: number; data?: string; attachmentId?: string };
  parts?: unknown[];
  filename?: string;
}) {
  return {
    id: opts.id,
    threadId: opts.threadId,
    snippet: opts.snippet ?? "snippet",
    labelIds: ["INBOX"],
    internalDate: String(Date.parse(opts.iso)),
    payload: {
      mimeType: opts.mimeType,
      filename: opts.filename,
      headers: [
        { name: "From", value: opts.from ?? "Pat Vendor <pat@vendor.example>" },
        { name: "To", value: opts.to ?? GMAIL_SELF },
        { name: "Cc", value: opts.cc ?? "cc@vendor.example" },
        { name: "Subject", value: opts.subject ?? "Subject" },
      ],
      body: opts.body,
      parts: opts.parts,
    },
  };
}

function textPart(data: string | Buffer) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  return { mimeType: "text/plain", body: { size: buf.length, data: b64(buf) } };
}

function htmlPart(data: string | Buffer) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  return { mimeType: "text/html", body: { size: buf.length, data: b64(buf) } };
}

function htmlMessage(
  id: string,
  threadId: string,
  iso: string,
  html: string,
  extra: Partial<Parameters<typeof gmailMessage>[0]> = {},
) {
  const buf = Buffer.from(html, "utf8");
  return gmailMessage({
    id,
    threadId,
    iso,
    mimeType: "text/html",
    body: { size: buf.length, data: b64(buf) },
    ...extra,
  });
}

function textMessage(
  id: string,
  threadId: string,
  iso: string,
  text: string | Buffer,
  extra: Partial<Parameters<typeof gmailMessage>[0]> = {},
) {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8");
  return gmailMessage({
    id,
    threadId,
    iso,
    mimeType: "text/plain",
    body: { size: buf.length, data: b64(buf) },
    ...extra,
  });
}

type StoredMessage = {
  provider_message_id: string;
  from_email: string | null;
  from_name: string | null;
  to_emails: string[] | null;
  cc_emails: string[] | null;
  snippet: string | null;
  body_html: string | null;
  body_text: string | null;
  attachment_names: string[] | null;
};

type StoredThread = {
  id: string;
  subject: string | null;
  message_count: number;
  last_message_at: Date | string | null;
  folders: string[] | null;
  is_deleted: boolean;
  messages: StoredMessage[];
};

async function loadStored(
  pool: Pool,
  accountId: AccountId,
  providerId: string,
): Promise<StoredThread | null> {
  const conv = await pool.query<{
    id: string;
    subject: string | null;
    message_count: number;
    last_message_at: Date | string | null;
    folders: string[] | null;
    is_deleted: boolean;
  }>(
    `select id, subject, message_count, last_message_at, folders, is_deleted
       from seer.conversations
      where account_id = $1 and provider_conversation_id = $2`,
    [accountId, providerId],
  );
  const row = conv.rows[0];
  if (!row) return null;
  const messages = await pool.query<StoredMessage>(
    `select provider_message_id, from_email, from_name, to_emails, cc_emails,
            snippet, body_html, body_text, attachment_names
       from seer.messages
      where conversation_id = $1
      order by sent_at asc nulls last, provider_message_id asc`,
    [row.id],
  );
  return { ...row, messages: messages.rows };
}

function assertClean(value: string | null | undefined, parts: string[], label: string): void {
  assert.ok(value != null && value.length > 0, `${label} was not stored`);
  assert.equal(value!.includes(NUL), false, `${label} still contains U+0000: ${JSON.stringify(value)}`);
  for (const part of parts) {
    assert.ok(
      value!.includes(part),
      `${label} lost ${JSON.stringify(part)}: ${JSON.stringify(value)}`,
    );
  }
}

function assertCleanList(values: string[] | null | undefined, parts: string[], label: string): void {
  assert.ok(values && values.length > 0, `${label} was not stored`);
  const joined = values!.join("\n");
  assert.equal(joined.includes(NUL), false, `${label} still contains U+0000: ${JSON.stringify(values)}`);
  for (const part of parts) {
    assert.ok(joined.includes(part), `${label} lost ${JSON.stringify(part)}: ${JSON.stringify(values)}`);
  }
}

function assertInstant(actual: Date | string | null, iso: string, label: string): void {
  assert.ok(actual, `${label} missing`);
  const ms = actual instanceof Date ? actual.getTime() : Date.parse(String(actual));
  assert.equal(ms, Date.parse(iso), label);
}

function gmailFetch(state: Record<FolderName, GmailThread[]>): typeof fetch {
  return async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) {
      const q = u.searchParams.get("q") ?? "";
      const folder: FolderName | null = q.includes("in:sent")
        ? "sent"
        : q.includes("in:trash")
          ? "trash"
          : q.includes("in:inbox")
            ? "inbox"
            : null;
      if (!folder) return new Response("unexpected folder query", { status: 404 });
      const threads = state[folder];
      const start = Number(u.searchParams.get("pageToken") ?? "0");
      const size = Number(u.searchParams.get("maxResults") ?? "100");
      const slice = threads.slice(start, start + size);
      const next = start + size < threads.length ? String(start + size) : undefined;
      return Response.json({
        threads: slice.map((thread) => ({ id: thread.id })),
        nextPageToken: next,
        resultSizeEstimate: threads.length,
      });
    }
    const match = u.pathname.match(/\/threads\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const thread = [...state.inbox, ...state.sent, ...state.trash].find((item) => item.id === id);
      if (!thread) return new Response("missing thread", { status: 404 });
      return Response.json(thread);
    }
    return new Response(`unexpected ${u.pathname}`, { status: 404 });
  };
}

type GraphMessage = {
  id: string;
  conversationId: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: { emailAddress?: { address?: string; name?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string; name?: string } }[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  isRead?: boolean;
  attachments?: { id?: string; name?: string; contentType?: string; size?: number }[];
};

function outlookFetch(conversations: Map<string, GraphMessage[]>): typeof fetch {
  return async (url) => {
    const u = new URL(String(url));
    if (u.pathname.includes("/mailFolders/") && u.pathname.endsWith("/messages")) {
      const ids = [...conversations.keys()];
      const skip = Number(u.searchParams.get("$skiptoken") ?? "0");
      const top = Number(u.searchParams.get("$top") ?? "50");
      const slice = ids.slice(skip, skip + top);
      const next =
        skip + top < ids.length
          ? `${u.origin}${u.pathname}?$top=${top}&$skiptoken=${skip + top}`
          : undefined;
      return Response.json({
        "@odata.count": ids.length,
        "@odata.nextLink": next,
        value: slice.map((id) => {
          const latest = conversations.get(id)!.at(-1)!;
          return {
            id: latest.id,
            conversationId: id,
            subject: latest.subject,
            receivedDateTime: latest.receivedDateTime,
          };
        }),
      });
    }
    if (u.pathname.endsWith("/messages") && u.searchParams.has("$filter")) {
      const filter = u.searchParams.get("$filter") ?? "";
      const id = filter.match(/conversationId eq '([^']*)'/)?.[1];
      const messages = id ? conversations.get(id) : undefined;
      if (!messages) return new Response("missing conversation", { status: 404 });
      return Response.json({ value: messages });
    }
    if (u.pathname.includes("/mailFolders/")) {
      return Response.json({ totalItemCount: conversations.size });
    }
    return new Response(`unexpected ${u.pathname}`, { status: 404 });
  };
}

const db = await startTestDb();
try {
  const gmailUser = await upsertUser(GMAIL_SELF);
  const gmailAccount = await upsertAccount({
    userId: gmailUser,
    provider: "google",
    email: GMAIL_SELF,
  });
  const gmailState: Record<FolderName, GmailThread[]> = {
    inbox: [],
    sent: [],
    trash: [],
  };
  const gmail = new GmailProvider({
    accessToken: "placeholder-access-token",
    accountEmail: GMAIL_SELF,
    fetchImpl: gmailFetch(gmailState),
    pageSize: 50,
  });

  gmailState.inbox = [
    {
      id: "live",
      messages: [
        htmlMessage("live-1", "live", LIVE_ORIGINAL, "<p>Original note</p>", {
          subject: "Live thread",
          snippet: "Original note",
        }),
      ],
    },
    {
      id: "edited",
      messages: [
        textMessage("edited-1", "edited", LIVE_ORIGINAL, "first draft", {
          subject: "Edited draft",
          snippet: "first draft",
        }),
      ],
    },
  ];

  const seeded = await syncFolder(gmailAccount, gmail, "inbox", "full");
  await check("clean seed sync stores the thread before the poison reply", async () => {
    assert.equal(seeded.coverage.failed, 0);
    const live = await loadStored(db.pool, gmailAccount, "live");
    assert.ok(live, "seed thread missing");
    assert.equal(live!.message_count, 1);
    assert.equal(live!.messages.length, 1);
    assert.equal(live!.messages[0].body_text, "Original note");
  });

  const poisonHtml =
    "<p>Please reply &#0; &#x0; &#x00; &#0000; today</p>";
  gmailState.inbox = [
    {
      id: "healthy",
      messages: [
        textMessage("healthy-1", "healthy", LIVE_LATER, "ordinary sibling", {
          subject: "Healthy thread",
          snippet: "ordinary sibling",
        }),
      ],
    },
    {
      id: "live",
      messages: [
        htmlMessage("live-1", "live", LIVE_ORIGINAL, "<p>Original note</p>", {
          subject: "Live thread",
          snippet: "Original note",
        }),
        htmlMessage("live-2", "live", LIVE_POISON, poisonHtml, {
          subject: "Live thread",
          snippet: "Please reply today",
          from: "Counterparty <counterparty@vendor.example>",
        }),
        htmlMessage("live-3", "live", LIVE_LATER, "<p>Finance follow-up</p>", {
          subject: "Live thread",
          snippet: "Finance follow-up",
        }),
      ],
    },
    {
      id: "edited",
      messages: [
        textMessage(
          "edited-1",
          "edited",
          LIVE_ORIGINAL,
          bytesWithNul("revised ", "draft"),
          { subject: "Edited draft", snippet: "revised draft" },
        ),
        textMessage("edited-2", "edited", LIVE_LATER, "added later", {
          subject: "Edited draft",
          snippet: "added later",
        }),
      ],
    },
    {
      id: "brand-new",
      messages: [
        htmlMessage("brand-1", "brand-new", LIVE_POISON, poisonHtml, {
          subject: "Brand new thread",
          snippet: "Please reply today",
        }),
      ],
    },
    {
      id: "html-nul",
      messages: [
        gmailMessage({
          id: "html-nul-1",
          threadId: "html-nul",
          iso: LIVE_POISON,
          subject: "HTML bytes",
          snippet: "plain ok",
          mimeType: "multipart/alternative",
          parts: [
            textPart("plain ok"),
            htmlPart(bytesWithNul("<p>hello ", " world</p>")),
          ],
        }),
        textMessage("html-nul-2", "html-nul", LIVE_LATER, "html sibling", {
          subject: "HTML bytes",
          snippet: "html sibling",
        }),
      ],
    },
    {
      id: "text-nul",
      messages: [
        textMessage(
          "text-nul-1",
          "text-nul",
          LIVE_POISON,
          bytesWithNul("see ", "this"),
          { subject: "Plain bytes", snippet: "see this" },
        ),
      ],
    },
    {
      id: "subject-nul",
      messages: [
        textMessage("subject-1", "subject-nul", LIVE_POISON, "subject body", {
          subject: `Quarterly${NUL} review`,
          snippet: "subject body",
        }),
        textMessage("subject-2", "subject-nul", LIVE_LATER, "subject sibling", {
          subject: `Quarterly${NUL} review`,
          snippet: "subject sibling",
        }),
      ],
    },
    {
      id: "snippet-nul",
      messages: [
        textMessage("snippet-1", "snippet-nul", LIVE_POISON, "snippet body", {
          subject: "Snippet thread",
          snippet: `preview${NUL}tail`,
        }),
      ],
    },
    {
      id: "from-name-nul",
      messages: [
        textMessage("from-name-1", "from-name-nul", LIVE_POISON, "name body", {
          subject: "From name",
          from: `Bad${NUL} Name <bad@vendor.example>`,
          snippet: "name body",
        }),
      ],
    },
    {
      id: "from-email-nul",
      messages: [
        textMessage("from-email-1", "from-email-nul", LIVE_POISON, "address body", {
          subject: "From address",
          from: `bad${NUL}actor@vendor.example`,
          snippet: "address body",
        }),
      ],
    },
    {
      id: "to-nul",
      messages: [
        textMessage("to-1", "to-nul", LIVE_POISON, "to body", {
          subject: "To address",
          to: `pat${NUL}ient@vendor.example`,
          snippet: "to body",
        }),
      ],
    },
    {
      id: "cc-nul",
      messages: [
        textMessage("cc-1", "cc-nul", LIVE_POISON, "cc body", {
          subject: "Cc address",
          cc: `copy${NUL}@vendor.example`,
          snippet: "cc body",
        }),
      ],
    },
    {
      id: "attachment-nul",
      messages: [
        gmailMessage({
          id: "attachment-1",
          threadId: "attachment-nul",
          iso: LIVE_POISON,
          subject: "Attachment thread",
          snippet: "file note",
          mimeType: "multipart/mixed",
          parts: [
            textPart("file note"),
            {
              filename: `contract${NUL}.pdf`,
              mimeType: "application/pdf",
              body: { attachmentId: "att-1", size: 4 },
            },
          ],
        }),
      ],
    },
    {
      id: "oor",
      messages: [
        htmlMessage(
          "oor-1",
          "oor",
          LIVE_POISON,
          "<p>Before &#1114112; &#x110000; after</p>",
          { subject: "Out of range", snippet: "Before after" },
        ),
        textMessage("oor-2", "oor", LIVE_LATER, "Still here", {
          subject: "Out of range",
          snippet: "Still here",
        }),
      ],
    },
  ];

  const poisoned = await syncFolder(gmailAccount, gmail, "inbox", "incremental", {
    maxPages: 1,
    deadlineMs: Date.now() + 240_000,
  });

  await check("poison sync reports no conversation failures", async () => {
    assert.equal(
      poisoned.coverage.failed,
      0,
      `sync counted ${poisoned.coverage.failed} conversation failures and advanced anyway`,
    );
  });

  await check("html NUL entities do not freeze an existing thread", async () => {
    const live = await loadStored(db.pool, gmailAccount, "live");
    assert.ok(live, "live thread missing");
    assert.equal(live!.is_deleted, false);
    assert.ok(live!.folders?.includes("inbox"));
    assert.equal(
      live!.message_count,
      3,
      `thread stayed at message_count ${live!.message_count}`,
    );
    assertInstant(live!.last_message_at, LIVE_LATER, "last_message_at");
    assert.equal(live!.messages.length, 3);
    assert.equal(live!.messages[0].body_text, "Original note");
    assertClean(live!.messages[1].body_text, ["Please reply", "today"], "poison body_text");
    assertClean(live!.messages[1].body_html, ["Please reply", "today"], "poison body_html");
    assert.equal(live!.messages[1].body_text!.includes(NUL), false);
    assertClean(live!.messages[2].body_text, ["Finance follow-up"], "later reply");
  });

  await check("mailbox list shows the reply that arrived after the poison message", async () => {
    const view = await getMailboxView(gmailAccount, "inbox", 50);
    const row = view.rows.find((item) => item.providerConversationId === "live");
    assert.ok(row, "live thread missing from the mailbox list");
    assert.equal(row!.snippet, "Finance follow-up");
    assert.equal(Date.parse(row!.timestamp), Date.parse(LIVE_LATER));
    assert.equal(row!.latestMessageId, "live-3");
  });

  await check("chief-of-staff reader and corpus reader return the poisoned reply", async () => {
    const live = await loadStored(db.pool, gmailAccount, "live");
    assert.ok(live, "live thread missing");
    const staff = await loadConversation(live!.id);
    assert.ok(staff, "loadConversation returned null");
    assert.equal(staff!.messages.length, 3);
    const staffPoison = staff!.messages.find((message) => message.providerMessageId === "live-2");
    assert.ok(staffPoison, "reader is missing the poison reply");
    assertClean(staffPoison!.bodyText, ["Please reply", "today"], "reader body");
    const corpus = await getCorpusConversation(gmailAccount, live!.id, "google");
    assert.ok(corpus, "corpus reader returned null");
    const corpusPoison = corpus!.conversation.messages.find(
      (message) => message.providerMessageId === "live-2",
    );
    assert.ok(corpusPoison, "corpus reader is missing the poison reply");
    assertClean(corpusPoison!.bodyText, ["Please reply", "today"], "corpus body");
    assert.equal(corpusPoison!.bodyText!.includes(NUL), false);
    assert.equal(corpusPoison!.bodyHtml!.includes(NUL), false);
  });

  await check("a repeated sync of the same poison thread stays updated", async () => {
    const again = await syncFolder(gmailAccount, gmail, "inbox", "incremental", {
      maxPages: 1,
      headOnly: true,
      deadlineMs: Date.now() + 240_000,
    });
    assert.equal(again.coverage.failed, 0);
    const live = await loadStored(db.pool, gmailAccount, "live");
    assert.equal(live?.message_count, 3);
    assert.equal(live?.messages.length, 3);
    assertClean(live?.messages[1].body_text, ["Please reply", "today"], "resync body");
  });

  await check("a healthy conversation on the same page is still stored", async () => {
    const healthy = await loadStored(db.pool, gmailAccount, "healthy");
    assert.ok(healthy, "healthy thread was rolled back with the poisoned page");
    assert.equal(healthy!.messages[0].body_text, "ordinary sibling");
  });

  await check("a brand-new thread whose only body contains NUL entities appears", async () => {
    const thread = await loadStored(db.pool, gmailAccount, "brand-new");
    assert.ok(thread, "new thread never appeared");
    assert.equal(thread!.message_count, 1);
    assertClean(thread!.messages[0].body_text, ["Please reply", "today"], "new thread body");
  });

  await check("updating an already stored body with a raw NUL keeps the new sibling", async () => {
    const thread = await loadStored(db.pool, gmailAccount, "edited");
    assert.ok(thread, "edited thread missing");
    assert.equal(thread!.message_count, 2);
    assertClean(thread!.messages[0].body_text, ["revised", "draft"], "updated body");
    assertClean(thread!.messages[1].body_text, ["added later"], "sibling of updated body");
  });

  await check("a raw NUL in HTML is stored even when the text part is clean", async () => {
    const thread = await loadStored(db.pool, gmailAccount, "html-nul");
    assert.ok(thread, "html-nul thread missing");
    assert.equal(thread!.messages.length, 2);
    assertClean(thread!.messages[0].body_text, ["plain ok"], "text part");
    assertClean(thread!.messages[0].body_html, ["hello", "world"], "html part");
    assertClean(thread!.messages[1].body_text, ["html sibling"], "html sibling");
  });

  await check("a raw NUL in a base64 text part is stored", async () => {
    const thread = await loadStored(db.pool, gmailAccount, "text-nul");
    assert.ok(thread, "text-nul thread missing");
    assertClean(thread!.messages[0].body_text, ["see", "this"], "text part");
  });

  await check("a NUL in the subject does not discard the thread", async () => {
    const thread = await loadStored(db.pool, gmailAccount, "subject-nul");
    assert.ok(thread, "subject thread missing");
    assertClean(thread!.subject, ["Quarterly", "review"], "subject");
    assert.equal(thread!.messages.length, 2);
    assertClean(thread!.messages[1].body_text, ["subject sibling"], "subject sibling");
  });

  await check("a NUL in the snippet does not discard the message", async () => {
    const thread = await loadStored(db.pool, gmailAccount, "snippet-nul");
    assert.ok(thread, "snippet thread missing");
    assertClean(thread!.messages[0].snippet, ["preview", "tail"], "snippet");
  });

  await check("a NUL in the from name does not discard the message", async () => {
    const thread = await loadStored(db.pool, gmailAccount, "from-name-nul");
    assert.ok(thread, "from-name thread missing");
    assertClean(thread!.messages[0].from_name, ["Bad", "Name"], "from name");
    assert.equal(thread!.messages[0].from_email, "bad@vendor.example");
  });

  await check("a NUL in the from address does not discard the message", async () => {
    const thread = await loadStored(db.pool, gmailAccount, "from-email-nul");
    assert.ok(thread, "from-email thread missing");
    assertClean(thread!.messages[0].from_email, ["bad", "actor@vendor.example"], "from email");
  });

  await check("a NUL in a To address does not discard the message", async () => {
    const thread = await loadStored(db.pool, gmailAccount, "to-nul");
    assert.ok(thread, "to thread missing");
    assertCleanList(thread!.messages[0].to_emails, ["pat", "ient@vendor.example"], "to");
  });

  await check("a NUL in a Cc address does not discard the message", async () => {
    const thread = await loadStored(db.pool, gmailAccount, "cc-nul");
    assert.ok(thread, "cc thread missing");
    assertCleanList(thread!.messages[0].cc_emails, ["copy", "@vendor.example"], "cc");
  });

  await check("a NUL in an attachment filename does not discard the message", async () => {
    const thread = await loadStored(db.pool, gmailAccount, "attachment-nul");
    assert.ok(thread, "attachment thread missing");
    assertCleanList(thread!.messages[0].attachment_names, ["contract", ".pdf"], "attachment");
    assertClean(thread!.messages[0].body_text, ["file note"], "attachment body");
  });

  await check("an out-of-range HTML code point does not discard the thread", async () => {
    const thread = await loadStored(db.pool, gmailAccount, "oor");
    assert.ok(thread, "out-of-range thread missing");
    assert.equal(thread!.messages.length, 2);
    assertClean(thread!.messages[0].body_text, ["Before", "after"], "out-of-range body");
    assertClean(thread!.messages[1].body_text, ["Still here"], "out-of-range sibling");
  });

  gmailState.sent = [
    {
      id: "sent-poison",
      messages: [
        htmlMessage("sent-1", "sent-poison", LIVE_POISON, poisonHtml, {
          subject: "Sent poison",
          snippet: "Please reply today",
          from: `Me <${GMAIL_SELF}>`,
        }),
      ],
    },
  ];
  const sentRun = await syncFolder(gmailAccount, gmail, "sent", "full");
  await check("sent-folder sync stores an HTML-only NUL entity message", async () => {
    assert.equal(sentRun.coverage.failed, 0);
    const thread = await loadStored(db.pool, gmailAccount, "sent-poison");
    assert.ok(thread, "sent thread missing");
    assert.ok(thread!.folders?.includes("sent"));
    assertClean(thread!.messages[0].body_text, ["Please reply", "today"], "sent body");
  });

  gmailState.trash = [
    {
      id: "trash-poison",
      messages: [
        textMessage(
          "trash-1",
          "trash-poison",
          LIVE_POISON,
          bytesWithNul("trashed ", "note"),
          { subject: "Trash poison", snippet: "trashed note" },
        ),
      ],
    },
  ];
  const trashRun = await syncFolder(gmailAccount, gmail, "trash", "full");
  await check("trash-folder sync stores a raw NUL text part", async () => {
    assert.equal(trashRun.coverage.failed, 0);
    const thread = await loadStored(db.pool, gmailAccount, "trash-poison");
    assert.ok(thread, "trash thread missing");
    assert.ok(thread!.folders?.includes("trash"));
    assertClean(thread!.messages[0].body_text, ["trashed", "note"], "trash body");
  });

  const pageUser = await upsertUser(PAGE_SELF);
  const pageAccount = await upsertAccount({
    userId: pageUser,
    provider: "google",
    email: PAGE_SELF,
  });
  const pageState: Record<FolderName, GmailThread[]> = {
    inbox: [
      {
        id: "page-poison",
        messages: [
          htmlMessage("page-poison-1", "page-poison", LIVE_POISON, poisonHtml, {
            subject: "Page one",
            snippet: "Please reply today",
            to: PAGE_SELF,
          }),
        ],
      },
      {
        id: "page-clean",
        messages: [
          textMessage("page-clean-1", "page-clean", LIVE_LATER, "second page", {
            subject: "Page two",
            snippet: "second page",
            to: PAGE_SELF,
          }),
        ],
      },
    ],
    sent: [],
    trash: [],
  };
  const pageGmail = new GmailProvider({
    accessToken: "placeholder-access-token",
    accountEmail: PAGE_SELF,
    fetchImpl: gmailFetch(pageState),
    pageSize: 1,
  });
  const paged = await syncFolder(pageAccount, pageGmail, "inbox", "full", { pageSize: 1 });
  await check("a failed conversation does not stop the cursor before the next page", async () => {
    assert.equal(paged.pages, 2);
    assert.equal(paged.backfillComplete, true);
    assert.equal(paged.nextCursor, null);
    assert.equal(paged.coverage.failed, 0, `cursor advanced with ${paged.coverage.failed} failures`);
    const poison = await loadStored(db.pool, pageAccount, "page-poison");
    const clean = await loadStored(db.pool, pageAccount, "page-clean");
    assert.ok(clean, "second page was not stored");
    assert.equal(clean!.messages[0].body_text, "second page");
    assert.ok(poison, "first page thread was skipped when the cursor advanced");
    assertClean(poison!.messages[0].body_text, ["Please reply", "today"], "paged poison body");
  });

  const outlookUser = await upsertUser(OUTLOOK_SELF);
  const outlookAccount = await upsertAccount({
    userId: outlookUser,
    provider: "microsoft",
    email: OUTLOOK_SELF,
  });
  const outlookLive: GraphMessage[] = [
    {
      id: "ol-live-1",
      conversationId: "ol-live",
      subject: "Outlook live",
      from: { emailAddress: { address: "pat@vendor.example", name: "Pat" } },
      toRecipients: [{ emailAddress: { address: OUTLOOK_SELF } }],
      ccRecipients: [],
      receivedDateTime: LIVE_ORIGINAL,
      bodyPreview: "Original outlook",
      body: { contentType: "html", content: "<p>Original outlook</p>" },
      isRead: false,
    },
    {
      id: "ol-live-2",
      conversationId: "ol-live",
      subject: "Outlook live",
      from: { emailAddress: { address: "counterparty@vendor.example", name: "Counterparty" } },
      toRecipients: [{ emailAddress: { address: OUTLOOK_SELF } }],
      ccRecipients: [{ emailAddress: { address: "cc@vendor.example" } }],
      receivedDateTime: LIVE_POISON,
      bodyPreview: "Please reply today",
      body: { contentType: "html", content: poisonHtml },
      isRead: false,
    },
    {
      id: "ol-live-3",
      conversationId: "ol-live",
      subject: "Outlook live",
      from: { emailAddress: { address: "finance@vendor.example", name: "Finance" } },
      toRecipients: [{ emailAddress: { address: OUTLOOK_SELF } }],
      receivedDateTime: LIVE_LATER,
      bodyPreview: "Outlook follow-up",
      body: { contentType: "text", content: "Outlook follow-up" },
      isRead: true,
    },
  ];
  const outlookThreads = new Map<string, GraphMessage[]>([
    ["ol-live", [outlookLive[0]]],
    [
      "ol-plain",
      [
        {
          id: "ol-plain-1",
          conversationId: "ol-plain",
          subject: "Outlook plain",
          from: { emailAddress: { address: "pat@vendor.example", name: "Pat" } },
          toRecipients: [{ emailAddress: { address: OUTLOOK_SELF } }],
          receivedDateTime: LIVE_POISON,
          bodyPreview: "see this",
          body: { contentType: "text", content: `see ${NUL}this` },
          isRead: false,
        },
      ],
    ],
    [
      "ol-html",
      [
        {
          id: "ol-html-1",
          conversationId: "ol-html",
          subject: "Outlook html bytes",
          from: { emailAddress: { address: "pat@vendor.example", name: "Pat" } },
          toRecipients: [{ emailAddress: { address: OUTLOOK_SELF } }],
          receivedDateTime: LIVE_POISON,
          bodyPreview: "hello world",
          body: { contentType: "html", content: `<p>hello ${NUL} world</p>` },
          isRead: false,
        },
      ],
    ],
    [
      "ol-subject",
      [
        {
          id: "ol-subject-1",
          conversationId: "ol-subject",
          subject: `Outlook${NUL} subject`,
          from: { emailAddress: { address: "pat@vendor.example", name: `Pat${NUL} Vendor` } },
          toRecipients: [{ emailAddress: { address: `to${NUL}@vendor.example` } }],
          ccRecipients: [{ emailAddress: { address: `cc${NUL}@vendor.example` } }],
          receivedDateTime: LIVE_POISON,
          bodyPreview: `outlook${NUL}preview`,
          body: { contentType: "text", content: "outlook body" },
          isRead: false,
          attachments: [
            { id: "ol-att", name: `brief${NUL}.docx`, contentType: "application/octet-stream", size: 8 },
          ],
        },
      ],
    ],
  ]);
  const outlook = new OutlookProvider({
    accessToken: "placeholder-access-token",
    accountEmail: OUTLOOK_SELF,
    fetchImpl: outlookFetch(outlookThreads),
  });
  const outlookLater = ["ol-plain", "ol-html", "ol-subject"] as const;
  const outlookLaterThreads = outlookLater.map(
    (id) => [id, outlookThreads.get(id)!] as const,
  );
  for (const id of outlookLater) outlookThreads.delete(id);
  const outlookSeed = await syncFolder(outlookAccount, outlook, "inbox", "full");
  await check("outlook seed stores the clean message", async () => {
    assert.equal(outlookSeed.coverage.failed, 0);
    const thread = await loadStored(db.pool, outlookAccount, "ol-live");
    assert.equal(thread?.message_count, 1);
    assert.equal(thread?.messages[0].body_text, "Original outlook");
  });
  outlookThreads.set("ol-live", outlookLive);
  for (const [id, messages] of outlookLaterThreads) outlookThreads.set(id, messages);
  const outlookPoison = await syncFolder(outlookAccount, outlook, "inbox", "incremental", {
    maxPages: 1,
    deadlineMs: Date.now() + 240_000,
  });

  await check("outlook HTML NUL entities do not freeze the thread", async () => {
    assert.equal(outlookPoison.coverage.failed, 0);
    const thread = await loadStored(db.pool, outlookAccount, "ol-live");
    assert.ok(thread, "outlook live thread missing");
    assert.equal(thread!.message_count, 3, `outlook thread stayed at ${thread!.message_count}`);
    assertInstant(thread!.last_message_at, LIVE_LATER, "outlook last_message_at");
    assert.equal(thread!.messages[0].body_text, "Original outlook");
    assertClean(thread!.messages[1].body_text, ["Please reply", "today"], "outlook poison body");
    assertClean(thread!.messages[2].body_text, ["Outlook follow-up"], "outlook later reply");
    const view = await getMailboxView(outlookAccount, "inbox", 50);
    const row = view.rows.find((item) => item.providerConversationId === "ol-live");
    assert.ok(row, "outlook thread missing from the mailbox list");
    assert.equal(row!.snippet, "Outlook follow-up");
    assert.equal(row!.latestMessageId, "ol-live-3");
  });

  await check("outlook plain text with U+0000 is stored", async () => {
    const thread = await loadStored(db.pool, outlookAccount, "ol-plain");
    assert.ok(thread, "outlook plain thread missing");
    assertClean(thread!.messages[0].body_text, ["see", "this"], "outlook plain body");
  });

  await check("outlook HTML with a raw U+0000 is stored", async () => {
    const thread = await loadStored(db.pool, outlookAccount, "ol-html");
    assert.ok(thread, "outlook html thread missing");
    assertClean(thread!.messages[0].body_html, ["hello", "world"], "outlook html");
    assertClean(thread!.messages[0].body_text, ["hello", "world"], "outlook html text");
  });

  await check("outlook subject, preview, addresses, and attachment names lose U+0000", async () => {
    const thread = await loadStored(db.pool, outlookAccount, "ol-subject");
    assert.ok(thread, "outlook subject thread missing");
    assertClean(thread!.subject, ["Outlook", "subject"], "outlook subject");
    assertClean(thread!.messages[0].from_name, ["Pat", "Vendor"], "outlook from name");
    assertCleanList(thread!.messages[0].to_emails, ["to", "@vendor.example"], "outlook to");
    assertCleanList(thread!.messages[0].cc_emails, ["cc", "@vendor.example"], "outlook cc");
    assertClean(thread!.messages[0].snippet, ["outlook", "preview"], "outlook snippet");
    assertCleanList(thread!.messages[0].attachment_names, ["brief", ".docx"], "outlook attachment");
    assertClean(thread!.messages[0].body_text, ["outlook body"], "outlook subject body");
  });
} finally {
  await db.stop();
}

if (failures.length > 0) {
  console.error(`v2-nul-mail-sync: ${failures.length} failed\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log("v2-nul-mail-sync: OK");
