/**
 * Gate: filing mail into Atlas that Seer has already filed.
 *
 * The AI reader links every conversation it promotes to a matter, so the mail
 * offered for filing in Triage is usually linked already. Adding it to Atlas by
 * hand then inserted a link that was already there; `on conflict do nothing`
 * reports no rows, that was read as "does not belong to this account", and the
 * throw reached the browser as a 500 with no body — the reported
 * "Add to Atlas was not queued … Unexpected end of JSON input", on mail sitting
 * in the inbox that never moved.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { linkConversationToMatter } from "../src/lib/v2/intelligence/repository.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";

const db = await startTestDb();
try {
  const userId = await upsertUser("refile@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "refile@example.com",
  });

  let seeded = 0;
  const seedInboxMail = async (subject: string, from: string, body: string) => {
    seeded += 1;
    const conversation = await db.pool.query<{ id: string }>(
      `insert into seer.conversations
         (account_id, provider_conversation_id, subject, last_message_at,
          folders, is_unread)
       values ($1, $2, $3, now(), array['inbox']::text[], true)
       returning id`,
      [accountId, `provider-refile-${seeded}`, subject],
    );
    const conversationId = asConversationId(conversation.rows[0].id);
    await db.pool.query(
      `insert into seer.messages
         (account_id, conversation_id, provider_message_id, from_email, to_emails,
          sent_at, snippet, body_text, is_unread, is_outgoing)
       values ($1, $2, $3, $4, array['refile@example.com'], now(), $5, $5,
               true, false)`,
      [accountId, conversationId, `message-refile-${seeded}`, from, body],
    );
    return conversationId;
  };

  const ctx = { accountId: accountId as AccountId };
  let key = 0;
  const addToAtlas = (conversationId: string, matterId?: string) =>
    executeCommand(
      ctx,
      {
        type: "triageConversation",
        conversationId,
        destination: "matter",
        matterId: matterId ?? null,
      },
      `refile-key-${key++}`,
    );

  const linksFor = async (conversationId: string) =>
    (
      await db.pool.query<{ matter_id: string; link_source: string }>(
        `select matter_id, link_source
           from seer.matter_conversations
          where conversation_id = $1`,
        [conversationId],
      )
    ).rows;

  // The mail the reader already promoted, filed by hand onto that same matter.
  const promoted = await seedInboxMail(
    "RD007704 stability extension",
    "sandra@roche.com",
    "Please countersign the RD007704 amendment",
  );
  const matter = await db.pool.query<{ id: string }>(
    `insert into seer.matters (account_id, title, org_unit)
     values ($1, 'Roche RD007704 stability extension', 'roche') returning id`,
    [accountId],
  );
  const matterId = matter.rows[0].id;
  await linkConversationToMatter(accountId, matterId, promoted);

  const filed = await addToAtlas(promoted, matterId);
  assert.equal(filed.ok, true, filed.error);
  assert.deepEqual((filed.detail as { matterId?: string } | undefined)?.matterId, matterId);

  const promotedLinks = await linksFor(promoted);
  assert.equal(promotedLinks.length, 1, "the conversation is on one matter");
  assert.equal(promotedLinks[0].matter_id, matterId);
  assert.equal(
    promotedLinks[0].link_source,
    "user",
    "the person outranks the sweep that guessed the same",
  );

  // Nor is a later sweep allowed to demote what the user decided.
  await linkConversationToMatter(accountId, matterId, promoted, "inferred");
  assert.equal((await linksFor(promoted))[0].link_source, "user");

  // Filing the same conversation twice with no matter named keeps it where it
  // is. It used to read the note left by the first filing as the summary and
  // name a second concern after it.
  const twice = await seedInboxMail(
    "Hiring plan approval",
    "hr@acme.com",
    "Please approve the hiring plan",
  );
  const first = await addToAtlas(twice);
  assert.equal(first.ok, true, first.error);
  const second = await addToAtlas(twice);
  assert.equal(second.ok, true, second.error);
  const firstMatter = (first.detail as { matterId?: string } | undefined)?.matterId;
  assert.equal(
    (second.detail as { matterId?: string } | undefined)?.matterId,
    firstMatter,
    "the same mail does not become two concerns",
  );
  assert.deepEqual(
    (await linksFor(twice)).map((link) => link.matter_id),
    [firstMatter],
  );
  const matterCount = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.matters where account_id = $1",
    [accountId],
  );
  assert.equal(matterCount.rows[0].n, 2, "one concern per piece of work");

  // What the whiteboard reads on a filed conversation is a sentence.
  const decision = await db.pool.query<{ summary: string; matter_id: string }>(
    `select summary, matter_id from seer.conversation_decisions
      where account_id = $1 and conversation_id = $2 and is_current`,
    [accountId, twice],
  );
  assert.equal(decision.rows[0].summary, "Filed by you in Triage");
  assert.equal(decision.rows[0].matter_id, firstMatter);

  // Choosing a different matter moves it rather than filing it in both.
  const moved = await db.pool.query<{ id: string }>(
    `insert into seer.matters (account_id, title) values ($1, 'Somewhere else')
     returning id`,
    [accountId],
  );
  const movedOn = await addToAtlas(twice, moved.rows[0].id);
  assert.equal(movedOn.ok, true, movedOn.error);
  assert.deepEqual(
    (await linksFor(twice)).map((link) => link.matter_id),
    [moved.rows[0].id],
    "a conversation has one home",
  );

  console.log("atlas-refile: OK");
} finally {
  await db.stop();
}
