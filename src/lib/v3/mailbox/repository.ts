import { db } from "@/lib/v2/db/pool";
import type { AccountId } from "@/lib/v2/db/types";
import { signDecisionToken } from "@/lib/v2/view/token";
import { decodeMailboxCursor, encodeMailboxCursor } from "./cursor";
import { effectiveUnread, mailboxListLabel } from "./list-label";
import { TRIAGE_ORDER, deleteRank, dispositionFromHome } from "./triage-rank";
import type { MailboxFolder, MailboxRow, MailboxSort, MailboxView } from "./types";

/**
 * The rank the triage sort orders by, generated from TRIAGE_ORDER so the SQL
 * and the group headings in the list cannot drift apart. `pending` is the else
 * branch: it is the absence of a decision, not a value of `home`.
 */
const DELETE_RANK_SQL = `case d.home
              ${TRIAGE_ORDER.filter((d) => d !== "pending")
                .map((d) => `when '${d}' then ${deleteRank(d)}`)
                .join("\n              ")}
              else ${deleteRank("pending")}
            end`;

type MailboxRowDb = {
  conversation_id: string;
  provider_conversation_id: string;
  provider_message_id: string | null;
  subject: string;
  last_message_at: string | Date | null;
  is_unread: boolean;
  from_email: string | null;
  from_name: string | null;
  to_emails: string[] | null;
  latest_sent_at: string | Date | null;
  latest_outgoing: boolean;
  latest_unread: boolean;
  snippet: string | null;
  attachment_names: string[] | null;
  decision_summary: string | null;
  priority: number | null;
  due_date: string | Date | null;
  matter_title: string | null;
  person_display: string | null;
  recipient_display: string | null;
  decision_id: string | null;
  home: string | null;
  owner: string | null;
  veto_reasons: string[] | null;
  delete_rank: number;
  function_name: string | null;
};

function listLabel(row: MailboxRowDb): string {
  return mailboxListLabel({
    latestOutgoing: row.latest_outgoing,
    personDisplay: row.person_display,
    fromName: row.from_name,
    fromEmail: row.from_email,
    recipientDisplay: row.recipient_display,
    toEmail: row.to_emails?.[0],
  });
}

function isoDate(value: string | Date | null): string | null {
  if (!value) return null;
  const text = value instanceof Date ? value.toISOString() : String(value);
  return text.slice(0, 10);
}

function isoTimestamp(value: string | Date | null): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Matches SQL `coalesce(c.last_message_at, 'epoch'::timestamptz)` for triage cursors. */
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/** Newest message time — falls back to the conversation stamp when sync lags. */
function listTimestamp(row: MailboxRowDb): string {
  return isoTimestamp(row.latest_sent_at ?? row.last_message_at);
}

function mapRow(row: MailboxRowDb): MailboxRow {
  const disposition = dispositionFromHome(row.home);
  // Token only on delete — the command bus refuses deletes without one, so a
  // bulk action in the inbox can never touch vetoed or undecided mail.
  const deleteToken =
    row.home === "delete" && row.decision_id
      ? signDecisionToken(row.decision_id, row.conversation_id)
      : null;
  return {
    conversationId: row.conversation_id,
    providerConversationId: row.provider_conversation_id,
    latestMessageId: row.provider_message_id ?? undefined,
    senderDisplayName: listLabel(row),
    subject: row.subject ?? "",
    timestamp: listTimestamp(row),
    isUnread: effectiveUnread(row.is_unread, row.latest_outgoing, row.latest_unread),
    snippet: row.snippet ?? "",
    attachments: row.attachment_names ?? [],
    decisionSummary: row.decision_summary,
    priority: row.priority,
    dueDate: isoDate(row.due_date),
    matterTitle: row.matter_title,
    disposition,
    deleteRank: row.delete_rank,
    deleteToken,
    category: row.function_name,
    owner: (row.owner ?? "nobody") as MailboxRow["owner"],
    vetoReasons: row.veto_reasons ?? [],
  };
}

const MAILBOX_SELECT = `select c.id as conversation_id,
            c.provider_conversation_id,
            c.subject,
            c.last_message_at,
            c.is_unread,
            c.function_name,
            lm.from_email,
            lm.from_name,
            lm.provider_message_id,
            lm.to_emails,
            lm.sent_at as latest_sent_at,
            lm.is_outgoing as latest_outgoing,
            lm.is_unread as latest_unread,
            lm.snippet,
            lm.attachment_names,
            d.id as decision_id,
            d.home,
            d.summary as decision_summary,
            d.owner,
            d.veto_reasons,
            d.priority,
            d.due_date,
            mt.title as matter_title,
            p.display_name as person_display,
            rp.display_name as recipient_display,
            ${DELETE_RANK_SQL} as delete_rank
       from seer.conversations c
       left join seer.conversation_decisions d
         on d.conversation_id = c.id and d.account_id = c.account_id and d.is_current
       left join seer.matters mt on mt.id = d.matter_id and mt.account_id = c.account_id
       left join lateral (
         select m.from_email,
                m.from_name,
                m.provider_message_id,
                m.to_emails,
                m.sent_at,
                m.is_outgoing,
                m.is_unread,
                m.snippet,
                m.attachment_names
           from seer.messages m
          where m.conversation_id = c.id
          order by m.sent_at desc nulls last, m.provider_message_id desc
          limit 1
       ) lm on true
       left join seer.people p
         on p.account_id = c.account_id and p.email = lm.from_email
       left join seer.people rp
         on rp.account_id = c.account_id and rp.email = lm.to_emails[1]
      where c.account_id = $1
        and c.is_deleted = false
        and c.folders @> array[$2]::text[]`;

