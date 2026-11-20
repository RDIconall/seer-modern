/**
 * Spec: a message with no text part and no HTML part must not pin the read
 * queue. Sync stores whatever the provider adapter returns. The scheduled read
 * (readBatch, used by the read cron via runReadAccount and by wakeAccount)
 * orders inbox threads newest-first. A body-less thread has to leave that
 * batch — by a persisted decision, including undecided, or by the model-usage
 * backoff — so the next tick can classify older mail that does have a body.
 *
 * These assertions fail while the reader throws before any model call and
 * before any decision or usage row. They pass once a missing body is classified
 * from the subject and snippet, or an undecided decision / usage row makes the
 * queue backoff apply.
 *
 * runShadow shares the same completeness refusal and must keep classifying the
 * rest of the mailbox when one stored message has no body.
 */
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import type { AccountId } from "../src/lib/v2/db/types.ts";
import { conversationsNeedingRead } from "../src/lib/v2/intelligence/queue.ts";
import { readBatch } from "../src/lib/v2/intelligence/read-batch.ts";
import type { ReaderModel } from "../src/lib/v2/intelligence/reader.ts";
import type { ReadResult } from "../src/lib/v2/intelligence/schema.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import type { MailProvider } from "../src/lib/v2/providers/types.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { runShadow } from "../src/lib/v2/shadow/run.ts";

const SELF = "me@example.com";
const NEWER = "2099-11-20T12:00:00.000Z";
const OLDER = "2020-01-01T00:00:00.000Z";
const PRIOR = "2026-06-01T00:00:00.000Z";

const archive: ReadResult = {
  home: "record",
  summary: "Reference email",
  rationale: "No live work; worth retaining",
  owner: "nobody",
  ask: "nothing — informational",
  obligation: false,
  yields: [],
  evidence: [],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

type StoredBody = {
  provider_conversation_id: string;
  provider_message_id: string;
  body_html: string | null;
  body_text: string | null;
  snippet: string | null;
};

async function storedBodies(pool: Pool, accountId: AccountId): Promise<StoredBody[]> {
  const rows = await pool.query<StoredBody>(
    `select c.provider_conversation_id, m.provider_message_id,
            m.body_html, m.body_text, m.snippet
       from seer.messages m
       join seer.conversations c on c.id = m.conversation_id
      where m.account_id = $1
      order by c.provider_conversation_id, m.sent_at`,
    [accountId],
  );
  return rows.rows;
}

async function conversationId(
  pool: Pool,
  accountId: AccountId,
  providerId: string,
): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `select id from seer.conversations
      where account_id = $1 and provider_conversation_id = $2`,
    [accountId, providerId],
  );
  assert.equal(row.rowCount, 1, `synced conversation ${providerId} must be stored`);
  return row.rows[0].id;
}

/**
 * Deliver the attacker's mail through the real provider adapter and sync
 * engine, then require the newest body-less threads to release every slot of
 * the read batch before the next tick.
 */
