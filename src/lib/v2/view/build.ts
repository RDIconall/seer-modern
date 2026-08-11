import { db } from "../db/pool";
import type { AccountId } from "../db/types";
import { nativeUrlFor } from "../providers/native-url";
import type { ProviderKind } from "../providers/types";
import { counterpartyOf } from "../intelligence/matter-key";
import { UNFILED } from "../intelligence/functions";
import { personName } from "./person-name";
import { signDecisionToken } from "./token";
import type {
  AtlasSection,
  ConversationRow,
  Coverage,
  DeleteRow,
  InboxView,
  MatterCard,
  YieldRow,
} from "./types";

/**
 * Build the inbox view for one account from its durable decisions. This is the
 * ONLY place placement is turned into rows. There is no client-side bucketing,
 * no disposition string re-interpreted in the UI: a conversation's home comes
 * straight from its one current decision.
 */

type DecisionRow = {
  conversation_id: string;
  provider_conversation_id: string;
  subject: string;
  from_email: string | null;
  from_display: string | null;
  last_message_at: string | null;
  home: string;
  summary: string;
  owner: string;
  priority: number;
  due_date: string | null;
  veto_reasons: string[];
  decision_id: string;
  matter_id: string | null;
  function_name: string | null;
};

/** Who the work is with. Shown on a row; never what groups it. */
function counterpartyLabel(fromEmail: string | null, ownDomain: string): string {
  const counterparty = counterpartyOf(fromEmail ?? "", ownDomain);
  if (!counterparty) return "";
  if (counterparty === "internal") return "Internal";
  return counterparty.charAt(0).toUpperCase() + counterparty.slice(1);
}

export async function buildInboxView(
  accountId: AccountId,
  provider: ProviderKind,
): Promise<InboxView> {
  const account = await db().query<{ email: string }>(
    "select email from seer.mail_accounts where id = $1",
    [accountId],
  );
  const ownDomain = (account.rows[0]?.email.split("@")[1] ?? "").toLowerCase();

  const rows = await db().query<DecisionRow>(
    `select c.id as conversation_id,
            c.provider_conversation_id,
            c.subject,
            c.last_message_at,
            c.function_name,
            d.id as decision_id,
            d.home,
            d.summary,
            d.owner,
            d.priority,
            d.due_date,
            d.veto_reasons,
            d.matter_id,
            (select m.from_email from seer.messages m
              where m.conversation_id = c.id
              order by m.sent_at desc nulls last limit 1) as from_email,
            -- Show a person, not an address. The user's own contacts win, then
            -- the name the provider carried on the message, and only then the
            -- raw address — "billing@definitivehc.com" tells you nothing about
            -- who is asking.
            (select coalesce(
                      nullif(p.display_name, ''),
                      nullif(m.from_name, ''),
                      m.from_email)
               from seer.messages m
               left join seer.people p
                 on p.account_id = c.account_id and p.email = m.from_email
              where m.conversation_id = c.id
              order by m.sent_at desc nulls last limit 1) as from_display
       from seer.conversations c
       join seer.conversation_decisions d
         on d.conversation_id = c.id
        and d.account_id = c.account_id
        and d.is_current
      where c.account_id = $1
        and c.is_deleted = false
        and c.folders @> array['inbox']::text[]
      -- Loudest first; within a bucket, whatever is due soonest.
      order by d.priority desc, d.due_date asc nulls last, c.last_message_at desc nulls last`,
    [accountId],
  );

  const yieldRows = await db().query<{
    conversation_id: string;
    kind: string;
    headline: string;
    detail: string | null;
    matter_title: string | null;
  }>(
    `select y.conversation_id, y.kind, y.headline, y.detail, m.title as matter_title
       from seer.yields y
       join seer.conversations c
         on c.id = y.conversation_id
        and c.account_id = y.account_id
       left join seer.matters m on m.id = y.matter_id and m.account_id = y.account_id
      where y.account_id = $1
        and c.account_id = $1
        and c.is_deleted = false
        and c.folders @> array['inbox']::text[]`,
    [accountId],
  );

  const matters = await db().query<{
    id: string;
    title: string;
    status: string;
    org_unit: string | null;
    function_name: string | null;
  }>(
    "select id, title, status, org_unit, function_name from seer.matters where account_id = $1",
    [accountId],
  );

  // Registry order decides the order of sections and board columns, so the
  // whiteboard reads the same way every time it is opened. Functions (parts of
  // the business) come before topics (what a piece of mail is), so both the
  // board and triage lead with the work and end with the noise.
  const registry = await db().query<{ name: string }>(
    `select name from seer.functions
      where account_id = $1
      order by case kind when 'function' then 0 else 1 end, position, name`,
    [accountId],
  );

  const toRow = (r: DecisionRow): ConversationRow => ({
    conversationId: r.conversation_id,
    providerConversationId: r.provider_conversation_id,
    subject: r.subject ?? "",
    from: personName(r.from_display) || r.from_email || "",
    at: r.last_message_at ?? "",
    summary: r.summary ?? "",
    owner: r.owner as ConversationRow["owner"],
    priority: r.priority ?? 0,
    dueDate: r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : null,
    // Grouped by the part of the business, not by who it is with.
    category: r.function_name ?? UNFILED,
    counterparty: counterpartyLabel(r.from_email, ownDomain),
    nativeUrl: nativeUrlFor(provider, r.provider_conversation_id),
  });

  const yieldsByConversation = new Map<string, YieldRow[]>();
  for (const y of yieldRows.rows) {
    const list = yieldsByConversation.get(y.conversation_id) ?? [];
    list.push({
      conversationId: y.conversation_id,
      kind: y.kind,
      headline: y.headline,
      detail: y.detail,
      matterTitle: y.matter_title,
    });
    yieldsByConversation.set(y.conversation_id, list);
  }

  const records: ConversationRow[] = [];
  const safeToDelete: DeleteRow[] = [];
  const undecided: ConversationRow[] = [];
  const matterConversations = new Map<string, ConversationRow[]>();

  for (const r of rows.rows) {
    const row = toRow(r);
    if (r.home === "delete") {
      safeToDelete.push({
        ...row,
        deleteToken: signDecisionToken(r.decision_id, r.conversation_id),
        vetoReasons: r.veto_reasons ?? [],
      });
    } else if (r.home === "record") {
      records.push(row);
    } else if (r.home === "matter" && r.matter_id) {
      const list = matterConversations.get(r.matter_id) ?? [];
      list.push(row);
      matterConversations.set(r.matter_id, list);
    } else {
      undecided.push(row);
    }
  }

  const atlas: MatterCard[] = matters.rows.map((m) => {
    const convs = matterConversations.get(m.id) ?? [];
    const cardYields = convs.flatMap(
      (c) => yieldsByConversation.get(c.conversationId) ?? [],
    );
    return {
      matterId: m.id,
      title: m.title,
      status: m.status,
      orgUnit: m.org_unit,
      section: m.function_name ?? UNFILED,
      conversations: convs,
      yields: cardYields,
    };
  });

  const functions = registry.rows.map((r) => r.name);
  const sections = groupIntoSections(atlas, functions);

  const worthReading: YieldRow[] = yieldRows.rows
    .filter((y) => y.kind === "worth_reading")
    .map((y) => ({
      conversationId: y.conversation_id,
      kind: y.kind,
      headline: y.headline,
      detail: y.detail,
      matterTitle: y.matter_title,
    }));

  const coverage = await buildCoverage(accountId);

  return {
    asOf: new Date().toISOString(),
    coverage,
    atlas,
    sections,
    functions,
    records,
    safeToDelete,
    undecided,
    worthReading,
  };
}

