/**
 * Hostile HTML in a mailbox must not pin that mailbox's sync cursor.
 *
 * htmlToText / storedBodyText run synchronously while a page is written, and
 * the cursor is saved only after that transaction commits. These tests fail
 * while the stripper rescans the tail of the string for an unclosed comment,
 * an unclosed script or style tag, or a run of bare "<" characters. They pass
 * once conversion stays inside the time budget and the page commits anyway.
 *
 * Run: npx tsx scripts/v2-html-sync-stall.test.mts
 *
 * Not covered here (same `<[^>]+>` family, different entry points):
 * src/app/api/mailbox/route.ts, src/app/api/cron/sync/route.ts,
 * src/app/api/messages/[id]/route.ts, src/app/api/alltasks/route.ts,
 * src/app/api/today/route.ts, src/app/api/assist/draft/route.ts,
 * src/app/api/send/route.ts, src/lib/inbox/key-actions.ts,
 * src/lib/v2/client/reply.ts.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { htmlToText, storedBodyText } from "../src/lib/v2/intelligence/html-text.ts";
import { freshBody } from "../src/lib/v3/reader/thread-shape.ts";
import { readableHtml } from "../src/lib/v3/reader/email-html.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { setPoolForTesting } from "../src/lib/v2/db/pool.ts";
import { asAccountId } from "../src/lib/v2/db/types.ts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { startTestDb } from "./v2-testdb.mts";
import type { Message } from "../src/lib/v2/providers/types.ts";

/** Pure conversion of these bodies must finish well under a serverless slice. */
const CPU_BUDGET_MS = 500;
/**
 * Page write plus conversion. Wider than the CPU budget so Postgres can
 * answer, still far below the time the quadratic stripper takes on the
 * specimen below (and far below maxDuration on the sync and webhook routes).
 */
const SYNC_BUDGET_MS = 2_000;

const NEXT_PAGE = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=poison-page-2";

function message(partial: Partial<Message> & Pick<Message, "bodyHtml" | "bodyText">): Message {
  return {
    providerMessageId: "m1",
    from: { email: "attacker@example.com", name: "Attacker" },
    to: [{ email: "me@example.com" }],
    cc: [],
    sentAt: "2026-11-19T08:00:00.000Z",
    snippet: "preview",
    isUnread: true,
    isOutgoing: false,
    attachments: [],
    ...partial,
  };
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function gmailDeliversHtmlOnly(): Promise<void> {
  const html = "<p>HTML only</p>";
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/threads?") && !url.includes("/threads/")) {
      return jsonResponse({
        threads: [{ id: "t-html" }],
        resultSizeEstimate: 1,
      });
    }
    if (url.includes("/threads/t-html")) {
      return jsonResponse({
        id: "t-html",
        messages: [
          {
            id: "m-html",
            threadId: "t-html",
            snippet: "HTML only",
            labelIds: ["INBOX", "UNREAD"],
            internalDate: "1763539200000",
            payload: {
              mimeType: "text/html",
              headers: [
                { name: "From", value: "Attacker <attacker@example.com>" },
                { name: "To", value: "me@example.com" },
                { name: "Subject", value: "HTML only" },
              ],
              body: { size: html.length, data: b64url(html) },
            },
          },
        ],
      });
    }
    throw new Error(`unexpected Gmail request ${url}`);
  }) as typeof fetch;

  const provider = new GmailProvider({
    accessToken: "test-token",
    accountEmail: "me@example.com",
    fetchImpl,
    pageSize: 10,
  });
  const page = await provider.syncFolder("inbox", null);
  const stored = page.conversations[0]?.messages[0];
  assert.ok(stored, "Gmail page must include the HTML-only message");
  assert.equal(stored.bodyText, null);
  assert.equal(stored.bodyHtml, html);
}

async function outlookDeliversHtmlOnly(): Promise<void> {
  const html = "<p>HTML only</p>";
  let sawNewestFirst = false;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/mailFolders/inbox/messages?")) {
      sawNewestFirst = url.includes("$orderby=receivedDateTime%20desc") || url.includes("$orderby=receivedDateTime desc");
      return jsonResponse({
        value: [
          {
            id: "m-html",
            conversationId: "c-html",
            receivedDateTime: "2026-11-19T08:00:00Z",
          },
        ],
        "@odata.count": 1,
      });
    }
    if (url.includes("c-html")) {
      return jsonResponse({
        value: [
          {
            id: "m-html",
            conversationId: "c-html",
            subject: "HTML only",
            from: { emailAddress: { address: "attacker@example.com", name: "Attacker" } },
            toRecipients: [{ emailAddress: { address: "me@example.com" } }],
            receivedDateTime: "2026-11-19T08:00:00Z",
            bodyPreview: "HTML only",
            body: { contentType: "HTML", content: html },
            isRead: false,
          },
        ],
      });
    }
    throw new Error(`unexpected Graph request ${url}`);
  }) as typeof fetch;

  const provider = new OutlookProvider({
    accessToken: "test-token",
    accountEmail: "me@example.com",
    fetchImpl,
  });
  const page = await provider.syncFolder("inbox", null);
  const stored = page.conversations[0]?.messages[0];
  assert.equal(sawNewestFirst, true, "inbox sync must ask Graph for newest mail first");
  assert.ok(stored, "Outlook page must include the HTML message");
  assert.equal(stored.bodyText, null);
  assert.equal(stored.bodyHtml, html);
}

