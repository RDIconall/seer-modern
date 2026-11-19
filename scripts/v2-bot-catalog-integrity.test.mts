/**
 * Shared bot catalog: a signed-in mailbox must not be able to insert rows
 * into seer.bots.
 *
 * The seeded slugs are the allowlist. createBotTask, updateBotTask, and
 * postBotMessage (when no task id is sent) are the mailbox operations that
 * pass botSlug into ensureBot. Each must reject an unknown slug, leave the
 * catalog unchanged, and leave no task or message behind for that slug.
 * Slug and display name must also be capped in the database at 128 characters.
 *
 * Not covered here, because they are not a signed-in mailbox command:
 * upsertSeedTask (operator seed script) and insertProposal (no request
 * caller). commentBotTask and decideTriageProposal do not write seer.bots.
 *
 * These assertions fail while mailbox commands can still insert catalog rows.
 */
import "./v2-bot-catalog-mocks.mts";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { startTestDb } from "./v2-testdb.mts";
import { sessionState } from "./v2-bot-catalog-mocks.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { StaffBoard } from "../src/components/v2/StaffBoard.tsx";
import type { StaffView } from "../src/lib/v2/staff/types.ts";

const ORIGIN = "https://seer.test";
const ALICE = "alice.desk@rditrials.com";
const BOB = "bob.desk@rditrials.com";
const MAX_BOT_TEXT = 128;

const db = await startTestDb();

const commandsRoute = await import("../src/app/api/v2/commands/route.ts");
const staffRoute = await import("../src/app/api/v2/staff/route.ts");

function asSession(email: string, activeAccountId: string | null) {
  sessionState.email = email;
  sessionState.activeAccountId = activeAccountId;
}

async function postCommand(
  command: Record<string, unknown>,
  idempotencyKey: string,
  origin: string = ORIGIN,
) {
  const response = await commandsRoute.POST(
    new Request(`${ORIGIN}/api/v2/commands`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command, idempotencyKey }),
    }),
  );
  const json = (await response.json()) as {
    error?: string;
    result?: { ok?: boolean; error?: string; detail?: Record<string, unknown> };
  };
  return { status: response.status, json };
}

async function getStaff(): Promise<{ status: number; view: StaffView | null }> {
  const response = await staffRoute.GET(
    new Request(`${ORIGIN}/api/v2/staff`),
  );
  const json = (await response.json()) as { view?: StaffView; error?: string };
  return { status: response.status, view: json.view ?? null };
}

async function catalogSlugs(): Promise<string[]> {
  const rows = await db.pool.query<{ slug: string }>(
    "select slug from seer.bots order by slug",
  );
  return rows.rows.map((row) => row.slug);
}

async function taskBotSlug(taskId: string): Promise<string | null> {
  const rows = await db.pool.query<{ slug: string }>(
    `select b.slug
       from seer.bot_tasks t
       join seer.bots b on b.id = t.bot_id
      where t.id = $1`,
    [taskId],
  );
  return rows.rows[0]?.slug ?? null;
}

async function oversizedInsertRejected(
  slug: string,
  displayName: string,
): Promise<boolean> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    try {
      await client.query(
        "insert into seer.bots (slug, display_name) values ($1, $2)",
        [slug, displayName],
      );
      return false;
    } catch {
      return true;
    }
  } finally {
    await client.query("rollback");
    client.release();
  }
}

