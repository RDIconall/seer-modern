import { db } from "@/lib/v2/db/pool";
import type { AccountId } from "@/lib/v2/db/types";
import type { ContactSuggestion } from "./types";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

/**
 * VIP first, then relationship strength, then how often we actually write.
 * Expressed in SQL so LIMIT can cut after ranking rather than after a full
 * fetch — the right address must land in the first page, not the twentieth.
 */
const TIER_RANK_SQL = `case coalesce(tier, 'unknown')
            when 'inner' then 0
            when 'known' then 1
            when 'new-credible' then 2
            when 'unknown' then 3
            when 'machine' then 4
            else 5
          end`;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

/** Escape LIKE metacharacters so a typed `%` is a literal, not a wildcard. */
function escapeLike(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

type ContactRow = {
  email: string;
  display_name: string | null;
  tier: string;
  vip: boolean;
  exchanges: number;
};

/**
 * Suggest recipients for compose from the active account's person graph and
 * real correspondence. Account isolation is absolute: every source row is
 * filtered by account_id, so an address that only exists on another mailbox
 * can never appear.
 */
export async function suggestContacts(
  accountId: AccountId,
  query: string,
  limit?: number,
): Promise<ContactSuggestion[]> {
  const capped = clampLimit(limit);
  const q = query.trim();
  const pattern = q ? `%${escapeLike(q)}%` : null;

  // The mailbox owner is not a recipient suggestion — same invariant as the
  // legacy compose endpoint, and it keeps self-addresses out of the rank list.
  const result = await db().query<ContactRow>(
    `with self as (
       select lower(trim(email)) as email_key
         from seer.mail_accounts
        where id = $1
     ),
     exchanges as (
       select lower(trim(addr)) as email_key,
              count(*)::int as exchanges,
              min(trim(addr)) as sample_email
         from (
           select m.from_email as addr
             from seer.messages m
            where m.account_id = $1
              and m.from_email is not null
              and trim(m.from_email) <> ''
           union all
           select unnest(m.to_emails) as addr
             from seer.messages m
            where m.account_id = $1
         ) addrs
        where addr is not null and trim(addr) <> ''
          and lower(trim(addr)) <> (select email_key from self)
        group by lower(trim(addr))
     ),
     people as (
       select lower(trim(p.email)) as email_key,
              trim(p.email) as email,
              nullif(trim(p.display_name), '') as display_name,
              p.tier,
              p.vip
         from seer.people p
        where p.account_id = $1
          and lower(trim(p.email)) <> (select email_key from self)
     ),
     merged as (
       select coalesce(p.email, e.sample_email) as email,
              p.display_name,
              coalesce(p.tier, 'unknown') as tier,
              coalesce(p.vip, false) as vip,
              coalesce(e.exchanges, 0) as exchanges
         from people p
         full outer join exchanges e on e.email_key = p.email_key
     )
     select email, display_name, tier, vip, exchanges
       from merged
      where ($2::text is null
             or email ilike $2 escape '\\'
             or coalesce(display_name, '') ilike $2 escape '\\')
      order by vip desc,
               ${TIER_RANK_SQL},
               exchanges desc,
               email asc
      limit $3`,
    [accountId, pattern, capped],
  );

  return result.rows.map((row) => ({
    email: row.email,
    displayName: row.display_name,
    tier: row.tier,
    vip: row.vip,
    exchanges: row.exchanges,
  }));
}
