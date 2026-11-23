/**
 * Spec for the conversation-reader payload bound.
 *
 * A mailbox correspondent can deliver a Gmail thread (format=full) whose
 * messages the sync engine stores without a body cap. Opening that thread, or
 * hovering a neighboring row, loads every stored body in one response. These
 * tests fail while that is true and pass once each read below stays inside
 * the caps and cannot hold a pooled connection indefinitely.
 *
 * Caps (the contract a fix must meet):
 * - At most READER_RESPONSE_MESSAGE_CAP messages in one result.
 * - At most READER_RESPONSE_BODY_BYTE_CAP bytes of bodyHtml + bodyText.
 * - A non-empty stored thread still returns at least one message, and each
 *   returned body still contains that message's stored marker (a cap may
 *   shorten a body; it may not replace it).
 * - When getCorpusConversation returns fewer messages than are stored,
 *   `omittedMessageCount` on the view equals stored minus returned.
 * - While seer.messages is locked, each read below settles within
 *   READER_QUERY_HOLD_MS and leaves no active body_html query behind. The
 *   timeout has to be on the connection that runs the SELECT: a timeout set
 *   on some other checkout does not cancel this one, and a client-side
 *   read timer that abandons the socket leaves the backend query active.
 *
 * Untested operations that also read message text and are not this response:
 * - src/lib/v2/intelligence/user-matter.ts loads one latest body_text with no
 *   byte cap (limit 1, not the thread reader).
 * - Gmail search and Outlook conversationMessages pull provider bodies during
 *   sync/search. Ingestion is what fills the table; the cap under test is the
 *   later read. Outlook is not given its own sync fixture because the reader
 *   queries seer.messages after either provider has stored a thread.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { getCorpusConversation } from "../src/lib/v3/reader/repository.ts";
import {
  loadConversation,
  loadStoredConversations,
} from "../src/lib/v2/intelligence/load-conversation.ts";
import { readJsonBody } from "../src/lib/v3/net/json.ts";
import type { AccountId } from "../src/lib/v2/db/types.ts";
import type { Conversation } from "../src/lib/v2/providers/types.ts";

const READER_RESPONSE_MESSAGE_CAP = 20;
const READER_RESPONSE_BODY_BYTE_CAP = 256 * 1024;
const READER_QUERY_HOLD_MS = 2_500;

const MANY_ID = "many";
const FAT_ID = "fat";
const SMALL_ID = "small";
const MANY_COUNT = READER_RESPONSE_MESSAGE_CAP + 4;
const MANY_BODY = "M";
const FAT_MARKER = "FAT-BODY-MARKER-";
const FAT_BODY = FAT_MARKER + "B".repeat(300_000);
const SMALL_MARKER = "small-body-";

type BodyCarrier = { bodyHtml: string | null; bodyText: string | null; providerMessageId?: string };

function bodyBytes(messages: BodyCarrier[]): number {
  let total = 0;
  for (const message of messages) {
    total += Buffer.byteLength(message.bodyHtml ?? "", "utf8");
    total += Buffer.byteLength(message.bodyText ?? "", "utf8");
  }
  return total;
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function gmailMessage(id: string, epoch: number, text: string, html: string) {
  return {
    id,
    threadId: id.split("-")[0],
    snippet: "snippet",
    labelIds: ["INBOX"],
    internalDate: String(epoch),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Attacker <attacker@example.com>" },
        { name: "To", value: "victim@example.com" },
        { name: "Subject", value: "Uncapped thread" },
      ],
      parts: [
        { mimeType: "text/plain", body: { size: text.length, data: b64url(text) } },
        { mimeType: "text/html", body: { size: html.length, data: b64url(html) } },
      ],
    },
  };
}

function manyMessages() {
  return Array.from({ length: MANY_COUNT }, (_, index) => {
    const marker = `${MANY_BODY}${index}-`;
    const text = marker + "A".repeat(8_000);
    const html = `<p>${marker}${"C".repeat(8_000)}</p>`;
    return gmailMessage(`many-m${index}`, 1_700_000_000_000 + index * 1000, text, html);
  });
}

const THREADS: Record<string, { id: string; messages: ReturnType<typeof gmailMessage>[] }> = {
  [MANY_ID]: { id: MANY_ID, messages: manyMessages() },
  [FAT_ID]: {
    id: FAT_ID,
    messages: [gmailMessage("fat-m0", 1_700_000_100_000, FAT_BODY, `<p>${FAT_BODY}</p>`)],
  },
  [SMALL_ID]: {
    id: SMALL_ID,
    messages: [
      gmailMessage("small-m0", 1_700_000_200_000, `${SMALL_MARKER}0`, `<p>${SMALL_MARKER}0</p>`),
      gmailMessage("small-m1", 1_700_000_201_000, `${SMALL_MARKER}1`, `<p>${SMALL_MARKER}1</p>`),
    ],
  },
};

const fetchImpl: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("/threads?")) {
    return Response.json({
      threads: [{ id: MANY_ID }, { id: FAT_ID }, { id: SMALL_ID }],
      resultSizeEstimate: 3,
    });
  }
  const threadMatch = url.match(/\/threads\/([^/?]+)/);
  if (threadMatch) {
    const thread = THREADS[decodeURIComponent(threadMatch[1])];
    if (!thread) return new Response("missing thread", { status: 404 });
    return Response.json(thread);
  }
  return new Response("unmocked", { status: 500 });
};

function assertBounded(
  label: string,
  messages: BodyCarrier[],
  storedMarkers: string[],
): void {
  const problems: string[] = [];
  if (messages.length < 1) problems.push(`${label} dropped every message`);
  if (messages.length > READER_RESPONSE_MESSAGE_CAP) {
    problems.push(
      `${label} returned ${messages.length} messages; cap is ${READER_RESPONSE_MESSAGE_CAP}`,
    );
  }
  const bytes = bodyBytes(messages);
  if (bytes > READER_RESPONSE_BODY_BYTE_CAP) {
    problems.push(
      `${label} returned ${bytes} body bytes; cap is ${READER_RESPONSE_BODY_BYTE_CAP}`,
    );
  }
  for (const message of messages) {
    const haystack = `${message.bodyText ?? ""}\n${message.bodyHtml ?? ""}`;
    const matched = storedMarkers.some((marker) => haystack.includes(marker));
    if (!matched) {
      problems.push(`${label} returned a body that does not contain a stored message marker`);
      break;
    }
  }
  assert.equal(problems.length, 0, problems.join("; "));
}

function omittedOf(view: object): number {
  const record = view as { omittedMessageCount?: number; conversation?: { omittedMessageCount?: number } };
  if (typeof record.omittedMessageCount === "number") return record.omittedMessageCount;
  if (typeof record.conversation?.omittedMessageCount === "number") {
    return record.conversation.omittedMessageCount;
  }
  return 0;
}

const failures: string[] = [];

function check(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}

async function checkAsync(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}

const dbh = await startTestDb();
try {
  const userId = await upsertUser("victim@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "victim@example.com",
  });
  const provider = new GmailProvider({
    accessToken: "placeholder",
    accountEmail: "victim@example.com",
    fetchImpl,
  });

  await syncFolder(accountId, provider, "inbox", "full");

  const stored = await dbh.pool.query<{
    provider_conversation_id: string;
    id: string;
    messages: number;
    html_bytes: number;
    text_bytes: number;
  }>(
    `select c.provider_conversation_id, c.id,
            count(m.id)::int as messages,
            coalesce(sum(octet_length(m.body_html)), 0)::int as html_bytes,
            coalesce(sum(octet_length(m.body_text)), 0)::int as text_bytes
       from seer.conversations c
       join seer.messages m on m.conversation_id = c.id
      where c.account_id = $1
      group by c.provider_conversation_id, c.id`,
    [accountId],
  );
  const byProvider = new Map(stored.rows.map((row) => [row.provider_conversation_id, row]));
  const manyRow = byProvider.get(MANY_ID);
  const fatRow = byProvider.get(FAT_ID);
  const smallRow = byProvider.get(SMALL_ID);
  assert.ok(manyRow && fatRow && smallRow, "sync must store each delivered thread");
  assert.equal(manyRow.messages, MANY_COUNT, "sync stored every message in the long thread");
  assert.ok(
    manyRow.html_bytes + manyRow.text_bytes > READER_RESPONSE_BODY_BYTE_CAP,
    "sync stored the long thread's bodies without a byte cap",
  );
  assert.ok(
    fatRow.text_bytes > READER_RESPONSE_BODY_BYTE_CAP,
    "sync stored a single body larger than one reader response may return",
  );

  const manyMarkers = Array.from({ length: MANY_COUNT }, (_, index) => `${MANY_BODY}${index}-`);
  const fatMarkers = [FAT_MARKER];
  const smallMarkers = [`${SMALL_MARKER}0`, `${SMALL_MARKER}1`];

  async function assertReader(id: string, markers: string[], storedCount: number) {
    const view = await getCorpusConversation(accountId, id, "google");
    assert.ok(view, "owning account must be able to open the thread");
    check(() => assertBounded("getCorpusConversation", view.conversation.messages, markers));
    check(() => {
      assert.equal(
        omittedOf(view),
        storedCount - view.conversation.messages.length,
        "getCorpusConversation must report how many stored messages this response left out",
      );
    });

    // Same object the route handler passes to NextResponse.json, which is
    // Response.json underneath. ReaderPane parses it with readJsonBody;
    // hover prefetch parses it with Response.json.
    const payload = {
      conversation: view.conversation,
      nativeUrl: view.nativeUrl,
      provider: "google" as const,
      ownEmail: "victim@example.com",
    };
    const http = Response.json(payload);
    const text = await http.text();
    const viaReader = await readJsonBody<{ conversation: Conversation }>(new Response(text));
    const viaPrefetch = (await new Response(text).json()) as { conversation: Conversation };
    assert.ok(viaReader);
    check(() => assertBounded("reader HTTP body", viaReader.conversation.messages, markers));
    check(() => assertBounded("prefetch HTTP body", viaPrefetch.conversation.messages, markers));
  }

  await checkAsync(async () => {
    const smallView = await getCorpusConversation(accountId, smallRow.id, "google");
    assert.ok(smallView);
    assert.equal(smallView.conversation.messages.length, 2);
    assert.equal(omittedOf(smallView), 0);
    assert.ok(
      smallView.conversation.messages.every((message) =>
        `${message.bodyText ?? ""}`.includes(SMALL_MARKER),
      ),
    );
  });

  await checkAsync(() => assertReader(manyRow.id, manyMarkers, manyRow.messages));
  await checkAsync(() => assertReader(fatRow.id, fatMarkers, fatRow.messages));

  await checkAsync(async () => {
    const loadedMany = await loadConversation(manyRow.id);
    assert.ok(loadedMany);
    assertBounded("loadConversation long thread", loadedMany.messages, manyMarkers);
  });
  await checkAsync(async () => {
    const loadedFat = await loadConversation(fatRow.id);
    assert.ok(loadedFat);
    assertBounded("loadConversation fat message", loadedFat.messages, fatMarkers);
  });

  const shadow = await loadStoredConversations(accountId as AccountId);
  for (const entry of shadow) {
    const row = stored.rows.find((candidate) => candidate.id === entry.conversationId);
    assert.ok(row);
    const markers =
      row.provider_conversation_id === MANY_ID
        ? manyMarkers
        : row.provider_conversation_id === FAT_ID
          ? fatMarkers
          : smallMarkers;
    check(() => {
      assertBounded(
        `loadStoredConversations ${row.provider_conversation_id}`,
        entry.conversation.messages,
        markers,
      );
    });
  }

  const holder = await dbh.pool.connect();
  const pending: Promise<unknown>[] = [];
  try {
    await holder.query("begin");
    await holder.query("lock table seer.messages in access exclusive mode");

    let probeSettled = false;
    const probe = dbh.pool.query("select 1 from seer.messages limit 1").then(
      () => {
        probeSettled = true;
      },
      () => {
        probeSettled = true;
      },
    );
    pending.push(probe);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      probeSettled,
      false,
      "test lock must block a select on seer.messages",
    );

    const reads: { name: string; done: boolean; returnedFull: boolean }[] = [
      { name: "getCorpusConversation", done: false, returnedFull: false },
      { name: "loadConversation", done: false, returnedFull: false },
      { name: "loadStoredConversations", done: false, returnedFull: false },
    ];
    pending.push(
      getCorpusConversation(accountId, manyRow.id, "google").then(
        (view) => {
          reads[0].done = true;
          reads[0].returnedFull = (view?.conversation.messages.length ?? 0) >= MANY_COUNT;
        },
        () => {
          reads[0].done = true;
        },
      ),
      loadConversation(manyRow.id).then(
        (view) => {
          reads[1].done = true;
          reads[1].returnedFull = (view?.messages.length ?? 0) >= MANY_COUNT;
        },
        () => {
          reads[1].done = true;
        },
      ),
      loadStoredConversations(accountId as AccountId).then(
        (rows) => {
          reads[2].done = true;
          const match = rows.find((row) => row.conversationId === manyRow.id);
          reads[2].returnedFull = (match?.conversation.messages.length ?? 0) >= MANY_COUNT;
        },
        () => {
          reads[2].done = true;
        },
      ),
    );

    const deadline = Date.now() + READER_QUERY_HOLD_MS;
    while (Date.now() < deadline && reads.some((read) => !read.done)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const stillRunning = await holder.query<{ n: number }>(
      `select count(*)::int as n
         from pg_stat_activity
        where datname = current_database()
          and state = 'active'
          and query ilike '%body_html%'
          and pid <> pg_backend_pid()`,
    );

    for (const read of reads) {
      check(() => {
        assert.equal(
          read.done,
          true,
          `${read.name} held a pooled connection for more than ${READER_QUERY_HOLD_MS}ms`,
        );
        assert.equal(
          read.returnedFull,
          false,
          `${read.name} returned the whole thread while seer.messages was locked`,
        );
      });
    }
    check(() => {
      assert.equal(
        stillRunning.rows[0].n,
        0,
        `a reader query was still active after the call settled (${stillRunning.rows[0].n} backend statements); the connection was abandoned without cancelling the backend statement`,
      );
    });
  } finally {
    await holder.query("rollback");
    holder.release();
    await Promise.allSettled(pending);
  }

  if (failures.length > 0) {
    throw new Error(failures.map((failure) => `- ${failure}`).join("\n"));
  }
  console.log("v3-reader-unbounded-load: OK");
} finally {
  await dbh.stop();
}
