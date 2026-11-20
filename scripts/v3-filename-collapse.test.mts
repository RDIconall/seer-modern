/**
 * A later sender must not replace the only download of an earlier attachment
 * by reusing its filename, including a name that matches only after lowercasing.
 *
 * The reader keeps one chip per lowercased name. These tests load a thread the
 * way the product does — Gmail payload, sync, oldest-first corpus read, reader
 * chips — then follow each chip through the attachment route's resolution and
 * require the bytes that belong to the name on the chip.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { syncAccount } from "../src/lib/v2/sync/engine.ts";
import { getCorpusConversation } from "../src/lib/v3/reader/repository.ts";
import {
  findProviderAttachmentId,
  resolveAttachmentMeta,
  verifyMessageOwnership,
} from "../src/lib/v3/attachments/repository.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { attachmentUrl, Reader } from "../src/components/v2/Reader.tsx";
import type { AccountId } from "../src/lib/v2/db/types.ts";
import type { AttachmentContent, Conversation, MailProvider } from "../src/lib/v2/providers/types.ts";

const VICTIM = "victim@rditrials.com";
const TRUSTED_NAME = "Study_Agreement.pdf";
const LATER_NAME = "study_agreement.pdf";
const NOTES_NAME = "Site_Notes.txt";
const EXACT_NAME = "Study_Agreement.pdf";

const TRUSTED_BODY = "trusted-agreement-bytes";
const LATER_BODY = "later-sender-substituted-bytes";
const NOTES_BODY = "site-notes-bytes";
const EXACT_OLD_BODY = "exact-name-earlier-bytes";
const EXACT_NEW_BODY = "exact-name-later-bytes";

const THREAD_CASE = "thread-case";
const THREAD_EXACT = "thread-exact";
const MSG_TRUSTED = "msgTrusted";
const MSG_LATER = "msgLater";
const MSG_EXACT_OLD = "msgExactOld";
const MSG_EXACT_NEW = "msgExactNew";

type GmailMessage = {
  id: string;
  threadId: string;
  internalDate: string;
  snippet: string;
  labelIds: string[];
  payload: {
    mimeType: string;
    headers: { name: string; value: string }[];
    parts: Record<string, unknown>[];
  };
};

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function textPart(value: string): Record<string, unknown> {
  return {
    mimeType: "text/plain",
    body: { size: value.length, data: b64url(value) },
  };
}

function filePart(filename: string, attachmentId: string, bytes: string): Record<string, unknown> {
  return {
    filename,
    mimeType: filename.endsWith(".pdf") ? "application/pdf" : "text/plain",
    body: { attachmentId, size: Buffer.byteLength(bytes) },
  };
}

function gmailMessage(input: {
  id: string;
  threadId: string;
  internalDate: string;
  from: string;
  subject: string;
  files: { filename: string; attachmentId: string; bytes: string }[];
}): GmailMessage {
  return {
    id: input.id,
    threadId: input.threadId,
    internalDate: input.internalDate,
    snippet: "please review the attached file",
    labelIds: ["INBOX"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: input.from },
        { name: "To", value: `Victim <${VICTIM}>` },
        { name: "Subject", value: input.subject },
      ],
      parts: [
        textPart("please review the attached file"),
        ...input.files.map((file) => filePart(file.filename, file.attachmentId, file.bytes)),
      ],
    },
  };
}

const MESSAGES: Record<string, GmailMessage> = {
  [MSG_TRUSTED]: gmailMessage({
    id: MSG_TRUSTED,
    threadId: THREAD_CASE,
    internalDate: "1700000000000",
    from: "Counsel <counsel@lumos.example>",
    subject: "Study agreement",
    files: [
      { filename: TRUSTED_NAME, attachmentId: "att-trusted", bytes: TRUSTED_BODY },
      { filename: NOTES_NAME, attachmentId: "att-notes", bytes: NOTES_BODY },
    ],
  }),
  [MSG_LATER]: gmailMessage({
    id: MSG_LATER,
    threadId: THREAD_CASE,
    internalDate: "1700001000000",
    from: "Later Sender <later@elsewhere.example>",
    subject: "Study agreement",
    files: [{ filename: LATER_NAME, attachmentId: "att-later", bytes: LATER_BODY }],
  }),
  [MSG_EXACT_OLD]: gmailMessage({
    id: MSG_EXACT_OLD,
    threadId: THREAD_EXACT,
    internalDate: "1700002000000",
    from: "Counsel <counsel@lumos.example>",
    subject: "Study agreement copy",
    files: [{ filename: EXACT_NAME, attachmentId: "att-exact-old", bytes: EXACT_OLD_BODY }],
  }),
  [MSG_EXACT_NEW]: gmailMessage({
    id: MSG_EXACT_NEW,
    threadId: THREAD_EXACT,
    internalDate: "1700003000000",
    from: "Later Sender <later@elsewhere.example>",
    subject: "Study agreement copy",
    files: [{ filename: EXACT_NAME, attachmentId: "att-exact-new", bytes: EXACT_NEW_BODY }],
  }),
};

const THREADS: Record<string, GmailMessage[]> = {
  // Newer message first, as a thread payload may arrive. Sync and the corpus
  // read both reorder by time; the file list must not depend on that order to
  // keep the earlier bytes reachable.
  [THREAD_CASE]: [MESSAGES[MSG_LATER]!, MESSAGES[MSG_TRUSTED]!],
  [THREAD_EXACT]: [MESSAGES[MSG_EXACT_NEW]!, MESSAGES[MSG_EXACT_OLD]!],
};

const BYTES: Record<string, string> = {
  "att-trusted": TRUSTED_BODY,
  "att-notes": NOTES_BODY,
  "att-later": LATER_BODY,
  "att-exact-old": EXACT_OLD_BODY,
  "att-exact-new": EXACT_NEW_BODY,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET") throw new Error(`unexpected ${method} ${url}`);

  if (url.includes("/threads?") && url.includes("in%3Ainbox")) {
    return json({
      threads: [{ id: THREAD_CASE }, { id: THREAD_EXACT }],
      resultSizeEstimate: 2,
    });
  }

  const threadGet = url.match(/\/threads\/([^/?]+)\?format=full/);
  if (threadGet) {
    const threadId = decodeURIComponent(threadGet[1]!);
    const messages = THREADS[threadId];
    if (!messages) throw new Error(`unknown thread ${threadId}`);
    return json({ id: threadId, messages });
  }

  const attachmentGet = url.match(/\/messages\/([^/]+)\/attachments\/([^/?]+)/);
  if (attachmentGet) {
    const attachmentId = decodeURIComponent(attachmentGet[2]!);
    const bytes = BYTES[attachmentId];
    if (bytes === undefined) throw new Error(`unknown attachment ${attachmentId}`);
    return json({ data: b64url(bytes), size: Buffer.byteLength(bytes) });
  }

  const messageGet = url.match(/\/messages\/([^/?]+)\?format=full/);
  if (messageGet) {
    const messageId = decodeURIComponent(messageGet[1]!);
    const message = MESSAGES[messageId];
    if (!message) throw new Error(`unknown message ${messageId}`);
    return json(message);
  }

  throw new Error(`unexpected request ${url}`);
}) as typeof fetch;

type Chip = { href: string; text: string };

function readerChips(html: string): Chip[] {
  const chips: Chip[] = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  for (const match of html.matchAll(pattern)) {
    const attrs = match[1] ?? "";
    if (!attrs.includes("reader-file")) continue;
    const href = attrs.match(/href="([^"]*)"/)?.[1];
    if (!href) continue;
    chips.push({
      href,
      text: (match[2] ?? "").replace(/<[^>]+>/g, "").replace(/<!--[\s\S]*?-->/g, ""),
    });
  }
  return chips;
}

function renderReader(conversation: Conversation): string {
  const rendered = renderToString(
    createElement(Reader, {
      provider: "google",
      conversation,
      ownEmail: VICTIM,
      onReply() {},
      onReplyAll() {},
      onForward() {},
      onArchive() {},
      onDelete() {},
    }),
  );
  return rendered.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * The attachment route's resolution, in the same order as
 * src/app/api/v3/messages/[id]/attachments/[attachmentId]/route.ts.
 * Session selection only chooses the account; it does not retarget the file.
 */
