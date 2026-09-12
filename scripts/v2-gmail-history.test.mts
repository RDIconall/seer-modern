import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { asAccountId } from "../src/lib/v2/db/types.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import {
  getPushSubscription,
  upsertPushSubscription,
} from "../src/lib/v2/push/repository.ts";
import { historyCursorAfterWatch } from "../src/lib/v2/push/gmail-watch.ts";
import { syncGmailOnWake } from "../src/lib/v2/sync/gmail-history.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function message(
  id: string,
  threadId: string,
  labelIds: string[],
  sentAt: number,
) {
  return {
    id,
    threadId,
    labelIds,
    internalDate: String(sentAt),
    snippet: id,
    payload: {
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "me@example.com" },
        { name: "Subject", value: `Subject ${threadId}` },
      ],
      mimeType: "text/plain",
      body: {
        data: Buffer.from(`body ${id}`).toString("base64url"),
      },
    },
  };
}

assert.equal(
  historyCursorAfterWatch("processed-100", "watch-200"),
  "processed-100",
  "watch renewal must not skip unprocessed mailbox history",
);
assert.equal(historyCursorAfterWatch(null, "watch-200"), "watch-200");

const calls: string[] = [];
const historyFetch = (async (url: string) => {
  const value = String(url);
  calls.push(value);
  const parsed = new URL(value);
  if (parsed.pathname.endsWith("/history")) {
    if (!parsed.searchParams.get("pageToken")) {
      assert.equal(parsed.searchParams.get("startHistoryId"), "100");
      return json({
        history: [
          {
            messagesAdded: [
              { message: { id: "new-m1", threadId: "new-thread" } },
            ],
            labelsRemoved: [
              {
                message: { id: "old-m1", threadId: "archived-thread" },
                labelIds: ["INBOX"],
              },
            ],
          },
          {
            messagesAdded: [
              { message: { id: "new-m2", threadId: "new-thread" } },
            ],
            messagesDeleted: [
              { message: { id: "gone-m1", threadId: "deleted-thread" } },
            ],
          },
        ],
        nextPageToken: "page-2",
      });
    }
    return json({
      history: [
        {
          labelsAdded: [
            {
              message: { id: "second-m1", threadId: "second-thread" },
              labelIds: ["INBOX"],
            },
          ],
        },
      ],
      historyId: "200",
    });
  }
  if (parsed.pathname.endsWith("/threads/new-thread")) {
    return json({
      id: "new-thread",
      messages: [
        message("new-m1", "new-thread", ["INBOX"], 1_700_000_000_000),
        message("new-m2", "new-thread", ["INBOX"], 1_700_000_001_000),
      ],
    });
  }
  if (parsed.pathname.endsWith("/threads/second-thread")) {
    return json({
      id: "second-thread",
      messages: [
        message("second-m1", "second-thread", ["INBOX"], 1_700_000_002_000),
      ],
    });
  }
  if (parsed.pathname.endsWith("/threads/archived-thread")) {
    return json({
      id: "archived-thread",
      messages: [
        message("old-m1", "archived-thread", ["SENT"], 1_699_999_999_000),
      ],
    });
  }
  if (parsed.pathname.endsWith("/threads/deleted-thread")) {
    return json({ error: { message: "not found" } }, 404);
  }
  throw new Error(`unexpected request: ${value}`);
}) as unknown as typeof fetch;

const db = await startTestDb();
try {
  const userId = await upsertUser("gmail-history@example.com");
  const accountId = asAccountId(
    await upsertAccount({
      userId,
      provider: "google",
      email: "gmail-history@example.com",
    }),
  );
  await upsertPushSubscription(accountId, "google", {
    gmailHistoryId: "100",
  });

  const provider = new GmailProvider({
    accessToken: "test-token",
    accountEmail: "gmail-history@example.com",
    fetchImpl: historyFetch,
  });
  const report = await syncGmailOnWake(accountId, provider);
  assert.equal(report.mode, "history");
  assert.equal(report.stored, 2);
  assert.deepEqual(report.removed.sort(), [
    "archived-thread",
    "deleted-thread",
  ]);

  const stored = await db.pool.query<{
    provider_conversation_id: string;
    folders: string[];
  }>(
    `select provider_conversation_id, folders
       from seer.conversations
      where account_id = $1
      order by provider_conversation_id`,
    [accountId],
  );
  assert.deepEqual(
    stored.rows.map((row) => row.provider_conversation_id),
    ["new-thread", "second-thread"],
  );
  assert.ok(stored.rows.every((row) => row.folders.includes("inbox")));
  assert.equal((await getPushSubscription(accountId))?.gmailHistoryId, "200");
  assert.equal(
    calls.filter((call) => call.includes("/threads/new-thread?")).length,
    1,
    "duplicate history records must hydrate a changed thread once",
  );

  const expiredUser = await upsertUser("gmail-history-expired@example.com");
  const expiredAccount = asAccountId(
    await upsertAccount({
      userId: expiredUser,
      provider: "google",
      email: "gmail-history-expired@example.com",
    }),
  );
  await upsertPushSubscription(expiredAccount, "google", {
    gmailHistoryId: "expired",
  });
  const fallbackCalls: string[] = [];
  const expiredFetch = (async (url: string) => {
    const value = String(url);
    fallbackCalls.push(value);
    if (value.includes("/history?")) {
      return json({ error: { message: "historyId too old" } }, 404);
    }
    if (value.includes("/threads?")) {
      return json({
        threads: [{ id: "fallback-thread" }],
        resultSizeEstimate: 1,
      });
    }
    if (value.includes("/threads/fallback-thread?format=full")) {
      return json({
        id: "fallback-thread",
        messages: [
          message(
            "fallback-m1",
            "fallback-thread",
            ["INBOX"],
            1_700_000_003_000,
          ),
        ],
      });
    }
    if (value.endsWith("/profile")) {
      return json({ historyId: "300" });
    }
    throw new Error(`unexpected fallback request: ${value}`);
  }) as unknown as typeof fetch;
  const expiredProvider = new GmailProvider({
    accessToken: "test-token",
    accountEmail: "gmail-history-expired@example.com",
    fetchImpl: expiredFetch,
  });
  const fallback = await syncGmailOnWake(expiredAccount, expiredProvider);
  assert.equal(fallback.mode, "head");
  assert.equal((await getPushSubscription(expiredAccount))?.gmailHistoryId, "300");
  assert.ok(fallbackCalls.some((call) => call.includes("/threads?")));
} finally {
  await db.stop();
}

console.log("v2-gmail-history: OK");
