import { db } from "../db/pool";
import type { AccountId } from "../db/types";
import { nativeUrlFor } from "../providers/native-url";
import type { ProviderKind } from "../providers/types";
import { signDecisionToken } from "./token";
import type {
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
  last_message_at: string | null;
  home: string;
  summary: string;
  owner: string;
  priority: number;
  veto_reasons: string[];
  decision_id: string;
  matter_id: string | null;
};

export async function buildInboxView(
  accountId: AccountId,
  provider: ProviderKind,
): Promise<InboxView> {
  const rows = await db().query<DecisionRow>(
    `select c.id as conversation_id,
            c.provider_conversation_id,
            c.subject,
            c.last_message_at,
            d.id as decision_id,
            d.home,
            d.summary,
            d.owner,
            d.priority,
            d.veto_reasons,
            d.matter_id,
            (select m.from_email from seer.messages m
              where m.conversation_id = c.id
              order by m.sent_at desc nulls last limit 1) as from_email
       from seer.conversations c
       join seer.conversation_decisions d
         on d.conversation_id = c.id and d.is_current
      where c.account_id = $1 and c.is_deleted = false
      order by d.priority desc, c.last_message_at desc nulls last`,
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
       left join seer.matters m on m.id = y.matter_id
      where y.account_id = $1`,
    [accountId],
  );

  const matters = await db().query<{
    id: string;
    title: string;
    status: string;
    org_unit: string | null;
  }>(
    "select id, title, status, org_unit from seer.matters where account_id = $1",
    [accountId],
  );

  const toRow = (r: DecisionRow): ConversationRow => ({
    conversationId: r.conversation_id,
    providerConversationId: r.provider_conversation_id,
    subject: r.subject ?? "",
    from: r.from_email ?? "",
    at: r.last_message_at ?? "",
    summary: r.summary ?? "",
    owner: r.owner as ConversationRow["owner"],
    priority: r.priority ?? 0,
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
      conversations: convs,
      yields: cardYields,
    };
  });

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
    records,
    safeToDelete,
    undecided,
    worthReading,
  };
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