/**
 * Group matters into whiteboard sections.
 *
 * Registry order comes first so the board's columns never reshuffle. Empty
 * sections are dropped — an executive's board should not be mostly blank
 * shelves — and anything unfiled sorts last, where it reads as a to-do rather
 * than as a category of work.
 */
export function groupIntoSections(
  matters: MatterCard[],
  registry: string[],
): AtlasSection[] {
  const bySection = new Map<string, MatterCard[]>();
  for (const matter of matters) {
    const list = bySection.get(matter.section) ?? [];
    list.push(matter);
    bySection.set(matter.section, list);
  }

  const ordered: string[] = [
    ...registry.filter((name) => bySection.has(name)),
    // Sections not in the registry (renamed, or legacy) keep a stable place.
    ...[...bySection.keys()]
      .filter((name) => !registry.includes(name) && name !== UNFILED)
      .sort(),
    ...(bySection.has(UNFILED) ? [UNFILED] : []),
  ];

  return ordered.map((name) => ({
    name,
    matters: bySection.get(name) ?? [],
  }));
}

async function buildCoverage(accountId: AccountId): Promise<Coverage> {
  const state = await db().query<{ provider_total: number }>(
    "select provider_total from seer.sync_state where account_id = $1",
    [accountId],
  );
  const stored = await db().query<{ n: number }>(
    "select count(*)::int as n from seer.conversations where account_id = $1 and is_deleted = false",
    [accountId],
  );
  const read = await db().query<{ n: number }>(
    `select count(*)::int as n from seer.conversation_decisions
      where account_id = $1 and is_current and home <> 'undecided'`,
    [accountId],
  );
  const providerTotal = state.rows[0]?.provider_total ?? 0;
  const storedCount = stored.rows[0]?.n ?? 0;
  return {
    providerTotal,
    stored: storedCount,
    read: read.rows[0]?.n ?? 0,
    pending: Math.max(0, storedCount - (read.rows[0]?.n ?? 0)),
  };
}
