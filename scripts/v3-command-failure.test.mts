/**
 * Gate: a command that cannot be carried out says why.
 *
 * "Add to Atlas was not queued. The message is back in the list. Failed to
 * execute 'json' on 'Response': Unexpected end of JSON input" is what the user
 * saw when filing an email failed. Two faults met: the command route let a
 * throw become a bodiless 500, and the client called `response.json()` on that
 * empty body, so the parser's complaint replaced the reason.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import {
  describeHttpFailure,
  readJsonBody,
} from "../src/lib/v3/net/json.ts";
import { dispatchCommand } from "../src/components/v3/compose-command.ts";
import { noticeForCommands } from "../src/components/v3/MailClient.tsx";

// A body that is not there reads as absence, not as an exception.
assert.equal(await readJsonBody(new Response(null, { status: 500 })), null);
assert.equal(await readJsonBody(new Response("", { status: 502 })), null);
assert.equal(
  await readJsonBody(new Response("<html>gateway timeout</html>", { status: 504 })),
  null,
);
assert.deepEqual(
  await readJsonBody<{ ok: boolean }>(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ),
  { ok: true },
);

for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) {
  const described = describeHttpFailure(status);
  assert.match(described, new RegExp(String(status)), "the status is reportable");
  assert.doesNotMatch(described, /JSON/i, "no parser talk reaches the user");
}
assert.match(describeHttpFailure(401), /sign in again/i);

// The client turns a silent server into a sentence about the server.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(null, { status: 500 });
try {
  await assert.rejects(
    dispatchCommand({ type: "archive", conversationId: "c1" }),
    (error: Error) => {
      assert.match(error.message, /500/);
      assert.doesNotMatch(error.message, /JSON/i);
      return true;
    },
  );
} finally {
  globalThis.fetch = realFetch;
}

const mailbox = await readFile("src/components/v3/useMailbox.ts", "utf8");
assert.match(
  mailbox,
  /readJsonBody<\{ result\?: CommandResult; error\?: string \}>/,
  "the command bus client never parses a body that may not be there",
);

const route = await readFile("src/app/api/v2/commands/route.ts", "utf8");
assert.match(
  route,
  /catch \(cause\)[\s\S]*?console\.error\("v2 command failed"[\s\S]*?ok: false/,
  "a throw inside a command answers with a result, not an empty 500",
);

// The notice the user reads carries the reason through unchanged.
const notice = noticeForCommands(
  [
    {
      type: "triageConversation",
      conversationId: "c1",
      destination: "matter",
    },
  ],
  [
    {
      ok: false,
      replayed: false,
      error: "that matter is no longer open — pick another or make a new one",
    },
  ],
);
assert.equal(notice.error, true);
assert.match(notice.message, /Add to Atlas was not queued/);
assert.match(notice.message, /no longer open/);

const db = await startTestDb();
try {
  const userId = await upsertUser("filing@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "filing@example.com",
  });

  const seed = async (folders: string[], deleted = false) => {
    const conversation = await db.pool.query<{ id: string }>(
      `insert into seer.conversations
         (account_id, provider_conversation_id, subject, last_message_at,
          folders, is_unread, is_deleted)
       values ($1, $2, 'Stability amendment', now(), $3::text[], false, $4)
       returning id`,
      [accountId, `provider-${Math.random().toString(36).slice(2)}`, folders, deleted],
    );
    return asConversationId(conversation.rows[0].id);
  };

  const ctx = { accountId: accountId as AccountId };
  let key = 0;
  const file = (conversationId: string, matterId?: string, title?: string) =>
    executeCommand(
      ctx,
      {
        type: "triageConversation",
        conversationId,
        destination: "matter",
        matterId: matterId ?? null,
        matterTitle: title ?? null,
        createMatter: Boolean(title),
      },
      `filing-key-${key++}`,
    );

  // Filing ordinary inbox mail still works, and names the matter it landed on.
  const inboxConversation = await seed(["inbox"]);
  const filed = await file(inboxConversation, undefined, "Stability extension");
  assert.equal(filed.ok, true, filed.error);
  assert.equal(
    (filed.detail as { matterTitle?: string } | undefined)?.matterTitle,
    "Stability extension",
  );

  // The mail list paints from its cache, so a row can be filed after a sync has
  // taken the conversation out of the mailbox. That is an answer, not a crash.
  const gone = await seed(["archive"], true);
  const staleRow = await file(gone, undefined, "Filed too late");
  assert.equal(staleRow.ok, false);
  assert.match(staleRow.error ?? "", /conversation not found/);
  assert.match(staleRow.error ?? "", /out of date/);

  // A matter chosen from a stale board, or an id that never was one.
  const closed = await db.pool.query<{ id: string }>(
    `insert into seer.matters (account_id, title, status)
     values ($1, 'Closed concern', 'closed') returning id`,
    [accountId],
  );
  for (const matterId of [closed.rows[0].id, "not-a-uuid"]) {
    const refused = await file(await seed(["inbox"]), matterId);
    assert.equal(refused.ok, false, `matter ${matterId} should be refused`);
    assert.match(refused.error ?? "", /no longer open/);
  }

  // An id that is not an id reads as a missing conversation, not a uuid error.
  const bogus = await file("18f2c0a4b9d3e1f2");
  assert.equal(bogus.ok, false);
  assert.match(bogus.error ?? "", /conversation not found/);
  assert.doesNotMatch(bogus.error ?? "", /uuid/i);

  // Making a matter with no name to give it is refused, not thrown.
  const unnamed = await executeCommand(
    ctx,
    {
      type: "correctConversation",
      conversationId: await seed(["inbox"]),
      home: "matter",
      matterTitle: "   ",
      createMatter: true,
    },
    "filing-key-unnamed",
  );
  assert.equal(unnamed.ok, false);
  assert.match(unnamed.error ?? "", /needs a title/);

  console.log("v3-command-failure: OK");
} finally {
  await db.stop();
}
