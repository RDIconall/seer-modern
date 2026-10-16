import type { Pool, PoolClient } from "pg";
import { db } from "../db/pool";
import { inTransaction } from "../db/transaction";
import {
  asAccountId,
  isUuid,
  type AccountId,
} from "../db/types";
import { DEFAULT_BOT_SLUG } from "./types";
import type {
  BotTaskStatus,
  StaffActor,
  StaffBot,
  StaffEvent,
  StaffMessage,
  StaffProposal,
  StaffTask,
  StaffView,
  TriageAction,
  TriageProposalStatus,
} from "./types";
import { isBotTaskStatus, isTriageAction } from "./types";

type Runner = Pool | PoolClient;

function runner(): Runner {
  return db();
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireIso(value: Date | string): string {
  return iso(value) ?? new Date().toISOString();
}

export async function listBots(client: Runner = runner()): Promise<StaffBot[]> {
  const r = await client.query<{ id: string; slug: string; display_name: string }>(
    "select id, slug, display_name from seer.bots order by display_name",
  );
  return r.rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
  }));
}

export async function ensureBot(
  slug: string,
  displayName: string,
  client: Runner = runner(),
): Promise<StaffBot> {
  const normalized = slug.trim().toLowerCase() || DEFAULT_BOT_SLUG;
  const name = displayName.trim() || slug;
  const r = await client.query<{ id: string; slug: string; display_name: string }>(
    `insert into seer.bots (slug, display_name)
       values ($1, $2)
       on conflict (slug) do update set display_name = coalesce(seer.bots.display_name, excluded.display_name)
     returning id, slug, display_name`,
    [normalized, name],
  );
  const row = r.rows[0];
  return { id: row.id, slug: row.slug, displayName: row.display_name };
}

export async function botBySlug(
  slug: string,
  client: Runner = runner(),
): Promise<StaffBot | null> {
  const r = await client.query<{ id: string; slug: string; display_name: string }>(
    "select id, slug, display_name from seer.bots where slug = $1",
    [slug.trim().toLowerCase()],
  );
  const row = r.rows[0];
  return row
    ? { id: row.id, slug: row.slug, displayName: row.display_name }
    : null;
}

type TaskRow = {
  id: string;
  account_id: string;
  bot_id: string;
  bot_slug: string;
  bot_name: string;
  external_key: string | null;
  title: string;
  status: string;
  priority: number;
  due_at: Date | null;
  notes: string | null;
  his_words: string | null;
  current_state: string | null;
  next_action: string | null;
  source: string;
  created_at: Date;
  updated_at: Date;
};

function asTask(row: TaskRow, events: StaffEvent[]): StaffTask {
  return {
    id: row.id,
    accountId: asAccountId(row.account_id),
    botId: row.bot_id,
    botSlug: row.bot_slug,
    botName: row.bot_name,
    externalKey: row.external_key,
    title: row.title,
    status: isBotTaskStatus(row.status) ? row.status : "open",
    priority: row.priority,
    dueAt: iso(row.due_at),
    notes: row.notes,
    hisWords: row.his_words,
    currentState: row.current_state,
    nextAction: row.next_action,
    source: row.source === "user" ? "user" : "bot",
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
    events,
  };
}

const TASK_SELECT = `
  select t.id, t.account_id, t.bot_id, b.slug as bot_slug, b.display_name as bot_name,
         t.external_key, t.title, t.status, t.priority, t.due_at, t.notes,
         t.his_words, t.current_state, t.next_action, t.source,
         t.created_at, t.updated_at
    from seer.bot_tasks t
    join seer.bots b on b.id = t.bot_id
`;