try {
  const aliceUser = await upsertUser(ALICE);
  const aliceId = await upsertAccount({
    userId: aliceUser,
    provider: "google",
    email: ALICE,
  });
  const bobUser = await upsertUser(BOB);
  const bobId = await upsertAccount({
    userId: bobUser,
    provider: "google",
    email: BOB,
  });

  const seeded = await catalogSlugs();
  assert.ok(seeded.includes("chief-of-staff"), "migration seeds the catalog");
  assert.ok(
    seeded.every((slug) => slug.length <= MAX_BOT_TEXT),
    "seeded slugs fit the catalog cap",
  );

  asSession(ALICE, aliceId);
  const known = await postCommand(
    {
      type: "createBotTask",
      title: "File the signed minutes",
      botSlug: "chief-of-staff",
    },
    "catalog-known-create",
  );
  assert.equal(known.status, 200, JSON.stringify(known.json));
  assert.equal(known.json.result?.ok, true, known.json.result?.error);
  const knownTaskId = String(known.json.result?.detail?.taskId ?? "");
  assert.match(knownTaskId, /^[0-9a-f-]{36}$/);
  assert.equal(await taskBotSlug(knownTaskId), "chief-of-staff");
  assert.deepEqual(
    await catalogSlugs(),
    seeded,
    "a seeded slug must not add a catalog row",
  );

  const wrongOrigin = await postCommand(
    {
      type: "createBotTask",
      title: "Should not run",
      botSlug: "origin-smuggled-bot",
    },
    "catalog-bad-origin",
    "https://evil.test",
  );
  assert.equal(wrongOrigin.status, 403);
  assert.deepEqual(await catalogSlugs(), seeded);

  asSession("outsider@example.com", null);
  const outsider = await postCommand(
    {
      type: "createBotTask",
      title: "Should not run",
      botSlug: "outsider-bot",
    },
    "catalog-outsider",
  );
  assert.equal(outsider.status, 404);
  assert.deepEqual(await catalogSlugs(), seeded);

  asSession(ALICE, aliceId);
  const problems: string[] = [];
  const note = (cond: unknown, message: string) => {
    if (!cond) problems.push(message);
  };

  const created = await postCommand(
    {
      type: "createBotTask",
      title: "Pretend this assistant exists",
      botSlug: "  Not-A-Real-Assistant  ",
    },
    "catalog-create-unknown",
  );
  note(created.json.result?.ok === false, "createBotTask accepted an unknown botSlug");
  note(
    !(await catalogSlugs()).includes("not-a-real-assistant"),
    "createBotTask inserted not-a-real-assistant into seer.bots",
  );
  const createdTask = await db.pool.query(
    `select 1 from seer.bot_tasks
      where account_id = $1 and title = 'Pretend this assistant exists'`,
    [aliceId],
  );
  note(
    createdTask.rowCount === 0,
    "createBotTask stored a task for an unknown bot",
  );

  const reassigned = await postCommand(
    {
      type: "updateBotTask",
      taskId: knownTaskId,
      botSlug: "ghost-delegate",
    },
    "catalog-update-unknown",
  );
  note(reassigned.json.result?.ok === false, "updateBotTask accepted an unknown botSlug");
  note(
    !(await catalogSlugs()).includes("ghost-delegate"),
    "updateBotTask inserted ghost-delegate into seer.bots",
  );
  note(
    (await taskBotSlug(knownTaskId)) === "chief-of-staff",
    "updateBotTask moved an authorized task onto a bot the catalog did not contain",
  );

  const posted = await postCommand(
    {
      type: "postBotMessage",
      body: "Route this chat to a bot I just named",
      botSlug: "chat-impostor",
    },
    "catalog-post-unknown",
  );
  note(posted.json.result?.ok === false, "postBotMessage accepted an unknown botSlug");
  note(
    !(await catalogSlugs()).includes("chat-impostor"),
    "postBotMessage inserted chat-impostor into seer.bots",
  );
  const postedMessage = await db.pool.query(
    `select 1 from seer.bot_messages
      where account_id = $1 and body = 'Route this chat to a bot I just named'`,
    [aliceId],
  );
  note(
    postedMessage.rowCount === 0,
    "postBotMessage stored a message for an unknown bot",
  );

  const postedOnTask = await postCommand(
    {
      type: "postBotMessage",
      body: "This message stays on the task bot",
      taskId: knownTaskId,
      botSlug: "task-scoped-impostor",
    },
    "catalog-post-on-task",
  );
  note(
    !(await catalogSlugs()).includes("task-scoped-impostor"),
    "postBotMessage with a task id still inserted task-scoped-impostor",
  );
  if (postedOnTask.json.result?.ok === true) {
    const attached = await db.pool.query<{ slug: string }>(
      `select b.slug
         from seer.bot_messages m
         join seer.bots b on b.id = m.bot_id
        where m.account_id = $1 and m.body = 'This message stays on the task bot'`,
      [aliceId],
    );
    note(
      attached.rows.length === 1 &&
        attached.rows[0].slug === (await taskBotSlug(knownTaskId)) &&
        attached.rows[0].slug !== "task-scoped-impostor",
      "a message sent on an existing task followed the request botSlug instead of that task",
    );
  }

  const bulkySlug = `bulky-${"x".repeat(1000)}`;
  const bulky = await postCommand(
    {
      type: "createBotTask",
      title: "Oversized catalog entry",
      botSlug: bulkySlug,
    },
    "catalog-create-bulky",
  );
  note(bulky.json.result?.ok === false, "createBotTask accepted a 1000+ character botSlug");
  const bulkyStored = await db.pool.query<{ slug: string; display_name: string }>(
    "select slug, display_name from seer.bots where length(slug) > $1 or length(display_name) > $1",
    [MAX_BOT_TEXT],
  );
  note(
    bulkyStored.rowCount === 0,
    `a mailbox stored bot text longer than ${MAX_BOT_TEXT} characters`,
  );

  for (let i = 0; i < 20; i += 1) {
    await postCommand(
      {
        type: "createBotTask",
        title: `Flood ${i}`,
        botSlug: `flood-bot-${i}`,
      },
      `catalog-flood-${i}`,
    );
  }
  const afterFlood = await catalogSlugs();
  const added = afterFlood.filter((slug) => !seeded.includes(slug));
  note(
    added.length === 0,
    `catalog grew from ${seeded.length} seeded rows to ${afterFlood.length} (${added.length} added, longest ${added.reduce((n, slug) => Math.max(n, slug.length), 0)} chars)`,
  );

  asSession(BOB, bobId);
  const bobStaff = await getStaff();
  note(bobStaff.status === 200, "the other mailbox could not load staff");
  const bobSlugs = (bobStaff.view?.bots ?? []).map((bot) => bot.slug);
  const bobAdded = bobSlugs.filter((slug) => !seeded.includes(slug));
  note(
    bobAdded.length === 0 && bobSlugs.length === seeded.length,
    `the other desk's staff view listed ${bobAdded.length} bot row(s) that were not seeded`,
  );
  if (bobStaff.view) {
    const html = renderToString(
      createElement(StaffBoard, {
        view: bobStaff.view,
        onCreateTask: () => undefined,
      }),
    );
    note(
      !html.includes("not-a-real-assistant") &&
        !html.includes("ghost-delegate") &&
        !html.includes("chat-impostor") &&
        !html.includes("flood-bot-0"),
      "the delegate picker rendered a bot name inserted by another mailbox",
    );
  }

  note(
    await oversizedInsertRejected("s".repeat(MAX_BOT_TEXT + 1), "Short name"),
    `seer.bots.slug accepts more than ${MAX_BOT_TEXT} characters`,
  );
  note(
    await oversizedInsertRejected("short-slug", "n".repeat(MAX_BOT_TEXT + 1)),
    `seer.bots.display_name accepts more than ${MAX_BOT_TEXT} characters`,
  );
  note(
    !(await oversizedInsertRejected("a".repeat(MAX_BOT_TEXT), "b".repeat(MAX_BOT_TEXT))),
    `a ${MAX_BOT_TEXT}-character slug and display name must still fit`,
  );

  assert.deepEqual(problems, []);
  console.log("v2-bot-catalog-integrity: OK");
} finally {
  await db.stop();
}
