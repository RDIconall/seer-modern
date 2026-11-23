/**
 * A personal letter must stay out of the safe-to-delete pile when the sender's
 * local part merely starts with a broadcast keyword.
 *
 * `news.jane@gmail.com` is a person. The keyword `news` is not the whole local
 * part, so a greeting that names the mailbox owner has to veto delete. The same
 * rule covers every keyword the machine-address check recognises, and both
 * mailbox adapters, because both store the address the sender put on the letter.
 *
 * These assertions fail while a period, plus, or hyphen after the keyword is
 * treated as the end of that keyword. They pass once a machine address is only
 * a local part that is exactly the keyword.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { readBatch } from "../src/lib/v2/intelligence/read-batch.ts";
import type { ReaderModel } from "../src/lib/v2/intelligence/reader.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import { buildInboxView } from "../src/lib/v2/view/build.ts";
import { getMailboxView } from "../src/lib/v3/mailbox/repository.ts";
import { sweepCommands } from "../src/components/v2/triage-select.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import type { ReadResult } from "../src/lib/v2/intelligence/schema.ts";

const OWN = "conall@rditrials.com";
const GREETING = "Hi Conall, this is a short note from someone who knows you.";
const NO_GREETING = "Hello,\n\nThe weekly notes are attached for the list.";
const BANNER_GREETING =
  "You don't often get email from news.banner@gmail.com. Learn why this is important Hi Conall, this is Jane.";

type Expectation = "hold" | "clear";

type Letter = {
  id: string;
  /** Address text the provider payload carries. Mixed case is intentional. */
  rawAddress: string;
  email: string;
  body: string;
  expectation: Expectation;
  provider: "google" | "microsoft";
};

const heldLocals = [
  "news.jane",
  "update.jane",
  "updates.jane",
  "newsletter.jane",
  "newsletters.jane",
  "marketing.jane",
  "mailing.jane",
  "digest.jane",
  "campaign.jane",
  "campaigns.jane",
  "notification.jane",
  "notifications.jane",
  "noreply.jane",
  "no-reply.jane",
  "no.reply.jane",
  "donotreply.jane",
  "do-not-reply.jane",
  "do.not.reply.jane",
  "mailer-daemon.jane",
  "mailer.daemon.jane",
  "postmaster.jane",
  "bounce.jane",
  "bounces.jane",
  "auto-reply.jane",
  "auto.reply.jane",
  "auto-confirm.jane",
  "auto-responder.jane",
  "news+jane",
  "news-jane",
];

const clearLocals = ["news", "updates", "no-reply", "marketing", "newsletter"];

function letter(
  id: string,
  local: string,
  expectation: Expectation,
  body: string = GREETING,
): Letter {
  return {
    id,
    rawAddress: `${local}@gmail.com`,
    email: `${local}@gmail.com`.toLowerCase(),
    body,
    expectation,
    provider: "google",
  };
}

const letters: Letter[] = [
  ...heldLocals.map((local, index) => letter(`g-hold-${index}`, local, "hold")),
  letter("g-banner", "news.banner", "hold", BANNER_GREETING),
  letter("g-plain", "jane", "hold"),
  letter("g-underscore", "news_jane", "hold"),
  ...clearLocals.map((local, index) => letter(`g-clear-${index}`, local, "clear")),
  letter("g-broadcast", "news.broadcast", "clear", NO_GREETING),
  {
    id: "o-hold-marketing",
    rawAddress: "Marketing.Sam@Outlook.com",
    email: "marketing.sam@outlook.com",
    body: GREETING,
    expectation: "hold",
    provider: "microsoft",
  },
];

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function gmailMessage(item: Letter, epoch: number) {
  const from = `Jane Doe <${item.rawAddress}>`;
  return {
    id: `${item.id}-m1`,
    threadId: item.id,
    snippet: "short note",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(epoch),
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "To", value: `Conall Arora <${OWN}>` },
        { name: "Subject", value: "A short note" },
      ],
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { size: item.body.length, data: b64url(item.body) } },
        {
          mimeType: "text/html",
          body: { size: item.body.length + 7, data: b64url(`<p>${item.body}</p>`) },
        },
      ],
    },
  };
}