function hostileBodyFailures(): string[] {
  const failures: string[] = [];
  const check = (label: string, run: () => void) => {
    const started = performance.now();
    try {
      run();
      const elapsed = performance.now() - started;
      if (elapsed >= CPU_BUDGET_MS) {
        failures.push(
          `${label} held the event loop for ${elapsed.toFixed(0)}ms (budget ${CPU_BUDGET_MS}ms)`,
        );
      }
    } catch (error) {
      failures.push(
        `${label} threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const bodies: Array<[string, string]> = [
    ["bare less-than run", "<".repeat(40_000)],
    ["unclosed comments", "<!--".repeat(20_000)],
    ["unclosed script tags", "<script>".repeat(32_000)],
    ["unclosed script tag without a terminator", "<script".repeat(12_000)],
    ["unclosed style tag without a terminator", "<style".repeat(12_000)],
  ];

  for (const [label, html] of bodies) {
    check(`storedBodyText (${label})`, () => {
      const derived = storedBodyText({ bodyText: null, bodyHtml: html });
      assert.equal(typeof derived === "string" || derived === null, true);
    });
    check(`htmlToText (${label})`, () => {
      assert.equal(typeof htmlToText(html), "string");
    });
    check(`freshBody (${label})`, () => {
      const shaped = freshBody(message({ bodyHtml: html, bodyText: null, snippet: "preview" }));
      assert.equal(typeof shaped.text, "string");
    });
    check(`readableHtml (${label})`, () => {
      assert.equal(typeof readableHtml(html).html, "string");
    });
  }

  // A blank text part must not skip the HTML body, and must still finish.
  check("storedBodyText (whitespace text part)", () => {
    storedBodyText({ bodyText: " \n\t ", bodyHtml: "<".repeat(40_000) });
  });

  // A real text part is what sync stores, and it must not scan the HTML.
  check("storedBodyText (text part present)", () => {
    assert.equal(
      storedBodyText({ bodyText: "plain wins", bodyHtml: "<".repeat(80_000) }),
      "plain wins",
    );
  });

  check("storedBodyText (ordinary html)", () => {
    assert.equal(
      storedBodyText({ bodyText: null, bodyHtml: "<p>Please review the contract.</p>" }),
      "Please review the contract.",
    );
  });
  return failures;
}

type SyncObservation = {
  finished: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  safeText: string | null;
  poisonCount: number;
  cursor: string | null;
  backfillComplete: boolean;
};

async function observeStalledSync(): Promise<SyncObservation> {
  const db = await startTestDb();
  const port = Number(db.pool.options.port);
  try {
    const userId = await upsertUser("stall@example.com");
    const accountId = await upsertAccount({
      userId,
      provider: "microsoft",
      email: "stall@example.com",
    });
    await db.pool.query(
      `insert into seer.folder_sync_state
         (account_id, folder, cursor, provider_total, backfill_complete,
          snapshot_generation, scan_started_at, last_reconciled_at)
       values ($1, 'inbox', null, 4, false, gen_random_uuid(), now(), null)`,
      [accountId],
    );

    const child = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SEER_HTML_STALL_CHILD: "1",
          SEER_HTML_STALL_PORT: String(port),
          SEER_HTML_STALL_ACCOUNT: accountId,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const finished = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), SYNC_BUDGET_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    let exitCode: number | null = child.exitCode;
    let signal: NodeJS.Signals | null = child.signalCode;
    if (!finished) {
      child.kill("SIGKILL");
      const killed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once("exit", (code, sig) => resolve({ code, signal: sig }));
        },
      );
      exitCode = killed.code;
      signal = killed.signal;
    }

    const messages = await db.pool.query<{
      provider_message_id: string;
      body_text: string | null;
    }>(
      `select provider_message_id, body_text
         from seer.messages
        where account_id = $1`,
      [accountId],
    );
    const state = await db.pool.query<{
      cursor: string | null;
      backfill_complete: boolean;
    }>(
      `select cursor, backfill_complete
         from seer.folder_sync_state
        where account_id = $1 and folder = 'inbox'`,
      [accountId],
    );
    const safe = messages.rows.find((row) => row.provider_message_id === "safe-1");
    return {
      finished,
      exitCode,
      signal,
      stderr,
      safeText: safe?.body_text ?? null,
      poisonCount: messages.rows.filter((row) => row.provider_message_id === "poison-1").length,
      cursor: state.rows[0]?.cursor ?? null,
      backfillComplete: state.rows[0]?.backfill_complete ?? false,
    };
  } finally {
    await db.stop();
  }
}

function graphMessage(input: {
  id: string;
  conversationId: string;
  received: string;
  subject: string;
  preview: string;
  contentType: string;
  content: string;
}) {
  return {
    id: input.id,
    conversationId: input.conversationId,
    subject: input.subject,
    from: { emailAddress: { address: "attacker@example.com", name: "Attacker" } },
    toRecipients: [{ emailAddress: { address: "stall@example.com" } }],
    ccRecipients: [],
    receivedDateTime: input.received,
    bodyPreview: input.preview,
    body: { contentType: input.contentType, content: input.content },
    isRead: false,
    hasAttachments: false,
    parentFolderId: "inbox",
  };
}

async function runSyncChild(): Promise<void> {
  const port = Number(process.env.SEER_HTML_STALL_PORT);
  const accountId = asAccountId(process.env.SEER_HTML_STALL_ACCOUNT ?? "");
  const pool = new Pool({
    host: "localhost",
    port,
    user: "postgres",
    password: "postgres",
    database: "seer_test",
  });
  setPoolForTesting(pool);
  const poisonHtml = "<".repeat(80_000);
  const safeHtml = "<p>Newer mail arrived.</p>";
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/mailFolders/inbox/messages?") && !url.includes("$filter=")) {
      return jsonResponse({
        "@odata.count": 4,
        "@odata.nextLink": NEXT_PAGE,
        value: [
          { id: "poison-1", conversationId: "conv-poison", receivedDateTime: "2026-11-19T08:00:00Z" },
          { id: "safe-1", conversationId: "conv-safe", receivedDateTime: "2026-11-19T08:05:00Z" },
        ],
      });
    }
    if (url.includes("conv-poison")) {
      return jsonResponse({
        value: [
          graphMessage({
            id: "poison-1",
            conversationId: "conv-poison",
            received: "2026-11-19T08:00:00Z",
            subject: "notes",
            preview: "notes",
            contentType: "html",
            content: poisonHtml,
          }),
        ],
      });
    }
    if (url.includes("conv-safe")) {
      return jsonResponse({
        value: [
          graphMessage({
            id: "safe-1",
            conversationId: "conv-safe",
            received: "2026-11-19T08:05:00Z",
            subject: "newer",
            preview: "Newer mail arrived.",
            contentType: "HTML",
            content: safeHtml,
          }),
        ],
      });
    }
    throw new Error(`unexpected Graph request ${url}`);
  }) as typeof fetch;

  try {
    const provider = new OutlookProvider({
      accessToken: "test-token",
      accountEmail: "stall@example.com",
      fetchImpl,
    });
    await syncFolder(accountId, provider, "inbox", "incremental", {
      maxPages: 1,
      deadlineMs: Date.now() + 240_000,
    });
  } finally {
    setPoolForTesting(null);
    await pool.end();
  }
}

if (process.env.SEER_HTML_STALL_CHILD === "1") {
  await runSyncChild();
} else {
  const failures: string[] = [];
  const record = (error: unknown) => {
    failures.push(error instanceof Error ? error.message : String(error));
  };

  try {
    await gmailDeliversHtmlOnly();
  } catch (error) {
    record(error);
  }
  try {
    await outlookDeliversHtmlOnly();
  } catch (error) {
    record(error);
  }
  failures.push(...hostileBodyFailures());

  let observation: SyncObservation | null = null;
  try {
    observation = await observeStalledSync();
    assert.equal(
      observation.finished,
      true,
      `sync did not finish within ${SYNC_BUDGET_MS}ms (signal ${observation.signal ?? "none"}). ` +
        `safe body stored: ${observation.safeText === null ? "no" : "yes"}. ` +
        `cursor: ${observation.cursor === null ? "null" : observation.cursor}. ` +
        `stderr: ${observation.stderr.slice(0, 400)}`,
    );
    assert.equal(
      observation.safeText?.includes("Newer mail arrived."),
      true,
      "the newer HTML message on the same page must be stored",
    );
    assert.equal(
      observation.cursor,
      NEXT_PAGE,
      "the folder cursor must advance past a page that contained the hostile message",
    );
    assert.equal(observation.backfillComplete, false);
  } catch (error) {
    record(error);
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n---\n"));
  }
  console.log("v2-html-sync-stall: OK");
}
