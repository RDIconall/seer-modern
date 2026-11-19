/**
 * Spec for the seer_bot mailbox boundary.
 *
 * These assertions fail while a login that inherits seer_bot can read or
 * write every connected mailbox. They pass once that login can see only
 * mailboxes an operator listed in seer.bot_account_grants, and once it
 * cannot read message bodies or participants at all.
 *
 * The grant table is the only authorization that counts. A policy that
 * trusts current_setting, current_user, or any other value the bot session
 * can set still fails, and so does a policy of using (true). The bot must
 * not be able to insert its own grant. seer.bots stays a global catalog.
 * OAuth credentials, people, and message DML stay denied.
 */
import assert from "node:assert/strict";
import { Pool, type PoolClient } from "pg";
import { isAllowedOrgEmail } from "../src/lib/auth/org.ts";
import {
  upsertAccountWithCredentials,
  upsertUser,
} from "../src/lib/v2/db/accounts.ts";
import { ensureMatter } from "../src/lib/v2/intelligence/repository.ts";
import { writeConversationPage } from "../src/lib/v2/sync/repository.ts";
import { startTestDb } from "./v2-testdb.mts";

const PLACEHOLDER_PASSWORD = "placeholder";
const ALLOWED_EMAIL = "claire@rditrials.com";
const VICTIM_EMAIL = "jordan@rditrials.com";
const ALLOWED_SUBJECT = "allowed-subject-marker";
const VICTIM_SUBJECT = "victim-subject-marker";
const ALLOWED_BODY = "allowed-body-marker";
const VICTIM_BODY = "victim-body-marker";
const ALLOWED_MATTER = "allowed-matter-marker";
const VICTIM_MATTER = "victim-matter-marker";
const VICTIM_NARRATIVE = "victim-narrative-marker";
const ALLOWED_CHAT = "allowed-chat-marker";
const VICTIM_CHAT = "victim-chat-marker";
const ALLOWED_NOTES = "allowed-notes-marker";
const VICTIM_NOTES = "victim-notes-marker";
const VICTIM_WORDS = "victim-words-marker";
const ALLOWED_EVENT = "allowed-event-marker";
const VICTIM_EVENT = "victim-event-marker";
const ALLOWED_PROPOSAL = "allowed-proposal-marker";
const VICTIM_PROPOSAL = "victim-proposal-marker";
const VICTIM_RATIONALE = "victim-rationale-marker";

const SECRET_MESSAGE_COLUMNS = [
  "body_html",
  "body_text",
  "snippet",
  "from_email",
  "from_name",
  "to_emails",
  "cc_emails",
  "attachment_names",
];

const SCOPED_TABLES = [
  "mail_accounts",
  "conversations",
  "messages",
  "matters",
  "bot_tasks",
  "bot_task_events",
  "bot_messages",
  "triage_proposals",
];

const SESSION_SETTINGS = [
  "seer.account_id",
  "seer.bot_account_id",
  "seer.bot_account_ids",
  "seer.allowed_account_id",
  "app.current_account_id",
  "request.jwt.claim.sub",
];

type SqlClient = Pool | PoolClient;
type QueryResult = {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  code: string;
};

const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