async function assertBodylessMailDoesNotStarveTheInbox(
  pool: Pool,
  accountId: AccountId,
  provider: MailProvider,
  deliverPoison: () => void,
  poisonIds: string[],
  olderProviderId: string,
): Promise<void> {
  const seen: string[] = [];
  const model: ReaderModel = async (input) => {
    seen.push(input.conversation.providerConversationId);
    return archive;
  };

  await syncFolder(accountId, provider, "inbox", "full");
  const baseline = await readBatch(accountId, SELF, model, {
    limit: 5,
    concurrency: 1,
  });
  assert.equal(
    baseline.decided,
    1,
    "the earlier complete thread must be classified before new mail arrives",
  );
  assert.deepEqual(seen, ["reopen"]);
  seen.length = 0;

  deliverPoison();
  await syncFolder(accountId, provider, "inbox", "incremental");

  const bodies = await storedBodies(pool, accountId);
  const olderId = await conversationId(pool, accountId, olderProviderId);
  const poisonRowIds = [];
  for (const providerId of poisonIds) {
    poisonRowIds.push(await conversationId(pool, accountId, providerId));
  }

  const before = await conversationsNeedingRead(accountId, poisonIds.length);
  assert.deepEqual(
    new Set(before.map(String)),
    new Set(poisonRowIds.map(String)),
    `newest body-less threads must be the whole read batch; stored=${JSON.stringify(bodies)}`,
  );

  const first = await readBatch(accountId, SELF, model, {
    limit: poisonIds.length,
    concurrency: 1,
  });
  assert.equal(first.attempted, poisonIds.length);

  const released = await conversationsNeedingRead(accountId, poisonIds.length);
  assert.ok(
    released.map(String).includes(olderId),
    `body-less threads were selected again and kept ${olderProviderId} out of the next read batch ` +
      `(queued=${released.join(",")}, modelSaw=${seen.join(",")}, stored=${JSON.stringify(bodies)})`,
  );

  await readBatch(accountId, SELF, model, {
    limit: poisonIds.length,
    concurrency: 1,
  });
  const decision = await pool.query<{ home: string }>(
    `select home from seer.conversation_decisions
      where conversation_id = $1 and is_current`,
    [olderId],
  );
  assert.equal(
    decision.rows[0]?.home,
    "record",
    "older mail with a body must be classified on the next tick once body-less threads release their slots",
  );
  assert.ok(
    seen.includes(olderProviderId),
    "the reader model must actually classify the older thread",
  );
}

type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { size?: number; data?: string; attachmentId?: string };
  headers?: { name: string; value: string }[];
  parts?: GmailPart[];
};

function gmailMessage(
  id: string,
  when: string,
  subject: string,
  payload: GmailPart,
  snippet: string,
) {
  return {
    id,
    threadId: id.split("-")[0],
    snippet,
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(Date.parse(when)),
    payload: {
      ...payload,
      headers: [
        { name: "From", value: "attacker@example.com" },
        { name: "To", value: SELF },
        { name: "Subject", value: subject },
        ...(payload.headers ?? []),
      ],
    },
  };
}

function gmailText(id: string, when: string, subject: string, body: string) {
  return gmailMessage(
    id,
    when,
    subject,
    {
      mimeType: "text/plain",
      body: { size: body.length, data: b64url(body) },
    },
    body.slice(0, 40),
  );
}

function gmailAttachment(id: string, when: string, subject: string, snippet: string) {
  return gmailMessage(
    id,
    when,
    subject,
    {
      mimeType: "application/pdf",
      filename: "invoice.pdf",
      body: { attachmentId: `${id}-file`, size: 1200 },
    },
    snippet,
  );
}

function createGmailProvider(): { provider: GmailProvider; poison: () => void } {
  let poisoned = false;
  const threads = () => {
    const reopen = [
      gmailText("reopen-m1", PRIOR, "Contract draft", "Please review the attached draft."),
    ];
    if (poisoned) {
      reopen.push(
        gmailAttachment("reopen-m2", NEWER, "Contract draft", "Signed copy attached"),
      );
    }
    const all: Record<string, { id: string; messages: ReturnType<typeof gmailMessage>[] }> = {
      reopen: { id: "reopen", messages: reopen },
    };
    if (poisoned) {
      all.attach = {
        id: "attach",
        messages: [
          gmailAttachment("attach-m1", NEWER, "Invoice attached", "Invoice attached"),
        ],
      };
      all.nopart = {
        id: "nopart",
        messages: [
          gmailMessage(
            "nopart-m1",
            NEWER,
            "Empty text part",
            { mimeType: "text/plain", body: { size: 0 } },
            "No text part was included",
          ),
        ],
      };
      all.mixed = {
        id: "mixed",
        messages: [
          gmailText("mixed-m1", PRIOR, "Thread with a file", "First note has a body."),
          gmailAttachment("mixed-m2", NEWER, "Thread with a file", "File follows"),
        ],
      };
      all.older = {
        id: "older",
        messages: [
          gmailText(
            "older-m1",
            OLDER,
            "Older actionable mail",
            "Please file this older thread.",
          ),
        ],
      };
    }
    return all;
  };

  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes("/threads?") && !u.includes("/threads/")) {
      const ids = Object.keys(threads());
      return json({
        threads: ids.map((id) => ({ id })),
        resultSizeEstimate: ids.length,
      });
    }
    const threadGet = u.match(/\/threads\/([^?]+)/);
    if (threadGet) {
      const id = decodeURIComponent(threadGet[1]);
      const thread = threads()[id];
      if (!thread) return new Response("not found", { status: 404 });
      return json(thread);
    }
    throw new Error(`unexpected gmail request ${u}`);
  }) as typeof fetch;

  return {
    provider: new GmailProvider({
      accessToken: "placeholder",
      accountEmail: SELF,
      fetchImpl,
      pageSize: 20,
    }),
    poison: () => {
      poisoned = true;
    },
  };
}

