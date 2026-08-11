import { db } from "@/lib/v2/db/pool";
import type { AccountId } from "@/lib/v2/db/types";
import { personName } from "@/lib/v2/view/person-name";
import { decodeMailboxCursor, encodeMailboxCursor } from "./cursor";
import type { MailboxFolder, MailboxRow, MailboxView } from "./types";

type MailboxRowDb = {
  conversation_id: string;
  provider_conversation_id: string;
  subject: string;
  last_message_at: string | Date | null;
  is_unread: boolean;
  from_email: string | null;
  from_name: string | null;
  to_emails: string[] | null;
  is_outgoing: boolean;
  snippet: string | null;
  attachment_names: string[] | null;
  decision_summary: string | null;
  priority: number | null;
  due_date: string | Date | null;
  matter_title: string | null;
  person_display: string | null;
  recipient_display: string | null;
};

function displayFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  if (!local) return email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function senderDisplayName(row: MailboxRowDb): string {
  if (row.is_outgoing) {
    const named = personName(row.recipient_display ?? undefined);
    if (named) return named;
    const to = row.to_emails?.[0];
    return to ? displayFromEmail(to) : personName(row.from_name ?? undefined) || row.from_email || "";
  }
  return (
    personName(row.person_display ?? undefined) ||
    personName(row.from_name ?? undefined) ||
    row.from_email ||
    ""
  );
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

function mapRow(row: MailboxRowDb): MailboxRow {
  return {
    conversationId: row.conversation_id,
    providerConversationId: row.provider_conversation_id,
    senderDisplayName: senderDisplayName(row),
    subject: row.subject ?? "",
    timestamp: isoTimestamp(row.last_message_at),
    isUnread: row.is_unread,
    snippet: row.snippet ?? "",
    attachments: row.attachment_names ?? [],
    decisionSummary: row.decision_summary,
    priority: row.priority,
    dueDate: isoDate(row.due_date),
    matterTitle: row.matter_title,
  };
}

export async function getMailboxView(
  accountId: AccountId,
  folder: MailboxFolder,
  limit: number,
  before?: string,
): Promise<MailboxView> {
  const bounded = Math.max(1, Math.min(200, limit));
  const cursor = decodeMailboxCursor(before);
  const totalRow = await db().query<{ n: number }>(
    `select count(*)::int as n
       from seer.conversations c
      where c.account_id = $1
        and c.is_deleted = false
        and c.folders @> array[$2]::text[]`,
    [accountId, folder],
  );

  const rows = await db().query<MailboxRowDb>(
    `select c.id as conversation_id,
            c.provider_conversation_id,
            c.subject,
            c.last_message_at,
            c.is_unread,
            lm.from_email,
            lm.from_name,
            lm.to_emails,
            lm.is_outgoing,
            lm.snippet,
            lm.attachment_names,
            d.summary as decision_summary,
            d.priority,
            d.due_date,
            mt.title as matter_title,
            p.display_name as person_display,
            rp.display_name as recipient_display
       from seer.conversations c
       left join seer.conversation_decisions d
         on d.conversation_id = c.id and d.is_current
       left join seer.matters mt on mt.id = d.matter_id
       left join lateral (
         select m.from_email,
                m.from_name,
                m.to_emails,
                m.is_outgoing,
                m.snippet,
                m.attachment_names
           from seer.messages m
          where m.conversation_id = c.id
          order by m.sent_at desc nulls last
          limit 1
       ) lm on true
       left join seer.people p
         on p.account_id = c.account_id and p.email = lm.from_email
       left join seer.people rp
         on rp.account_id = c.account_id and rp.email = lm.to_emails[1]
      where c.account_id = $1
        and c.is_deleted = false
        and c.folders @> array[$2]::text[]
        and (
          $3::timestamptz is null
          or (c.last_message_at, c.id) < ($3::timestamptz, $4::uuid)
        )
      order by c.last_message_at desc nulls last, c.id desc
      limit $5`,
    [accountId, folder, cursor?.at ?? null, cursor?.id ?? null, bounded + 1],
  );

  const hasMore = rows.rows.length > bounded;
  const page = hasMore ? rows.rows.slice(0, bounded) : rows.rows;
  const last = page[page.length - 1];

  return {
    folder,
    rows: page.map(mapRow),
    total: totalRow.rows[0]?.n ?? 0,
    nextCursor:
      hasMore && last?.last_message_at
        ? encodeMailboxCursor({
            at: isoTimestamp(last.last_message_at),
            id: last.conversation_id,
          })
        : null,
  };
}