function gmailFetch(gmailLetters: Letter[]): typeof fetch {
  const threads = new Map(gmailLetters.map((item) => [item.id, item]));
  return async (input) => {
    const url = new URL(String(input));
    const list = url.pathname.endsWith("/threads");
    if (list) {
      return json({
        threads: [...threads.keys()].map((id) => ({ id })),
        resultSizeEstimate: threads.size,
      });
    }
    const threadGet = url.pathname.match(/\/threads\/([^/]+)$/);
    if (threadGet) {
      const id = decodeURIComponent(threadGet[1]);
      const item = threads.get(id);
      if (!item) return new Response("missing thread", { status: 404 });
      const epoch = Date.parse("2026-11-20T15:00:00Z");
      return json({
        id,
        messages: [gmailMessage(item, epoch)],
      });
    }
    return new Response(`unexpected gmail url ${url.pathname}`, { status: 500 });
  };
}

function outlookMessage(item: Letter) {
  return {
    id: `${item.id}-m1`,
    conversationId: item.id,
    subject: "A short note",
    from: { emailAddress: { address: item.rawAddress, name: "Sam Marketing" } },
    toRecipients: [
      { emailAddress: { address: OWN, name: "Conall Arora" } },
    ],
    ccRecipients: [],
    receivedDateTime: "2026-11-20T15:04:00.000Z",
    bodyPreview: "short note",
    body: { contentType: "text", content: item.body },
    isRead: false,
    hasAttachments: false,
  };
}

function outlookFetch(outlookLetters: Letter[]): typeof fetch {
  return async (input) => {
    const url = decodeURIComponent(String(input));
    if (url.includes("/mailFolders/inbox/messages?")) {
      return json({
        value: outlookLetters.map((item) => ({
          id: `${item.id}-m1`,
          conversationId: item.id,
          subject: "A short note",
          receivedDateTime: "2026-11-20T15:04:00.000Z",
        })),
        "@odata.count": outlookLetters.length,
      });
    }
    const filter = url.match(/conversationId eq '([^']+)'/);
    if (filter) {
      const item = outlookLetters.find((letter) => letter.id === filter[1]);
      if (!item) return new Response("missing conversation", { status: 404 });
      return json({ value: [outlookMessage(item)] });
    }
    return new Response(`unexpected outlook url ${url}`, { status: 500 });
  };
}

const deleteRead: ReadResult = {
  home: "delete",
  summary: "Short note",
  rationale: "No work is outstanding",
  owner: "nobody",
  obligation: false,
  yields: [],
  evidence: [],
};

