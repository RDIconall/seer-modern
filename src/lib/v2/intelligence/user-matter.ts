import { isUuid, type AccountId, type ConversationId } from "../db/types";
import { db } from "../db/pool";
import {
  counterpartyOf,
  matterNameFrom,
  ownTokens,
  resolveMatterMatch,
} from "./matter-key";
import {
  ensureMatter,
  linkConversationToMatter,
} from "./repository";

type ConversationMatterContext = {
  subject: string;
  functionName: string | null;
  summary: string;
  bodyText: string;
  fromEmail: string;
  ownEmail: string;
};

export type MatterSuggestion = {
  matterId: string;
  title: string;
  shortTitle: string;
  section: string | null;
  related: boolean;
};

async function conversationContext(
  accountId: AccountId,
  conversationId: ConversationId,
): Promise<ConversationMatterContext> {
  const result = await db().query<{
    subject: string;
    function_name: string | null;
    summary: string | null;
    body_text: string | null;
    snippet: string | null;
    from_email: string | null;
    own_email: string;
  }>(
    `select c.subject,
            c.function_name,
            d.summary,
            lm.body_text,
            lm.snippet,
            lm.from_email,
            a.email as own_email
       from seer.conversations c
       join seer.mail_accounts a on a.id = c.account_id
       left join seer.conversation_decisions d
         on d.account_id = c.account_id
        and d.conversation_id = c.id
        and d.is_current
       left join lateral (
         select m.body_text, m.snippet, m.from_email
           from seer.messages m
          where m.account_id = c.account_id
            and m.conversation_id = c.id
          order by m.sent_at desc nulls last
          limit 1
       ) lm on true
      where c.account_id = $1 and c.id = $2 and c.is_deleted = false`,
    [accountId, conversationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("conversation not found");
  return {
    subject: row.subject ?? "",
    functionName: row.function_name,
    summary: row.summary ?? "",
    bodyText: row.body_text ?? row.snippet ?? "",
    fromEmail: row.from_email ?? "",
    ownEmail: row.own_email,
  };
}

async function openMatters(accountId: AccountId) {
  return db().query<{
    id: string;
    title: string;
    short_title: string | null;
    function_name: string | null;
    counterparty: string | null;
    title_source: string | null;
    codes: string[] | null;
  }>(
    `select m.id,
            m.title,
            m.short_title,
            m.function_name,
            m.org_unit as counterparty,
            m.title_source,
            array_remove(array_agg(distinct mc.code), null) as codes
       from seer.matters m
       left join seer.matter_codes mc on mc.matter_id = m.id
      where m.account_id = $1 and m.status <> 'closed'
      group by m.id
      order by m.updated_at desc, m.title
      limit 100`,
    [accountId],
  );
}

/**
 * Sweep the open board for a conservative relation. A shared study/event code
 * is proof; without one, counterparty and meaningful request words must both
 * overlap. This is the same intelligence used when the AI reader promotes mail,
 * not a looser client-side "looks similar" heuristic.
 */
export async function suggestMattersForConversation(
  accountId: AccountId,
  conversationId: ConversationId,
): Promise<MatterSuggestion[]> {
  const [context, matters] = await Promise.all([
    conversationContext(accountId, conversationId),
    openMatters(accountId),
  ]);
  const ownDomain = context.ownEmail.split("@")[1] ?? "";
  const counterparty = counterpartyOf(context.fromEmail, ownDomain);
  const text = [context.subject, context.summary, context.bodyText].join(" ");
  const proposed = matterNameFrom(
    context.summary,
    context.subject,
    counterparty,
    text,
    ownTokens(context.ownEmail),
  );
  const match = resolveMatterMatch(
    { title: proposed, text, counterparty, own: ownTokens(context.ownEmail) },
    matters.rows.map((matter) => ({
      matterId: matter.id,
      title: matter.title,
      codes: matter.codes ?? [],
      counterparty: matter.counterparty ?? "",
      userAuthored: matter.title_source === "user",
    })),
  );
  return matters.rows
    .map((matter) => ({
      matterId: matter.id,
      title: matter.title,
      shortTitle: matter.short_title ?? matter.title,
      section: matter.function_name,
      related: matter.id === match?.matterId,
    }))
    .sort((a, b) => Number(b.related) - Number(a.related));
}

/** The open matter a conversation is already on, if it is on one. */
async function currentMatter(
  accountId: AccountId,
  conversationId: ConversationId,
): Promise<{ matterId: string; title: string } | null> {
  const result = await db().query<{ id: string; title: string }>(
    `select m.id, m.title
       from seer.matter_conversations mc
       join seer.matters m on m.id = mc.matter_id
      where m.account_id = $1
        and mc.conversation_id = $2
        and m.status <> 'closed'
      order by mc.link_source = 'user' desc, mc.linked_at desc
      limit 1`,
    [accountId, conversationId],
  );
  const row = result.rows[0];
  return row ? { matterId: row.id, title: row.title } : null;
}

/**
 * Put a conversation on an exact existing matter, force a new user-named one,
 * or let Seer's relation sweep reuse/create the right concern.
 */
export async function placeConversationOnMatter(
  accountId: AccountId,
  conversationId: ConversationId,
  input: {
    matterId?: string | null;
    matterTitle?: string | null;
    createNew?: boolean;
  },
): Promise<{ matterId: string; title: string }> {
  const context = await conversationContext(accountId, conversationId);
  let matterId = input.matterId?.trim() || "";
  let title = input.matterTitle?.trim().slice(0, 120) || "";

  if (matterId) {
    if (!isUuid(matterId)) throw new Error("matter not found");
    const existing = await db().query<{ title: string }>(
      `select title from seer.matters
        where id = $1 and account_id = $2 and status <> 'closed'`,
      [matterId, accountId],
    );
    if (!existing.rows[0]) throw new Error("matter not found");
    title = existing.rows[0].title;
  } else if (input.createNew) {
    if (!title) throw new Error("matter title required");
    const created = await db().query<{ id: string }>(
      `insert into seer.matters
         (account_id, title, title_source, function_name, function_source)
       values ($1, $2, 'user', $3, 'user')
       returning id`,
      [accountId, title, context.functionName],
    );
    matterId = created.rows[0].id;
  } else {
    // No particular concern was named, and this conversation is already on one:
    // it belongs where it was put. Deriving a name again filed the same email
    // under a second concern, because by then the summary being read was the
    // note left by the first filing rather than what the mail is about.
    const current = await currentMatter(accountId, conversationId);
    if (current) {
      matterId = current.matterId;
      title = current.title;
    } else {
      const ownDomain = context.ownEmail.split("@")[1] ?? "";
      const counterparty = counterpartyOf(context.fromEmail, ownDomain);
      const text = [context.subject, context.summary, context.bodyText].join(" ");
      title = matterNameFrom(
        title || context.summary,
        context.subject,
        counterparty,
        text,
        ownTokens(context.ownEmail),
      );
      matterId = await ensureMatter(accountId, title, {
        text,
        counterparty,
        own: ownTokens(context.ownEmail),
      });
    }
  }

  // A conversation has one current home. Remove an older inferred/user link
  // before recording the explicit choice, otherwise later sweeps see it in two
  // concerns even though the current decision names only one.
  await db().query(
    `delete from seer.matter_conversations mc
      using seer.matters m
      where mc.matter_id = m.id
        and m.account_id = $1
        and mc.conversation_id = $2
        and mc.matter_id <> $3`,
    [accountId, conversationId, matterId],
  );
  await linkConversationToMatter(accountId, matterId, conversationId, "user");
  return { matterId, title };
}