export async function getTask(
  accountId: AccountId,
  taskId: string,
  client: Runner = runner(),
): Promise<StaffTask | null> {
  if (!isUuid(taskId)) return null;
  const r = await client.query<TaskRow>(
    `${TASK_SELECT} where t.account_id = $1 and t.id = $2`,
    [accountId, taskId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const events = await listEvents(accountId, [taskId], client);
  return asTask(row, events);
}

export async function listEvents(
  accountId: AccountId,
  taskIds: string[],
  client: Runner = runner(),
): Promise<StaffEvent[]> {
  if (taskIds.length === 0) return [];
  const r = await client.query<{
    id: string;
    task_id: string;
    actor: string;
    actor_name: string;
    kind: string;
    body: string | null;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `select id, task_id, actor, actor_name, kind, body, payload, created_at
       from seer.bot_task_events
      where account_id = $1 and task_id = any($2::uuid[])
      order by created_at asc`,
    [accountId, taskIds],
  );
  return r.rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    actor: row.actor === "user" ? "user" : "bot",
    actorName: row.actor_name,
    kind: row.kind,
    body: row.body,
    payload: row.payload ?? {},
    createdAt: requireIso(row.created_at),
  }));
}

export async function addEvent(
  input: {
    accountId: AccountId;
    taskId: string;
    actor: StaffActor;
    actorName: string;
    kind: StaffEvent["kind"];
    body?: string | null;
    payload?: Record<string, unknown>;
  },
  client: Runner = runner(),
): Promise<StaffEvent> {
  const r = await client.query<{
    id: string;
    created_at: Date;
  }>(
    `insert into seer.bot_task_events
       (account_id, task_id, actor, actor_name, kind, body, payload)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     returning id, created_at`,
    [
      input.accountId,
      input.taskId,
      input.actor,
      input.actorName,
      input.kind,
      input.body ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return {
    id: r.rows[0].id,
    taskId: input.taskId,
    actor: input.actor,
    actorName: input.actorName,
    kind: input.kind,
    body: input.body ?? null,
    payload: input.payload ?? {},
    createdAt: requireIso(r.rows[0].created_at),
  };
}

export type CreateTaskInput = {
  accountId: AccountId;
  botSlug?: string;
  botName?: string;
  externalKey?: string | null;
  title: string;
  status?: BotTaskStatus;
  priority?: number;
  dueAt?: string | null;
  notes?: string | null;
  hisWords?: string | null;
  currentState?: string | null;
  nextAction?: string | null;
  source: StaffActor;
  createdAt?: string | null;
};

export async function createTask(input: CreateTaskInput): Promise<StaffTask> {
  const title = input.title.trim();
  if (!title) throw new Error("a task needs a title");
  return inTransaction(async (client) => {
    const bot = await ensureBot(
      input.botSlug ?? DEFAULT_BOT_SLUG,
      input.botName ?? input.botSlug ?? "Chief of staff",
      client,
    );
    const r = await client.query<TaskRow>(
      `insert into seer.bot_tasks (
         account_id, bot_id, external_key, title, status, priority, due_at,
         notes, his_words, current_state, next_action, source, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, coalesce($13::timestamptz, now()))
       returning id, account_id, bot_id, $14::text as bot_slug, $15::text as bot_name,
                 external_key, title, status, priority, due_at, notes, his_words,
                 current_state, next_action, source, created_at, updated_at`,
      [
        input.accountId,
        bot.id,
        input.externalKey?.trim() || null,
        title,
        input.status ?? "open",
        input.priority ?? 100,
        input.dueAt ?? null,
        input.notes ?? null,
        input.hisWords ?? null,
        input.currentState ?? null,
        input.nextAction ?? null,
        input.source,
        input.createdAt ?? null,
        bot.slug,
        bot.displayName,
      ],
    );
    const task = asTask(r.rows[0], []);
    const event = await addEvent(
      {
        accountId: input.accountId,
        taskId: task.id,
        actor: input.source,
        actorName: input.source === "user" ? "Conall" : bot.displayName,
        kind: "created",
        body: title,
      },
      client,
    );
    return { ...task, events: [event] };
  });
}

export async function upsertSeedTask(input: CreateTaskInput): Promise<StaffTask> {
  if (!input.externalKey) return createTask(input);
  return inTransaction(async (client) => {
    const bot = await ensureBot(
      input.botSlug ?? DEFAULT_BOT_SLUG,
      input.botName ?? "Chief of staff",
      client,
    );
    const existing = await client.query<{ id: string }>(
      `select id from seer.bot_tasks
        where account_id = $1 and external_key = $2`,
      [input.accountId, input.externalKey],
    );
    if (existing.rowCount) {
      const updated = await client.query<TaskRow>(
        `update seer.bot_tasks set
           bot_id = $3,
           title = $4,
           status = $5,
           priority = $6,
           notes = $7,
           his_words = $8,
           current_state = $9,
           next_action = $10
         where account_id = $1 and id = $2
         returning id, account_id, bot_id, $11::text as bot_slug, $12::text as bot_name,
                   external_key, title, status, priority, due_at, notes, his_words,
                   current_state, next_action, source, created_at, updated_at`,
        [
          input.accountId,
          existing.rows[0].id,
          bot.id,
          input.title.trim(),
          input.status ?? "open",
          input.priority ?? 100,
          input.notes ?? null,
          input.hisWords ?? null,
          input.currentState ?? null,
          input.nextAction ?? null,
          bot.slug,
          bot.displayName,
        ],
      );
      return asTask(updated.rows[0], []);
    }
    const inserted = await client.query<TaskRow>(
      `insert into seer.bot_tasks (
         account_id, bot_id, external_key, title, status, priority,
         notes, his_words, current_state, next_action, source, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, coalesce($12::timestamptz, now()))
       returning id, account_id, bot_id, $13::text as bot_slug, $14::text as bot_name,
                 external_key, title, status, priority, due_at, notes, his_words,
                 current_state, next_action, source, created_at, updated_at`,
      [
        input.accountId,
        bot.id,
        input.externalKey,
        input.title.trim(),
        input.status ?? "open",
        input.priority ?? 100,
        input.notes ?? null,
        input.hisWords ?? null,
        input.currentState ?? null,
        input.nextAction ?? null,
        input.source,
        input.createdAt ?? null,
        bot.slug,
        bot.displayName,
      ],
    );
    const task = asTask(inserted.rows[0], []);
    await addEvent(
      {
        accountId: input.accountId,
        taskId: task.id,
        actor: input.source,
        actorName: bot.displayName,
        kind: "created",
        body: task.title,
      },
      client,
    );
    return task;
  });
}

export type UpdateTaskPatch = {
  status?: BotTaskStatus;
  title?: string;
  notes?: string | null;
  dueAt?: string | null;
  nextAction?: string | null;
  currentState?: string | null;
  priority?: number;
  botSlug?: string;
};

export async function updateTask(
  accountId: AccountId,
  taskId: string,
  patch: UpdateTaskPatch,
  actor: StaffActor = "user",
): Promise<StaffTask> {
  if (!isUuid(taskId)) throw new Error("task not found");
  return inTransaction(async (client) => {
    const current = await getTask(accountId, taskId, client);
    if (!current) throw new Error("task not found");
    let botId = current.botId;
    let botSlug = current.botSlug;
    let botName = current.botName;
    if (patch.botSlug && patch.botSlug !== current.botSlug) {
      const bot = await ensureBot(patch.botSlug, patch.botSlug, client);
      botId = bot.id;
      botSlug = bot.slug;
      botName = bot.displayName;
      await addEvent(
        {
          accountId,
          taskId,
          actor,
          actorName: actor === "user" ? "Conall" : botName,
          kind: "assign",
          body: `Delegated to ${botName}`,
          payload: { from: current.botSlug, to: botSlug },
        },
        client,
      );
    }
    const title = patch.title?.trim() || current.title;
    const status = patch.status ?? current.status;
    const notes = patch.notes === undefined ? current.notes : patch.notes;
    const dueAt = patch.dueAt === undefined ? current.dueAt : patch.dueAt;
    const nextAction =
      patch.nextAction === undefined ? current.nextAction : patch.nextAction;
    const currentState =
      patch.currentState === undefined ? current.currentState : patch.currentState;
    const priority = patch.priority ?? current.priority;
    const actorName = actor === "user" ? "Conall" : botName;
    if (status !== current.status) {
      await addEvent(
        {
          accountId,
          taskId,
          actor,
          actorName,
          kind: "status",
          body: status,
          payload: { from: current.status, to: status },
        },
        client,
      );
    }
    if (title !== current.title) {
      await addEvent(
        {
          accountId,
          taskId,
          actor,
          actorName,
          kind: "title",
          body: title,
        },
        client,
      );
    }
    if (notes !== current.notes) {
      await addEvent(
        {
          accountId,
          taskId,
          actor,
          actorName,
          kind: "note",
          body: notes,
        },
        client,
      );
    }
    if (dueAt !== current.dueAt) {
      await addEvent(
        {
          accountId,
          taskId,
          actor,
          actorName,
          kind: "due",
          body: dueAt,
          payload: { from: current.dueAt, to: dueAt },
        },
        client,
      );
    }
    if (priority !== current.priority) {
      await addEvent(
        {
          accountId,
          taskId,
          actor,
          actorName,
          kind: "priority",
          body: String(priority),
          payload: { from: current.priority, to: priority },
        },
        client,
      );
    }
    const r = await client.query<TaskRow>(
      `update seer.bot_tasks set
         bot_id = $3,
         title = $4,
         status = $5,
         notes = $6,
         due_at = $7,
         next_action = $8,
         current_state = $9,
         priority = $10
       where account_id = $1 and id = $2
       returning id, account_id, bot_id, $11::text as bot_slug, $12::text as bot_name,
                 external_key, title, status, priority, due_at, notes, his_words,
                 current_state, next_action, source, created_at, updated_at`,
      [
        accountId,
        taskId,
        botId,
        title,
        status,
        notes,
        dueAt,
        nextAction,
        currentState,
        priority,
        botSlug,
        botName,
      ],
    );
    const events = await listEvents(accountId, [taskId], client);
    return asTask(r.rows[0], events);
  });
}

export async function commentTask(
  accountId: AccountId,
  taskId: string,
  body: string,
  actor: StaffActor = "user",
  actorName?: string,
): Promise<StaffEvent> {
  const text = body.trim();
  if (!text) throw new Error("comment is empty");
  if (!isUuid(taskId)) throw new Error("task not found");
  return inTransaction(async (client) => {
    const task = await getTask(accountId, taskId, client);
    if (!task) throw new Error("task not found");
    return addEvent(
      {
        accountId,
        taskId,
        actor,
        actorName: actorName ?? (actor === "user" ? "Conall" : task.botName),
        kind: "comment",
        body: text,
      },
      client,
    );
  });
}

export async function postMessage(input: {
  accountId: AccountId;
  botSlug?: string;
  taskId?: string | null;
  author: StaffActor;
  body: string;
}): Promise<StaffMessage> {
  const text = input.body.trim();
  if (!text) throw new Error("message is empty");
  return inTransaction(async (client) => {
    let bot: StaffBot | null = null;
    if (input.taskId) {
      if (!isUuid(input.taskId)) throw new Error("task not found");
      const task = await getTask(input.accountId, input.taskId, client);
      if (!task) throw new Error("task not found");
      bot = {
        id: task.botId,
        slug: task.botSlug,
        displayName: task.botName,
      };
    } else {
      bot = await ensureBot(
        input.botSlug ?? DEFAULT_BOT_SLUG,
        "Chief of staff",
        client,
      );
    }
    const r = await client.query<{ id: string; created_at: Date }>(
      `insert into seer.bot_messages (account_id, bot_id, task_id, author, body)
       values ($1, $2, $3, $4, $5)
       returning id, created_at`,
      [input.accountId, bot.id, input.taskId ?? null, input.author, text],
    );
    return {
      id: r.rows[0].id,
      botId: bot.id,
      botSlug: bot.slug,
      botName: bot.displayName,
      taskId: input.taskId ?? null,
      author: input.author,
      body: text,
      createdAt: requireIso(r.rows[0].created_at),
    };
  });
}

type ProposalRow = {
  id: string;
  bot_id: string;
  bot_slug: string;
  bot_name: string;
  conversation_id: string | null;
  provider_conversation_id: string | null;
  sender_email: string | null;
  subject: string | null;
  action: string;
  destination_id: string | null;
  destination_name: string | null;
  rationale: string | null;
  status: string;
  last_error: string | null;
  outbox_id: string | null;
  created_at: Date;
  decided_at: Date | null;
};

function asProposal(row: ProposalRow): StaffProposal {
  return {
    id: row.id,
    botId: row.bot_id,
    botSlug: row.bot_slug,
    botName: row.bot_name,
    conversationId: row.conversation_id,
    providerConversationId: row.provider_conversation_id,
    senderEmail: row.sender_email,
    subject: row.subject,
    action: isTriageAction(row.action) ? row.action : "keep",
    destinationId: row.destination_id,
    destinationName: row.destination_name,
    rationale: row.rationale,
    status: (row.status as TriageProposalStatus) ?? "pending",
    lastError: row.last_error,
    outboxId: row.outbox_id,
    createdAt: requireIso(row.created_at),
    decidedAt: iso(row.decided_at),
  };
}

const PROPOSAL_SELECT = `
  select p.id, p.bot_id, b.slug as bot_slug, b.display_name as bot_name,
         p.conversation_id, p.provider_conversation_id, p.sender_email, p.subject,
         p.action, p.destination_id, p.destination_name, p.rationale, p.status,
         p.last_error, p.outbox_id, p.created_at, p.decided_at
    from seer.triage_proposals p
    join seer.bots b on b.id = p.bot_id
`;

export async function getProposal(
  accountId: AccountId,
  proposalId: string,
  client: Runner = runner(),
): Promise<StaffProposal | null> {
  if (!isUuid(proposalId)) return null;
  const r = await client.query<ProposalRow>(
    `${PROPOSAL_SELECT} where p.account_id = $1 and p.id = $2`,
    [accountId, proposalId],
  );
  return r.rows[0] ? asProposal(r.rows[0]) : null;
}

export async function markProposal(
  accountId: AccountId,
  proposalId: string,
  patch: {
    status: TriageProposalStatus;
    decidedBy?: StaffActor;
    lastError?: string | null;
    outboxId?: string | null;
  },
): Promise<StaffProposal> {
  const r = await db().query<ProposalRow>(
    `update seer.triage_proposals set
       status = $3,
       decided_at = now(),
       decided_by = coalesce($4, decided_by),
       last_error = $5,
       outbox_id = coalesce($6, outbox_id)
     where account_id = $1 and id = $2
     returning id, bot_id,
               (select slug from seer.bots where id = bot_id) as bot_slug,
               (select display_name from seer.bots where id = bot_id) as bot_name,
               conversation_id, provider_conversation_id, sender_email, subject,
               action, destination_id, destination_name, rationale, status,
               last_error, outbox_id, created_at, decided_at`,
    [
      accountId,
      proposalId,
      patch.status,
      patch.decidedBy ?? null,
      patch.lastError ?? null,
      patch.outboxId ?? null,
    ],
  );
  if (!r.rows[0]) throw new Error("proposal not found");
  return asProposal(r.rows[0]);
}

export async function resolveConversation(
  accountId: AccountId,
  conversationId: string | null,
  providerConversationId: string | null,
): Promise<{ id: string; providerConversationId: string } | null> {
  const r = await db().query<{ id: string; provider_conversation_id: string }>(
    `select id, provider_conversation_id
       from seer.conversations
      where account_id = $1
        and (
          ($2::uuid is not null and id = $2)
          or ($3::text is not null and provider_conversation_id = $3)
        )
      limit 1`,
    [
      accountId,
      conversationId && isUuid(conversationId) ? conversationId : null,
      providerConversationId,
    ],
  );
  const row = r.rows[0];
  return row
    ? { id: row.id, providerConversationId: row.provider_conversation_id }
    : null;
}

export async function insertProposal(input: {
  accountId: AccountId;
  botSlug?: string;
  conversationId?: string | null;
  providerConversationId?: string | null;
  senderEmail?: string | null;
  subject?: string | null;
  action: TriageAction;
  destinationId?: string | null;
  destinationName?: string | null;
  rationale?: string | null;
}): Promise<StaffProposal> {
  return inTransaction(async (client) => {
    const bot = await ensureBot(
      input.botSlug ?? DEFAULT_BOT_SLUG,
      "Chief of staff",
      client,
    );
    const r = await client.query<ProposalRow>(
      `insert into seer.triage_proposals (
         account_id, bot_id, conversation_id, provider_conversation_id,
         sender_email, subject, action, destination_id, destination_name, rationale
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       returning id, bot_id, $11::text as bot_slug, $12::text as bot_name,
                 conversation_id, provider_conversation_id, sender_email, subject,
                 action, destination_id, destination_name, rationale, status,
                 last_error, outbox_id, created_at, decided_at`,
      [
        input.accountId,
        bot.id,
        input.conversationId ?? null,
        input.providerConversationId ?? null,
        input.senderEmail ?? null,
        input.subject ?? null,
        input.action,
        input.destinationId ?? null,
        input.destinationName ?? null,
        input.rationale ?? null,
        bot.slug,
        bot.displayName,
      ],
    );
    return asProposal(r.rows[0]);
  });
}

function asMessage(row: {
  id: string;
  bot_id: string;
  bot_slug: string;
  bot_name: string;
  task_id: string | null;
  author: string;
  body: string;
  created_at: Date;
}): StaffMessage {
  return {
    id: row.id,
    botId: row.bot_id,
    botSlug: row.bot_slug,
    botName: row.bot_name,
    taskId: row.task_id,
    author: row.author === "user" ? "user" : "bot",
    body: row.body,
    createdAt: requireIso(row.created_at),
  };
}

export async function loadStaffView(
  accountId: AccountId,
  options: { taskId?: string | null } = {},
): Promise<StaffView> {
  const bots = await listBots();
  const tasksRes = await db().query<TaskRow>(
    `${TASK_SELECT} where t.account_id = $1
     order by t.priority asc, t.created_at asc`,
    [accountId],
  );
  const taskIds = tasksRes.rows.map((row) => row.id);
  const events = await listEvents(accountId, taskIds);
  const eventsByTask = new Map<string, StaffEvent[]>();
  for (const event of events) {
    const list = eventsByTask.get(event.taskId) ?? [];
    list.push(event);
    eventsByTask.set(event.taskId, list);
  }
  const tasks = tasksRes.rows.map((row) =>
    asTask(row, eventsByTask.get(row.id) ?? []),
  );

  const proposalsRes = await db().query<ProposalRow>(
    `${PROPOSAL_SELECT}
      where p.account_id = $1 and p.status = 'pending'
      order by p.created_at desc`,
    [accountId],
  );

  const generalRes = await db().query<{
    id: string;
    bot_id: string;
    bot_slug: string;
    bot_name: string;
    task_id: string | null;
    author: string;
    body: string;
    created_at: Date;
  }>(
    `select m.id, m.bot_id, b.slug as bot_slug, b.display_name as bot_name,
            m.task_id, m.author, m.body, m.created_at
       from seer.bot_messages m
       join seer.bots b on b.id = m.bot_id
      where m.account_id = $1 and m.task_id is null
      order by m.created_at asc
      limit 200`,
    [accountId],
  );

  const focusTask = options.taskId && isUuid(options.taskId) ? options.taskId : null;
  const taskMsgRes = focusTask
    ? await db().query<{
        id: string;
        bot_id: string;
        bot_slug: string;
        bot_name: string;
        task_id: string | null;
        author: string;
        body: string;
        created_at: Date;
      }>(
        `select m.id, m.bot_id, b.slug as bot_slug, b.display_name as bot_name,
                m.task_id, m.author, m.body, m.created_at
           from seer.bot_messages m
           join seer.bots b on b.id = m.bot_id
          where m.account_id = $1 and m.task_id = $2
          order by m.created_at asc
          limit 200`,
        [accountId, focusTask],
      )
    : { rows: [] };

  return {
    asOf: new Date().toISOString(),
    bots,
    tasks,
    proposals: proposalsRes.rows.map(asProposal),
    generalMessages: generalRes.rows.map(asMessage),
    taskMessages: taskMsgRes.rows.map(asMessage),
  };
}

export async function accountEmail(accountId: AccountId): Promise<string | null> {
  const r = await db().query<{ email: string }>(
    "select email from seer.mail_accounts where id = $1",
    [accountId],
  );
  return r.rows[0]?.email ?? null;
}