type GraphMessage = {
  id: string;
  conversationId: string;
  subject: string;
  from: { emailAddress: { address: string } };
  toRecipients: { emailAddress: { address: string } }[];
  receivedDateTime: string;
  bodyPreview: string;
  body?: { contentType: string; content: string };
  isRead: boolean;
  hasAttachments: boolean;
  attachments?: { id: string; name: string; contentType: string; size: number }[];
};

function graphMessage(
  id: string,
  conversationId: string,
  when: string,
  subject: string,
  preview: string,
  body: GraphMessage["body"] | undefined,
  attachment: boolean,
): GraphMessage {
  return {
    id,
    conversationId,
    subject,
    from: { emailAddress: { address: "attacker@example.com" } },
    toRecipients: [{ emailAddress: { address: SELF } }],
    receivedDateTime: when,
    bodyPreview: preview,
    ...(body ? { body } : {}),
    isRead: false,
    hasAttachments: attachment,
    ...(attachment
      ? {
          attachments: [
            {
              id: `${id}-file`,
              name: "invoice.pdf",
              contentType: "application/pdf",
              size: 1200,
            },
          ],
        }
      : {}),
  };
}

function createOutlookProvider(): { provider: OutlookProvider; poison: () => void } {
  let poisoned = false;
  const conversations = () => {
    const reopen = [
      graphMessage(
        "reopen-m1",
        "reopen",
        PRIOR,
        "Contract draft",
        "Please review the attached draft.",
        { contentType: "text", content: "Please review the attached draft." },
        false,
      ),
    ];
    if (poisoned) {
      reopen.push(
        graphMessage(
          "reopen-m2",
          "reopen",
          NEWER,
          "Contract draft",
          "Signed copy attached",
          undefined,
          true,
        ),
      );
    }
    const all: Record<string, GraphMessage[]> = { reopen };
    if (poisoned) {
      all.omitted = [
        graphMessage(
          "omitted-m1",
          "omitted",
          NEWER,
          "Attachment only",
          "See attached",
          undefined,
          true,
        ),
      ];
      all.emptytext = [
        graphMessage(
          "emptytext-m1",
          "emptytext",
          NEWER,
          "Empty text body",
          "Empty text body",
          { contentType: "text", content: "" },
          true,
        ),
      ];
      all.emptyhtml = [
        graphMessage(
          "emptyhtml-m1",
          "emptyhtml",
          NEWER,
          "Empty html body",
          "Empty html body",
          { contentType: "html", content: "" },
          true,
        ),
      ];
      all.mixed = [
        graphMessage(
          "mixed-m1",
          "mixed",
          PRIOR,
          "Thread with a file",
          "First note has a body.",
          { contentType: "html", content: "<p>First note has a body.</p>" },
          false,
        ),
        graphMessage(
          "mixed-m2",
          "mixed",
          NEWER,
          "Thread with a file",
          "File follows",
          { contentType: "text", content: "" },
          true,
        ),
      ];
      all.older = [
        graphMessage(
          "older-m1",
          "older",
          OLDER,
          "Older actionable mail",
          "Please file this older thread.",
          { contentType: "text", content: "Please file this older thread." },
          false,
        ),
      ];
    }
    return all;
  };

  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes("/mailFolders/inbox/messages")) {
      const convos = conversations();
      const value = Object.values(convos).map((messages) => messages[messages.length - 1]);
      return json({ value, "@odata.count": value.length });
    }
    if (u.includes("/messages?") && u.includes("conversationId")) {
      const filter = new URL(u).searchParams.get("$filter") ?? "";
      const id = filter.match(/conversationId eq '([^']+)'/)?.[1];
      const messages = id ? conversations()[id] : undefined;
      if (!messages) return json({ value: [] });
      return json({ value: messages });
    }
    throw new Error(`unexpected outlook request ${u}`);
  }) as typeof fetch;

  return {
    provider: new OutlookProvider({
      accessToken: "placeholder",
      accountEmail: SELF,
      fetchImpl,
      pageSize: 20,
    }),
    poison: () => {
      poisoned = true;
    },
  };
}