const db = await startTestDb();
try {
  const userId = await upsertUser(OWN);
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: OWN,
    displayName: "Conall Arora",
  });

  const gmailLetters = letters.filter((item) => item.provider === "google");
  const outlookLetters = letters.filter((item) => item.provider === "microsoft");

  const gmail = new GmailProvider({
    accessToken: "placeholder",
    accountEmail: OWN,
    fetchImpl: gmailFetch(gmailLetters),
    pageSize: 100,
  });
  const gmailSync = await syncFolder(accountId, gmail, "inbox", "incremental");
  assert.equal(gmailSync.coverage.failed, 0, "gmail sync stored the letters");
  assert.equal(gmailSync.coverage.stored, gmailLetters.length);

  const outlook = new OutlookProvider({
    accessToken: "placeholder",
    accountEmail: OWN,
    fetchImpl: outlookFetch(outlookLetters),
    pageSize: 50,
  });
  const outlookSync = await syncFolder(accountId, outlook, "inbox", "incremental");
  assert.equal(outlookSync.coverage.failed, 0, "outlook sync stored the letter");

  const seenFrom: string[] = [];
  const model: ReaderModel = async (input) => {
    for (const message of input.conversation.messages) {
      if (message.from.email) seenFrom.push(message.from.email.toLowerCase());
    }
    return deleteRead;
  };

  const read = await readBatch(accountId, OWN, model, { limit: 100, concurrency: 4 });
  assert.equal(read.failed, 0, "classification completed for every stored letter");
  assert.equal(read.decided, letters.length);

  const stored = await db.pool.query<{
    id: string;
    from_email: string;
    body_text: string | null;
    folders: string[];
    home: string | null;
    veto_reasons: string[] | null;
  }>(
    `select c.id, m.from_email, m.body_text, c.folders, d.home, d.veto_reasons
       from seer.conversations c
       join seer.messages m on m.conversation_id = c.id
       left join seer.conversation_decisions d
         on d.conversation_id = c.id and d.account_id = c.account_id and d.is_current
      where c.account_id = $1`,
    [accountId],
  );
  const byEmail = new Map(stored.rows.map((row) => [row.from_email, row]));

  for (const item of letters) {
    const row = byEmail.get(item.email);
    assert.ok(row, `${item.email} was stored from the provider payload`);
    assert.equal(row.from_email, item.email);
    assert.ok(
      row.body_text?.includes(item.body.slice(0, 24)),
      `${item.email} body reached classification`,
    );
    assert.ok(
      seenFrom.includes(item.email),
      `${item.email} was the message the reader classified`,
    );
  }

  const mailbox = await getMailboxView(accountId, "inbox", 200, undefined, "triage");
  const inbox = await buildInboxView(accountId, "google");
  const mailboxById = new Map(mailbox.rows.map((row) => [row.conversationId, row]));
  const safeIds = new Set(inbox.safeToDelete.map((row) => row.conversationId));

  // The Clear control on the ready-to-clear pile. Ids are the rows whose
  // stored decision is delete; the sweep may trash only those that carry a
  // token minted for that same decision.
  const deleteIds = mailbox.rows
    .filter((row) => row.disposition === "delete")
    .map((row) => row.conversationId);
  const swept = sweepCommands(mailbox.rows, new Set(deleteIds), "trash");
  const sweptById = new Map(swept.map((item) => [item.conversationId, item.command]));

  for (const item of swept) {
    const command = item.command;
    if (command.type !== "delete") continue;
    const row = mailboxById.get(item.conversationId);
    assert.equal(
      command.conversationId,
      item.conversationId,
      "bulk clear acts on the conversation the token was minted for",
    );
    assert.equal(command.deleteToken, row?.deleteToken);
  }

  for (const item of swept) {
    const result = await executeCommand(
      { accountId },
      item.command,
      `clear-${item.conversationId}`,
    );
    assert.equal(
      result.ok,
      true,
      `bulk clear command failed: ${result.error ?? item.command.type}`,
    );
  }

  const after = await db.pool.query<{
    id: string;
    from_email: string;
    folders: string[];
    home: string;
    veto_reasons: string[] | null;
  }>(
    `select c.id, m.from_email, c.folders, d.home, d.veto_reasons
       from seer.conversations c
       join seer.messages m on m.conversation_id = c.id
       join seer.conversation_decisions d
         on d.conversation_id = c.id and d.account_id = c.account_id and d.is_current
      where c.account_id = $1`,
    [accountId],
  );
  const afterByEmail = new Map(after.rows.map((row) => [row.from_email, row]));

  const failures: string[] = [];
  for (const item of letters) {
    const row = afterByEmail.get(item.email);
    if (!row) {
      failures.push(`${item.email}: no decision after classification`);
      continue;
    }
    const before = byEmail.get(item.email);
    const view = before ? mailboxById.get(before.id) : undefined;
    const command = before ? sweptById.get(before.id) : undefined;
    const trashed = row.folders.includes("trash");
    const stillInbox = row.folders.includes("inbox");
    const vetoed = (row.veto_reasons ?? []).includes("personal_greeting");

    if (item.expectation === "hold") {
      if (row.home !== "record" || !vetoed) {
        failures.push(
          `${item.email}: decision home=${row.home} vetoes=${(row.veto_reasons ?? []).join(",") || "none"}; a greeting by name must keep it off the delete pile`,
        );
      }
      if (view?.deleteToken) {
        failures.push(`${item.email}: inbox signed a delete token`);
      }
      if (view?.disposition === "delete" || (before && safeIds.has(before.id))) {
        failures.push(`${item.email}: listed as safe to delete`);
      }
      if (command?.type === "delete" || trashed || !stillInbox) {
        failures.push(
          `${item.email}: bulk clear ${command?.type ?? "skipped"} left folders=${row.folders.join(",")}`,
        );
      }
    } else {
      if (row.home !== "delete" || vetoed) {
        failures.push(
          `${item.email}: expected a machine or ungreeted letter to stay deletable, home=${row.home} vetoes=${(row.veto_reasons ?? []).join(",")}`,
        );
      }
      if (!view?.deleteToken || view.disposition !== "delete") {
        failures.push(`${item.email}: expected a delete token on the clear pile`);
      }
      if (before && !safeIds.has(before.id)) {
        failures.push(`${item.email}: v2 inbox did not list it as safe to delete`);
      }
      if (command?.type !== "delete" || !trashed || stillInbox) {
        failures.push(
          `${item.email}: bulk clear ${command?.type ?? "skipped"} left folders=${row.folders.join(",")}`,
        );
      }
    }
  }

  assert.equal(failures.length, 0, failures.join("\n"));
  console.log("v2-dotted-sender-delete: OK");
} finally {
  await db.stop();
}