async function query(
  client: SqlClient,
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult> {
  try {
    const result = await client.query(sql, params);
    return {
      rows: result.rows as Array<Record<string, unknown>>,
      rowCount: result.rowCount ?? 0,
      code: "",
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    return { rows: [], rowCount: 0, code };
  }
}

function contains(result: QueryResult, marker: string): boolean {
  return JSON.stringify(result.rows).includes(marker);
}

function denied(result: QueryResult): boolean {
  return result.code === "42501";
}

const db = await startTestDb();
const botPoolRef: { pool: Pool | null } = { pool: null };
try {
  assert.equal(isAllowedOrgEmail(ALLOWED_EMAIL), true);
  assert.equal(isAllowedOrgEmail(VICTIM_EMAIL), true);

  async function connectMailbox(email: string, subject: string, body: string, matter: string) {
    const userId = await upsertUser(email);
    const account = await upsertAccountWithCredentials({
      userId,
      provider: "google",
      email,
      displayName: email,
      accessToken: PLACEHOLDER_PASSWORD,
      refreshToken: PLACEHOLDER_PASSWORD,
      expiresAt: 1_800_000_000,
    });
    const page = await writeConversationPage(
      account.id,
      "inbox",
      [
        {
          providerConversationId: `thread-${email}`,
          subject,
          lastMessageAt: "2026-10-16T12:00:00.000Z",
          messages: [
            {
              providerMessageId: `msg-${email}`,
              from: { email: "sender@example.com", name: "Sender" },
              to: [{ email }],
              cc: [{ email: "cc@example.com" }],
              sentAt: "2026-10-16T12:00:00.000Z",
              snippet: body,
              bodyHtml: `<p>${body}</p>`,
              bodyText: body,
              isUnread: true,
              isOutgoing: false,
              attachments: [{ id: "a1", filename: `${body}.pdf`, mimeType: "application/pdf", sizeBytes: 10 }],
            },
          ],
        },
      ],
      [],
    );
    assert.equal(page.stored, 1, `sync stored ${email}`);
    assert.equal(page.failed, 0, `sync failed ${email}`);
    const matterId = await ensureMatter(account.id, matter);
    await db.pool.query(
      `update seer.matters set narrative = $2, goal = $3 where id = $1`,
      [matterId, matter === VICTIM_MATTER ? VICTIM_NARRATIVE : "allowed-goal", "goal"],
    );
    return account.id;
  }

  const allowedId = await connectMailbox(
    ALLOWED_EMAIL,
    ALLOWED_SUBJECT,
    ALLOWED_BODY,
    ALLOWED_MATTER,
  );
  const victimId = await connectMailbox(
    VICTIM_EMAIL,
    VICTIM_SUBJECT,
    VICTIM_BODY,
    VICTIM_MATTER,
  );

  const bot = await db.pool.query<{ id: string }>(
    "select id from seer.bots where slug = 'chief-of-staff'",
  );
  const botId = bot.rows[0].id;
  const app = await db.pool.connect();
  try {
    await app.query("begin");
    await app.query("set local role seer_app");
    for (const [accountId, notes, chat, proposal, event] of [
      [allowedId, ALLOWED_NOTES, ALLOWED_CHAT, ALLOWED_PROPOSAL, ALLOWED_EVENT],
      [victimId, VICTIM_NOTES, VICTIM_CHAT, VICTIM_PROPOSAL, VICTIM_EVENT],
    ] as const) {
      const task = await app.query<{ id: string }>(
        `insert into seer.bot_tasks
           (account_id, bot_id, title, notes, his_words, source)
         values ($1, $2, $3, $4, $5, 'user')
         returning id`,
        [accountId, botId, `task-${notes}`, notes, accountId === victimId ? VICTIM_WORDS : "allowed-words"],
      );
      await app.query(
        `insert into seer.bot_task_events
           (account_id, task_id, actor, actor_name, kind, body)
         values ($1, $2, 'user', 'Employee', 'note', $3)`,
        [accountId, task.rows[0].id, event],
      );
      await app.query(
        `insert into seer.bot_messages (account_id, bot_id, author, body)
         values ($1, $2, 'user', $3)`,
        [accountId, botId, chat],
      );
      await app.query(
        `insert into seer.triage_proposals
           (account_id, bot_id, subject, sender_email, action, rationale)
         values ($1, $2, $3, 'sender@example.com', 'keep', $4)`,
        [accountId, botId, proposal, accountId === victimId ? VICTIM_RATIONALE : "allowed-rationale"],
      );
    }
    await app.query("commit");
  } finally {
    app.release();
  }

  await db.pool.query(
    `create role seer_bot_connector login inherit nosuperuser nobypassrls
       nocreatedb nocreaterole password '${PLACEHOLDER_PASSWORD}'`,
  );
  await db.pool.query("grant seer_bot to seer_bot_connector");

  const port = await db.pool.query<{ port: number }>("select inet_server_port() as port");
  const database = await db.pool.query<{ name: string }>("select current_database() as name");
  const botPool = new Pool({
    host: "127.0.0.1",
    port: Number(port.rows[0].port),
    user: "seer_bot_connector",
    password: PLACEHOLDER_PASSWORD,
    database: database.rows[0].name,
  });
  botPoolRef.pool = botPool;
  const session = await botPool.connect();
  try {
    const who = await query(
      session,
      `select current_user,
              (select rolsuper from pg_roles where rolname = current_user) as super,
              (select rolbypassrls from pg_roles where rolname = current_user) as bypass,
              (select inherit_option
                 from pg_auth_members
                where roleid = (select oid from pg_roles where rolname = 'seer_bot')
                  and member = (select oid from pg_roles where rolname = current_user)) as inherit`,
    );
    const identity = who.rows[0];
    if (identity?.current_user !== "seer_bot_connector" || identity.super !== false || identity.bypass !== false || identity.inherit !== true) {
      fail(`connector session is not an inheriting non-bypass login: ${JSON.stringify(identity)}`);
    }

    for (const setting of SESSION_SETTINGS) {
      await query(session, "select set_config($1, $2, false)", [setting, victimId]);
    }
    const plantedGrant = await query(
      session,
      "insert into seer.bot_account_grants (account_id) values ($1)",
      [victimId],
    );
    if (plantedGrant.code === "") {
      fail("seer_bot login inserted its own mailbox grant");
    }

    async function readMailbox(label: string): Promise<void> {
      const messages = await query(
        session,
        `select body_html, body_text, snippet, from_email, from_name, to_emails, cc_emails, attachment_names
           from seer.messages`,
      );
      if (contains(messages, VICTIM_BODY) || contains(messages, "sender@example.com") || contains(messages, VICTIM_EMAIL)) {
        fail(`${label} read another mailbox's message body or participants`);
      } else if (messages.code && !denied(messages)) {
        fail(`${label} message read failed unexpectedly (${messages.code})`);
      }
      const joined = await query(
        session,
        `select m.body_text, m.body_html, m.from_email, m.to_emails
           from seer.conversations c
           join seer.messages m on m.conversation_id = c.id`,
      );
      if (contains(joined, VICTIM_BODY)) {
        fail(`${label} read another mailbox body through conversations`);
      } else if (joined.code && !denied(joined)) {
        fail(`${label} joined message read failed unexpectedly (${joined.code})`);
      }
      const conversations = await query(
        session,
        "select account_id, subject from seer.conversations",
      );
      if (contains(conversations, VICTIM_SUBJECT)) {
        fail(`${label} read another mailbox's conversation subject`);
      }
      const accounts = await query(session, "select id, email, display_name from seer.mail_accounts");
      if (contains(accounts, VICTIM_EMAIL)) {
        fail(`${label} read another mailbox's account address`);
      }
      const matters = await query(
        session,
        "select account_id, title, narrative, goal from seer.matters",
      );
      if (contains(matters, VICTIM_MATTER) || contains(matters, VICTIM_NARRATIVE)) {
        fail(`${label} read another mailbox's matter`);
      }
      const tasks = await query(session, "select account_id, notes, his_words, title from seer.bot_tasks");
      if (contains(tasks, VICTIM_NOTES) || contains(tasks, VICTIM_WORDS)) {
        fail(`${label} read another mailbox's task notes`);
      }
      const events = await query(session, "select account_id, body from seer.bot_task_events");
      if (contains(events, VICTIM_EVENT)) {
        fail(`${label} read another mailbox's task events`);
      }
      const chats = await query(session, "select account_id, body from seer.bot_messages");
      if (contains(chats, VICTIM_CHAT)) {
        fail(`${label} read another mailbox's bot chat`);
      }
      const proposals = await query(
        session,
        "select account_id, subject, sender_email, rationale from seer.triage_proposals",
      );
      if (contains(proposals, VICTIM_PROPOSAL) || contains(proposals, VICTIM_RATIONALE)) {
        fail(`${label} read another mailbox's triage proposal`);
      }
    }

    await readMailbox("inherited login");
    const switched = await query(session, "set role seer_bot");
    if (switched.code) {
      fail(`connector could not set role seer_bot (${switched.code})`);
    } else {
      await readMailbox("set role seer_bot");
      await query(session, "reset role");
    }

    const victimTask = await db.pool.query<{ id: string }>(
      "select id from seer.bot_tasks where account_id = $1 and notes = $2",
      [victimId, VICTIM_NOTES],
    );
    const victimChat = await db.pool.query<{ id: string }>(
      "select id from seer.bot_messages where account_id = $1 and body = $2",
      [victimId, VICTIM_CHAT],
    );
    const victimEvent = await db.pool.query<{ id: string }>(
      "select id from seer.bot_task_events where account_id = $1 and body = $2",
      [victimId, VICTIM_EVENT],
    );
    const victimProposal = await db.pool.query<{ id: string }>(
      "select id from seer.triage_proposals where account_id = $1 and subject = $2",
      [victimId, VICTIM_PROPOSAL],
    );

    await query(session, "update seer.bot_tasks set notes = 'hijacked-notes' where id = $1", [
      victimTask.rows[0].id,
    ]);
    await query(session, "delete from seer.bot_messages where id = $1", [victimChat.rows[0].id]);
    await query(session, "delete from seer.bot_task_events where id = $1", [victimEvent.rows[0].id]);
    await query(
      session,
      "update seer.triage_proposals set rationale = 'hijacked-rationale' where id = $1",
      [victimProposal.rows[0].id],
    );
    await query(
      session,
      `insert into seer.bot_tasks (account_id, bot_id, title, source)
       values ($1, $2, 'planted-task', 'bot')`,
      [victimId, botId],
    );
    await query(
      session,
      `insert into seer.bot_messages (account_id, bot_id, author, body)
       values ($1, $2, 'bot', 'planted-chat')`,
      [victimId, botId],
    );
    await query(
      session,
      `insert into seer.bot_task_events
         (account_id, task_id, actor, actor_name, kind, body)
       values ($1, $2, 'bot', 'Bot', 'note', 'planted-event')`,
      [victimId, victimTask.rows[0].id],
    );
    await query(
      session,
      `insert into seer.triage_proposals (account_id, bot_id, subject, action)
       values ($1, $2, 'planted-proposal', 'keep')`,
      [victimId, botId],
    );

    const notes = await db.pool.query<{ notes: string }>(
      "select notes from seer.bot_tasks where id = $1",
      [victimTask.rows[0].id],
    );
    if (notes.rows[0]?.notes !== VICTIM_NOTES) {
      fail("bot login changed another mailbox's task");
    }
    const chatLeft = await db.pool.query(
      "select 1 from seer.bot_messages where id = $1 and body = $2",
      [victimChat.rows[0].id, VICTIM_CHAT],
    );
    if ((chatLeft.rowCount ?? 0) !== 1) {
      fail("bot login deleted another mailbox's chat");
    }
    const eventLeft = await db.pool.query(
      "select 1 from seer.bot_task_events where id = $1 and body = $2",
      [victimEvent.rows[0].id, VICTIM_EVENT],
    );
    if ((eventLeft.rowCount ?? 0) !== 1) {
      fail("bot login deleted another mailbox's task event");
    }
    const rationale = await db.pool.query<{ rationale: string }>(
      "select rationale from seer.triage_proposals where id = $1",
      [victimProposal.rows[0].id],
    );
    if (rationale.rows[0]?.rationale !== VICTIM_RATIONALE) {
      fail("bot login changed another mailbox's triage proposal");
    }
    const plantedTask = await db.pool.query(
      "select 1 from seer.bot_tasks where account_id = $1 and title = 'planted-task'",
      [victimId],
    );
    const plantedChat = await db.pool.query(
      "select 1 from seer.bot_messages where account_id = $1 and body = 'planted-chat'",
      [victimId],
    );
    const plantedEvent = await db.pool.query(
      "select 1 from seer.bot_task_events where account_id = $1 and body = 'planted-event'",
      [victimId],
    );
    const plantedProposal = await db.pool.query(
      "select 1 from seer.triage_proposals where account_id = $1 and subject = 'planted-proposal'",
      [victimId],
    );
    if ((plantedTask.rowCount ?? 0) > 0) fail("bot login inserted a task for an ungranted mailbox");
    if ((plantedChat.rowCount ?? 0) > 0) fail("bot login inserted chat for an ungranted mailbox");
    if ((plantedEvent.rowCount ?? 0) > 0) fail("bot login inserted an event for an ungranted mailbox");
    if ((plantedProposal.rowCount ?? 0) > 0) {
      fail("bot login inserted a proposal for an ungranted mailbox");
    }

    const messageWrite = await query(
      session,
      "update seer.messages set body_text = 'rewritten' where account_id = $1",
      [victimId],
    );
    if (!denied(messageWrite)) {
      fail("seer_bot must not update seer.messages");
    }
    const oauth = await query(session, "select account_id, ciphertext from seer.oauth_credentials");
    if (!denied(oauth)) fail("seer_bot must not read seer.oauth_credentials");
    const people = await query(session, "select account_id, email from seer.people");
    if (!denied(people)) fail("seer_bot must not read seer.people");
    const outbox = await query(session, "select account_id from seer.outbox");
    if (!denied(outbox)) fail("seer_bot must not read seer.outbox");

    const off = await query(session, "set row_security = off");
    const afterOff = await query(session, "select body_text from seer.messages");
    if (contains(afterOff, VICTIM_BODY)) {
      fail("turning row_security off revealed another mailbox");
    }
    if (off.code === "") await query(session, "set row_security = on");

    for (const role of ["seer_bot", "seer_bot_connector"]) {
      for (const column of SECRET_MESSAGE_COLUMNS) {
        const privilege = await db.pool.query<{ allowed: boolean }>(
          "select has_column_privilege($1, 'seer.messages', $2, 'SELECT') as allowed",
          [role, column],
        );
        if (privilege.rows[0].allowed) {
          fail(`${role} can select seer.messages.${column}`);
        }
      }
    }

    const policies = await db.pool.query<{
      relname: string;
      polname: string;
      polpermissive: boolean;
      qual: string | null;
      wcheck: string | null;
      for_bot: boolean;
      for_public: boolean;
    }>(
      `select c.relname,
              p.polname,
              p.polpermissive,
              pg_get_expr(p.polqual, p.polrelid) as qual,
              pg_get_expr(p.polwithcheck, p.polrelid) as wcheck,
              exists (
                select 1 from pg_roles r
                 where r.rolname = 'seer_bot' and r.oid = any (p.polroles)
              ) as for_bot,
              0 = any (p.polroles) as for_public
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'seer'`,
    );
    for (const policy of policies.rows) {
      if (!SCOPED_TABLES.includes(policy.relname)) continue;
      if (!policy.for_bot && !policy.for_public) continue;
      if (!policy.polpermissive) continue;
      for (const expr of [policy.qual, policy.wcheck]) {
        if (expr == null) continue;
        if (expr.trim() === "true" || !expr.includes("bot_account_grants")) {
          fail(
            `${policy.polname} on seer.${policy.relname} must allow a row only when its account is in seer.bot_account_grants`,
          );
        }
        if (/current_setting|set_config|current_user|session_user|current_role/i.test(expr)) {
          fail(`${policy.polname} trusts a session value the bot can set`);
        }
      }
    }

    const grantTable = await query(db.pool, "select to_regclass('seer.bot_account_grants') as regclass");
    if (!grantTable.rows[0]?.regclass) {
      fail("seer.bot_account_grants must exist so an operator can name the mailboxes this login may read");
    } else {
      const leftover = await db.pool.query(
        "select 1 from seer.bot_account_grants where account_id = $1",
        [victimId],
      );
      if ((leftover.rowCount ?? 0) > 0) {
        fail("a refused self-grant still left a row in seer.bot_account_grants");
      }
      await db.pool.query(
        "insert into seer.bot_account_grants (account_id) values ($1)",
        [allowedId],
      );
      const again = await query(
        session,
        "insert into seer.bot_account_grants (account_id) values ($1)",
        [victimId],
      );
      if (again.code === "") fail("seer_bot login inserted a grant after the operator's grant existed");
      for (const setting of SESSION_SETTINGS) {
        await query(session, "select set_config($1, $2, false)", [setting, victimId]);
      }

      const subjects = await query(
        session,
        "select id, provider_conversation_id, subject from seer.conversations",
      );
      if (!contains(subjects, ALLOWED_SUBJECT)) {
        fail("granted mailbox conversation id and subject must stay readable");
      }
      if (contains(subjects, VICTIM_SUBJECT)) {
        fail("a grant for one mailbox still revealed the other conversation");
      }
      const addresses = await query(session, "select email from seer.mail_accounts");
      if (!contains(addresses, ALLOWED_EMAIL)) {
        fail("granted mailbox address must stay readable");
      }
      if (contains(addresses, VICTIM_EMAIL)) {
        fail("a grant for one mailbox still revealed the other address");
      }
      const bodies = await query(
        session,
        "select body_text, body_html, snippet, from_email, to_emails, cc_emails from seer.messages",
      );
      if (contains(bodies, ALLOWED_BODY) || contains(bodies, VICTIM_BODY)) {
        fail("message bodies stayed readable for a granted mailbox");
      } else if (bodies.code && !denied(bodies)) {
        fail(`granted-mailbox body read failed unexpectedly (${bodies.code})`);
      }
      const notesVisible = await query(session, "select notes from seer.bot_tasks");
      if (!contains(notesVisible, ALLOWED_NOTES)) {
        fail("bot must still read task notes for a granted mailbox");
      }
      if (contains(notesVisible, VICTIM_NOTES)) {
        fail("bot still read task notes for an ungranted mailbox");
      }
      const filed = await query(
        session,
        `insert into seer.triage_proposals (account_id, bot_id, subject, action)
         values ($1, $2, 'granted-proposal', 'keep')
         returning id`,
        [allowedId, botId],
      );
      if (filed.rowCount !== 1) {
        fail("bot must still file a triage proposal for a granted mailbox");
      }
      const filedVictim = await query(
        session,
        `insert into seer.triage_proposals (account_id, bot_id, subject, action)
         values ($1, $2, 'second-planted-proposal', 'keep')
         returning id`,
        [victimId, botId],
      );
      if (filedVictim.rowCount !== 0) {
        fail("bot filed a proposal for a mailbox it was not granted");
      }
      const secondPlant = await db.pool.query(
        "select 1 from seer.triage_proposals where subject = 'second-planted-proposal'",
      );
      if ((secondPlant.rowCount ?? 0) > 0) {
        fail("ungranted proposal insert left a row behind");
      }

      await query(session, "set role seer_bot");
      const asRole = await query(
        session,
        "select subject from seer.conversations",
      );
      if (contains(asRole, VICTIM_SUBJECT) || !contains(asRole, ALLOWED_SUBJECT)) {
        fail("set role seer_bot did not keep the same account boundary");
      }
    }
  } finally {
    session.release();
  }
} finally {
  await botPoolRef.pool?.end();
  await db.stop();
}

assert.deepEqual(failures, [], failures.join("\n"));
console.log("bot-mailbox-isolation: OK");