export async function getMailboxView(
  accountId: AccountId,
  folder: MailboxFolder,
  limit: number,
  before?: string,
  sort: MailboxSort = "date",
): Promise<MailboxView> {
  const bounded = Math.max(1, Math.min(200, limit));
  const cursor = decodeMailboxCursor(before, sort);
  const totalRow =
    sort === "triage"
      ? await db().query<{ n: number }>(
          `select count(*)::int as n
             from seer.conversations c
             left join seer.conversation_decisions d
               on d.conversation_id = c.id
              and d.account_id = c.account_id
              and d.is_current
            where c.account_id = $1
              and c.is_deleted = false
              and c.folders @> array[$2]::text[]
              and coalesce(d.home, 'pending') <> 'matter'`,
          [accountId, folder],
        )
      : await db().query<{ n: number }>(
          `select count(*)::int as n
             from seer.conversations c
            where c.account_id = $1
              and c.is_deleted = false
              and c.folders @> array[$2]::text[]`,
          [accountId, folder],
        );

  // The ledger's count, over the whole folder — undecided mail is what still
  // needs the user, and it sorts below the fold, so a page-local tally is blind
  // to it.
  const needsYouRow = await db().query<{ n: number }>(
    `select count(*)::int as n
       from seer.conversations c
       join seer.conversation_decisions d
         on d.conversation_id = c.id
        and d.account_id = c.account_id
        and d.is_current
      where c.account_id = $1
        and c.is_deleted = false
        and c.folders @> array[$2]::text[]
        and d.home = 'undecided'`,
    [accountId, folder],
  );

  const rows =
    sort === "triage"
      ? await db().query<MailboxRowDb>(
          `${MAILBOX_SELECT}
        and coalesce(d.home, 'pending') <> 'matter'
        and (
          $3::int is null
          or (
            ${DELETE_RANK_SQL},
            coalesce(d.priority, 0),
            coalesce(c.last_message_at, 'epoch'::timestamptz),
            c.id
          ) > ($3::int, $4::int, $5::timestamptz, $6::uuid)
        )
      order by
        ${DELETE_RANK_SQL} asc,
        coalesce(d.priority, 0) asc,
        coalesce(c.last_message_at, 'epoch'::timestamptz) asc,
        c.id asc
      limit $7`,
          [
            accountId,
            folder,
            cursor && cursor.sort === "triage" ? cursor.rank : null,
            cursor && cursor.sort === "triage" ? cursor.priority : null,
            cursor && cursor.sort === "triage" ? cursor.at : null,
            cursor && cursor.sort === "triage" ? cursor.id : null,
            bounded + 1,
          ],
        )
      : await db().query<MailboxRowDb>(
          `${MAILBOX_SELECT}
        and (
          $3::timestamptz is null
          or (
            coalesce(lm.sent_at, c.last_message_at),
            c.id
          ) < ($3::timestamptz, $4::uuid)
        )
      order by coalesce(lm.sent_at, c.last_message_at) desc nulls last, c.id desc
      limit $5`,
          [
            accountId,
            folder,
            cursor && cursor.sort === "date" ? cursor.at : null,
            cursor && cursor.sort === "date" ? cursor.id : null,
            bounded + 1,
          ],
        );

  const hasMore = rows.rows.length > bounded;
  const page = hasMore ? rows.rows.slice(0, bounded) : rows.rows;
  const last = page[page.length - 1];

  let nextCursor: string | null = null;
  if (hasMore && last) {
    if (sort === "triage") {
      nextCursor = encodeMailboxCursor({
        sort: "triage",
        rank: last.delete_rank,
        priority: last.priority ?? 0,
        at: last.last_message_at ? isoTimestamp(last.last_message_at) : EPOCH_ISO,
        id: last.conversation_id,
      });
    } else {
      const at = listTimestamp(last);
      if (at) {
        nextCursor = encodeMailboxCursor({
          sort: "date",
          at,
          id: last.conversation_id,
        });
      }
    }
  }

  return {
    accountId,
    folder,
    sort,
    rows: page.map(mapRow),
    total: totalRow.rows[0]?.n ?? 0,
    needsYou: needsYouRow.rows[0]?.n ?? 0,
    nextCursor,
  };
}
