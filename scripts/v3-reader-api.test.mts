/**
 * Task 6 gate: corpus conversation reader, attachment streaming ownership,
 * forward command, and Reader/Compose wiring contracts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { saveDecision } from "../src/lib/v2/intelligence/repository.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { getCorpusConversation } from "../src/lib/v3/reader/repository.ts";
import { verifyMessageOwnership, resolveAttachmentMeta } from "../src/lib/v3/attachments/repository.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fakeMsg(
  id: string,
  sentAt: string,
  attachments: Message["attachments"] = [],
): Message & { folder: "inbox" } {
  return {
    providerMessageId: id,
    from: { email: "alice@example.com", name: "Alice" },
    to: [{ email: "me@example.com" }],
    cc: [],
    sentAt,
    snippet: "hello",
    bodyHtml: "<p>hello</p>",
    bodyText: "hello",
    isUnread: false,
    isOutgoing: false,
    attachments,
    folder: "inbox",
  } as Message & { folder: "inbox" };
}

async function seedThread(
  pool: import("pg").Pool,
  accountId: AccountId,
  providerId: string,
  messages: { providerId: string; sentAt: string; attachments?: string[] }[],
) {
  const c = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread)
     values ($1, $2, 'Thread subject', $3, array['inbox']::text[], false)
     returning id`,
    [accountId, providerId, messages[messages.length - 1]?.sentAt ?? "2026-08-10T12:00:00Z"],
  );
  const conversationId = c.rows[0].id;
  for (const m of messages) {
    await pool.query(
      `insert into seer.messages
         (account_id, conversation_id, provider_message_id, from_email, from_name,
          to_emails, sent_at, snippet, body_html, body_text, is_unread, is_outgoing, attachment_names)
       values ($1, $2, $3, 'alice@example.com', 'Alice', array['me@example.com'], $4,
               'hello', '<p>hello</p>', 'hello', false, false, $5)`,
      [
        accountId,
        conversationId,
        m.providerId,
        m.sentAt,
        m.attachments ?? [],
      ],
    );
  }
  return asConversationId(conversationId);
}

const db = await startTestDb();
try {
  const userId = await upsertUser("reader@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "reader@example.com",
  });
  const otherUserId = await upsertUser("other@example.com");
  const otherAccountId = await upsertAccount({
    userId: otherUserId,
    provider: "google",
    email: "other@example.com",
  });

  const corpusId = await seedThread(db.pool, accountId, "p-thread", [
    { providerId: "m-old", sentAt: "2026-08-08T10:00:00Z" },
    { providerId: "m-mid", sentAt: "2026-08-09T10:00:00Z", attachments: ["brief.pdf"] },
    { providerId: "m-new", sentAt: "2026-08-10T10:00:00Z" },
  ]);
  const otherId = await seedThread(db.pool, otherAccountId, "p-other", [
    { providerId: "m-other", sentAt: "2026-08-10T10:00:00Z" },
  ]);

  // Corpus reader returns thread oldest-first with native URL metadata.
  const view = await getCorpusConversation(accountId, corpusId, "google");
  assert.ok(view, "conversation must load for owning account");
  assert.equal(view!.conversation.subject, "Thread subject");
  assert.equal(view!.conversation.messages.length, 3);
  assert.equal(view!.conversation.messages[0].providerMessageId, "m-old");
  assert.equal(view!.conversation.messages[2].providerMessageId, "m-new");
  for (let i = 1; i < view!.conversation.messages.length; i++) {
    assert.ok(
      view!.conversation.messages[i - 1].sentAt <= view!.conversation.messages[i].sentAt,
      "messages must be oldest-first",
    );
  }
  assert.match(view!.nativeUrl, /^https:\/\//);
  assert.ok(
    view!.nativeUrl.includes("p-thread"),
    "native URL must target provider conversation",
  );
  assert.equal(view!.conversation.messages[1].attachments[0].filename, "brief.pdf");
  assert.match(
    view!.conversation.messages[1].attachments[0].id,
    /^m-mid-/,
    "synthetic attachment ids must be stable",
  );

  // Ownership: another account cannot read this conversation.
  const denied = await getCorpusConversation(otherAccountId, corpusId, "google");
  assert.equal(denied, null);

  // Message ownership check for attachment route.
  const owned = await verifyMessageOwnership(accountId, "m-mid");
  assert.ok(owned);
  assert.equal(owned!.providerConversationId, "p-thread");
  const foreign = await verifyMessageOwnership(otherAccountId, "m-mid");
  assert.equal(foreign, null);

  const meta = resolveAttachmentMeta(owned!, "m-mid-0");
  assert.equal(meta.filename, "brief.pdf");
  assert.equal(meta.index, 0);

  // Forward command executes synchronously through the provider.
  const provider = new FakeProvider({
    conversations: [
      {
        providerConversationId: "p-thread",
        subject: "Thread subject",
        messages: [fakeMsg("m-new", "2026-08-10T10:00:00Z")],
      },
    ],
  });
  const fwd = await executeCommand(
    { accountId, provider },
    {
      type: "forward",
      providerConversationId: "p-thread",
      to: ["bob@example.com"],
      bodyHtml: "<p>see below</p>",
    },
    "key-fwd",
  );
  assert.equal(fwd.ok, true);
  assert.equal(fwd.optimistic, undefined);
  assert.ok(fwd.detail?.providerMessageId);

  // API route files exist with account scoping and no credential leakage.
  const convRoute = readFileSync(
    path.join(HERE, "../src/app/api/v3/conversations/[id]/route.ts"),
    "utf8",
  );
  assert.match(convRoute, /getActiveV2Account/);
  assert.match(convRoute, /getCorpusConversation/);
  assert.ok(!/accessToken|refreshToken|ciphertext/i.test(convRoute));

  const attachRoute = readFileSync(
    path.join(HERE, "../src/app/api/v3/messages/[id]/attachments/[attachmentId]/route.ts"),
    "utf8",
  );
  assert.match(attachRoute, /verifyMessageOwnership/);
  assert.match(attachRoute, /getAttachment/);
  assert.match(attachRoute, /attachmentResponseHeaders/);
  assert.match(attachRoute, /X-Content-Type-Options/);
  assert.ok(!/accessToken|refreshToken|ciphertext/i.test(attachRoute));

  const composeSrc = readFileSync(path.join(HERE, "../src/components/v2/Compose.tsx"), "utf8");
  assert.match(composeSrc, /providerConversationId/);
  assert.match(composeSrc, /\/api\/v2\/commands/);

  const readerSrc = readFileSync(path.join(HERE, "../src/components/v2/Reader.tsx"), "utf8");
  assert.match(readerSrc, /\/api\/v3\/messages\//);
  assert.match(readerSrc, /dispatchCommand|useReaderCommands/);
  assert.match(readerSrc, /corpusConversationId/);

  const htmlSrc = readFileSync(path.join(HERE, "../src/components/v2/MessageHtml.tsx"), "utf8");
  assert.match(htmlSrc, /sanitizeEmailHtml/);
  assert.match(htmlSrc, /seer-message-text/);

  // Cross-account isolation on other conversation.
  const otherView = await getCorpusConversation(otherAccountId, otherId, "google");
  assert.ok(otherView);
  assert.notEqual(otherView!.conversation.providerConversationId, "p-thread");

  console.log("v3-reader-api: OK");
} finally {
  await db.stop();
}