async function downloadChip(
  accountId: AccountId,
  provider: MailProvider,
  href: string,
): Promise<AttachmentContent> {
  const match = href.match(/\/api\/v3\/messages\/([^/]+)\/attachments\/([^/?#]+)/);
  assert.ok(match, `chip href must be an attachment download: ${href}`);
  const providerMessageId = decodeURIComponent(match[1]!);
  const attachmentId = decodeURIComponent(match[2]!);
  const owned = await verifyMessageOwnership(accountId, providerMessageId);
  assert.ok(owned, `download must resolve a message the victim owns: ${providerMessageId}`);
  const meta = resolveAttachmentMeta(owned, attachmentId);
  let providerAttachmentId = attachmentId;
  if (attachmentId.startsWith(`${providerMessageId}-`)) {
    const fresh = await provider.getConversation(owned.providerConversationId);
    const resolved = findProviderAttachmentId(fresh, providerMessageId, meta);
    assert.ok(resolved, `synthetic id ${attachmentId} must resolve on ${providerMessageId}`);
    providerAttachmentId = resolved;
  }
  return provider.getAttachment(providerMessageId, providerAttachmentId);
}

type ExpectedFile = {
  messageId: string;
  filename: string;
  body: string;
};

async function assertEveryFileStaysDownloadable(
  accountId: AccountId,
  provider: MailProvider,
  corpusId: string,
  expected: ExpectedFile[],
): Promise<void> {
  const view = await getCorpusConversation(accountId, corpusId, "google");
  assert.ok(view, "corpus conversation must load");
  const html = renderReader(view.conversation);
  const chips = readerChips(html);
  const offered = await Promise.all(
    chips.map(async (chip) => ({
      chip,
      content: await downloadChip(accountId, provider, chip.href),
    })),
  );

  for (const file of expected) {
    const stored = view.conversation.messages.find(
      (message) => message.providerMessageId === file.messageId,
    );
    assert.ok(stored, `corpus must keep ${file.messageId}`);
    const attachment = stored.attachments.find((item) => item.filename === file.filename);
    assert.ok(attachment, `corpus must keep ${file.filename} on ${file.messageId}`);
    const href = attachmentUrl(file.messageId, attachment.id);
    const chip = chips.find((item) => item.href === href);
    assert.ok(
      chip,
      `${file.filename} on ${file.messageId} must stay linked (href ${href}). ` +
        `Reader offered ${JSON.stringify(chips)}`,
    );
    assert.ok(
      chip.text.includes(file.filename),
      `the link for ${file.messageId} must show ${file.filename}, not ${JSON.stringify(chip.text)}`,
    );
    const content = await downloadChip(accountId, provider, chip.href);
    assert.equal(
      content.filename,
      file.filename,
      `downloading the chip named ${file.filename} must return that file's name`,
    );
    assert.equal(
      content.body.toString("utf8"),
      file.body,
      `downloading the chip named ${file.filename} on ${file.messageId} must return that sender's bytes`,
    );
  }

  for (const { chip, content } of offered) {
    assert.ok(
      chip.text.includes(content.filename),
      `chip ${JSON.stringify(chip.text)} downloaded ${content.filename} (${content.body.toString("utf8")})`,
    );
  }
}

const db = await startTestDb();
try {
  const userId = await upsertUser(VICTIM);
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: VICTIM,
  });
  const provider = new GmailProvider({
    accessToken: "placeholder-access-token",
    accountEmail: VICTIM,
    fetchImpl: mockFetch,
  });

  const run = await syncAccount(accountId, provider, "full");
  assert.equal(run.coverage.failed, 0, "sync must store both threads");
  assert.equal(run.coverage.stored, 2);

  const stored = await db.pool.query<{
    provider_message_id: string;
    attachment_names: string[] | null;
    sent_at: Date;
  }>(
    `select provider_message_id, attachment_names, sent_at
       from seer.messages
      where account_id = $1
      order by sent_at asc, provider_message_id asc`,
    [accountId],
  );
  const names = new Map(
    stored.rows.map((row) => [row.provider_message_id, row.attachment_names ?? []]),
  );
  assert.deepEqual(names.get(MSG_TRUSTED), [TRUSTED_NAME, NOTES_NAME]);
  assert.deepEqual(names.get(MSG_LATER), [LATER_NAME]);
  assert.deepEqual(names.get(MSG_EXACT_OLD), [EXACT_NAME]);
  assert.deepEqual(names.get(MSG_EXACT_NEW), [EXACT_NAME]);

  const caseRow = await db.pool.query<{ id: string }>(
    `select id from seer.conversations
      where account_id = $1 and provider_conversation_id = $2`,
    [accountId, THREAD_CASE],
  );
  const exactRow = await db.pool.query<{ id: string }>(
    `select id from seer.conversations
      where account_id = $1 and provider_conversation_id = $2`,
    [accountId, THREAD_EXACT],
  );
  const caseId = caseRow.rows[0]!.id;
  const exactId = exactRow.rows[0]!.id;

  const loaded = await getCorpusConversation(accountId, caseId, "google");
  assert.ok(loaded);
  assert.deepEqual(
    loaded.conversation.messages.map((message) => message.providerMessageId),
    [MSG_TRUSTED, MSG_LATER],
    "the reader loads the thread oldest first",
  );
  assert.equal(loaded.conversation.messages[0]!.attachments[0]!.filename, TRUSTED_NAME);
  assert.equal(loaded.conversation.messages[1]!.attachments[0]!.filename, LATER_NAME);

  // The original bytes are still at the provider. The reader is what drops them.
  const trustedDirect = await downloadChip(
    accountId,
    provider,
    attachmentUrl(MSG_TRUSTED, `${MSG_TRUSTED}-0`),
  );
  assert.equal(trustedDirect.body.toString("utf8"), TRUSTED_BODY);
  assert.equal(trustedDirect.filename, TRUSTED_NAME);
  const laterDirect = await downloadChip(
    accountId,
    provider,
    attachmentUrl(MSG_LATER, `${MSG_LATER}-0`),
  );
  assert.equal(laterDirect.body.toString("utf8"), LATER_BODY);
  assert.notEqual(trustedDirect.body.toString("utf8"), laterDirect.body.toString("utf8"));

  await assertEveryFileStaysDownloadable(accountId, provider, caseId, [
    { messageId: MSG_TRUSTED, filename: TRUSTED_NAME, body: TRUSTED_BODY },
    { messageId: MSG_TRUSTED, filename: NOTES_NAME, body: NOTES_BODY },
    { messageId: MSG_LATER, filename: LATER_NAME, body: LATER_BODY },
  ]);

  await assertEveryFileStaysDownloadable(accountId, provider, exactId, [
    { messageId: MSG_EXACT_OLD, filename: EXACT_NAME, body: EXACT_OLD_BODY },
    { messageId: MSG_EXACT_NEW, filename: EXACT_NAME, body: EXACT_NEW_BODY },
  ]);
} finally {
  await db.stop();
}

console.log("v3-filename-collapse: OK");