function createShadowGmail(): GmailProvider {
  const threads: Record<string, { id: string; messages: ReturnType<typeof gmailMessage>[] }> = {
    attach: {
      id: "attach",
      messages: [gmailAttachment("attach-m1", NEWER, "Invoice attached", "Invoice attached")],
    },
    older: {
      id: "older",
      messages: [
        gmailText("older-m1", OLDER, "Older actionable mail", "Please file this older thread."),
      ],
    },
  };
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes("/threads?") && !u.includes("/threads/")) {
      return json({
        threads: Object.keys(threads).map((id) => ({ id })),
        resultSizeEstimate: Object.keys(threads).length,
      });
    }
    const threadGet = u.match(/\/threads\/([^?]+)/);
    if (threadGet) {
      const thread = threads[decodeURIComponent(threadGet[1])];
      if (!thread) return new Response("not found", { status: 404 });
      return json(thread);
    }
    throw new Error(`unexpected gmail request ${u}`);
  }) as typeof fetch;
  return new GmailProvider({
    accessToken: "placeholder",
    accountEmail: SELF,
    fetchImpl,
    pageSize: 20,
  });
}

const db = await startTestDb();
try {
  const userId = await upsertUser(SELF);

  const gmailAccount = await upsertAccount({
    userId,
    provider: "google",
    email: "gmail-dos@example.com",
  });
  const gmail = createGmailProvider();
  await assertBodylessMailDoesNotStarveTheInbox(
    db.pool,
    gmailAccount,
    gmail.provider,
    gmail.poison,
    ["reopen", "attach", "nopart", "mixed"],
    "older",
  );

  const outlookAccount = await upsertAccount({
    userId,
    provider: "microsoft",
    email: "outlook-dos@example.com",
  });
  const outlook = createOutlookProvider();
  await assertBodylessMailDoesNotStarveTheInbox(
    db.pool,
    outlookAccount,
    outlook.provider,
    outlook.poison,
    ["reopen", "omitted", "emptytext", "emptyhtml", "mixed"],
    "older",
  );

  const shadowAccount = await upsertAccount({
    userId,
    provider: "google",
    email: "shadow-dos@example.com",
  });
  await syncFolder(shadowAccount, createShadowGmail(), "inbox", "full");
  const shadowSeen: string[] = [];
  let shadowError: unknown = null;
  try {
    await runShadow({
      accountId: shadowAccount,
      account: "shadow-dos@example.com",
      model: async (input) => {
        shadowSeen.push(input.conversation.providerConversationId);
        return archive;
      },
      context: {
        ownDomain: "example.com",
        ownEmail: SELF,
        people: [],
        matters: [],
        interests: [],
        placements: [],
      },
      benchmark: null,
      providerParityPassed: true,
    });
  } catch (error) {
    shadowError = error;
  }
  assert.equal(
    shadowError,
    null,
    `a body-less message must not abort the shadow read of the rest of the mailbox: ${shadowError instanceof Error ? shadowError.message : String(shadowError)}`,
  );
  const shadowOlder = await conversationId(db.pool, shadowAccount, "older");
  const shadowDecision = await db.pool.query<{ home: string }>(
    `select home from seer.conversation_decisions
      where conversation_id = $1 and is_current`,
    [shadowOlder],
  );
  assert.equal(
    shadowDecision.rows[0]?.home,
    "record",
    "a body-less thread must not abort classification of the rest of the mailbox",
  );
  assert.ok(
    shadowSeen.includes("older"),
    "shadow must classify the thread that has a body",
  );

  console.log("v2-empty-body-read-dos: OK");
} finally {
  await db.stop();
}
