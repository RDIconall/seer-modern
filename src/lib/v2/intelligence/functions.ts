import { db } from "../db/pool";
import type { AccountId } from "../db/types";

/**
 * The sections of the user's whiteboard — their own org chart, not a taxonomy
 * the model invented. A matter may only be filed under a name that exists here,
 * which is what keeps the board stable: the model chooses a shelf, it never
 * builds new ones.
 */

/** The starting registry, matching how the previous system filed matters. */
export const DEFAULT_FUNCTIONS = [
  "board",
  "sales — leads",
  "sales — new requests",
  "sales — contracting",
  "marketing",
  "operations — studies",
  "quality",
  "systems (it)",
  "recruiting",
  "hr",
  "finance (ar/ap)",
  "office / facilities",
  "personal",
];

/**
 * The second axis, for the disposable end of the inbox: what a piece of mail
 * IS, rather than which part of the business owns it. The previous system
 * produced these alongside the functions and triage showed both; these names
 * are taken from what it actually generated for this corpus.
 *
 * Without them everything is forced onto the work axis, and a vendor newsletter
 * gets filed under "systems (it)" as though it were engineering work.
 */
export const DEFAULT_TOPICS = [
  "Newsletters & vendor mail",
  "IT & software notices",
  "Meetings, events & travel",
  "Business & internal reports",
  "Regulatory & compliance bulletins",
  "Data & analytics",
  "Project & document collaboration",
  "Networking & outreach",
  "Financial & tax notices",
  "Shipping & logistics",
  "Personal & social",
];

/** Where a matter goes when nothing fits — never invent a section for it. */
export const UNFILED = "unfiled";

export type RegistryKind = "function" | "topic";

/**
 * The registry, work axis first. Functions come before topics everywhere, so a
 * board and a triage list both lead with the business and end with the noise.
 */
export async function listRegistry(
  accountId: AccountId,
  kind?: RegistryKind,
): Promise<string[]> {
  const result = await db().query<{ name: string }>(
    `select name from seer.functions
      where account_id = $1 and ($2::text is null or kind = $2)
      order by case kind when 'function' then 0 else 1 end, position, name`,
    [accountId, kind ?? null],
  );
  return result.rows.map((r) => r.name);
}

/** Just the parts of the business. Matters may only be filed under these. */
export function listFunctions(accountId: AccountId): Promise<string[]> {
  return listRegistry(accountId, "function");
}

/** Seed one axis of the registry. Existing names keep their position. */
export async function seedRegistry(
  accountId: AccountId,
  names: string[],
  kind: RegistryKind,
): Promise<number> {
  if (names.length === 0) return 0;
  const result = await db().query(
    `insert into seer.functions (account_id, name, position, kind)
     select $1, name, ordinality - 1, $3
       from unnest($2::text[]) with ordinality as t(name, ordinality)
     on conflict (account_id, name) do nothing`,
    [accountId, names, kind],
  );
  return result.rowCount ?? 0;
}

/**
 * First-run only. Once a desk has any shelves — CEO defaults or a custom
 * operating model — cron must not re-insert the default org chart. That is
 * what made a personal mailbox grow thirteen RDI columns it never asked for.
 */
export async function seedFunctions(accountId: AccountId): Promise<number> {
  const existing = await listRegistry(accountId);
  if (existing.length > 0) return 0;
  const functions = await seedRegistry(accountId, DEFAULT_FUNCTIONS, "function");
  const topics = await seedRegistry(accountId, DEFAULT_TOPICS, "topic");
  return functions + topics;
}

export const MAX_FUNCTIONS = 16;
export const MAX_TOPICS = 12;
export const MAX_SECTION_CHARS = 40;

/** Trim, clamp, and drop blanks. Names are unique case-insensitively. */
export function sanitizeSectionNames(
  names: string[],
  limit: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_SECTION_CHARS);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Replace the live registry. Inferred filings whose shelf disappeared are
 * cleared so the next filing pass can re-home them. A filing the user made
 * themselves is left alone even if the name is no longer in the registry —
 * the board already keeps extra sections.
 */
export async function replaceRegistry(
  accountId: AccountId,
  functions: string[],
  topics: string[],
): Promise<{ functions: string[]; topics: string[] }> {
  const nextFunctions = sanitizeSectionNames(functions, MAX_FUNCTIONS);
  const nextTopics = sanitizeSectionNames(topics, MAX_TOPICS);
  if (nextFunctions.length === 0) {
    throw new Error("Atlas needs at least one work section");
  }
  const allowed = new Set(
    [...nextFunctions, ...nextTopics].map((n) => n.toLowerCase()),
  );

  await db().query(
    `delete from seer.functions where account_id = $1`,
    [accountId],
  );
  await seedRegistry(accountId, nextFunctions, "function");
  await seedRegistry(accountId, nextTopics, "topic");

  await db().query(
    `update seer.matters
        set function_name = null, updated_at = now()
      where account_id = $1
        and function_source = 'inferred'
        and (function_name is null or lower(function_name) <> all($2::text[]))`,
    [accountId, [...allowed]],
  );
  await db().query(
    `update seer.conversations
        set function_name = null
      where account_id = $1
        and function_source = 'inferred'
        and (function_name is null or lower(function_name) <> all($2::text[]))`,
    [accountId, [...allowed]],
  );

  return { functions: nextFunctions, topics: nextTopics };
}

/**
 * File a matter under a function. A filing the user made themselves is a
 * decision, so an automatic pass will not move it.
 */
export async function fileMatter(
  matterId: string,
  functionName: string,
  source: "inferred" | "user",
): Promise<boolean> {
  const result = await db().query(
    `update seer.matters
        set function_name = $2, function_source = $3, updated_at = now()
      where id = $1
        and ($3 = 'user' or coalesce(function_source, 'inferred') <> 'user')`,
    [matterId, functionName, source],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * File a conversation under a function. Triage groups by this, so a
 * conversation that never became a matter still lands in the right part of the
 * business. A user's own filing is preserved, exactly as for matters.
 */
export async function fileConversation(
  conversationId: string,
  functionName: string,
  source: "inferred" | "user",
): Promise<boolean> {
  const result = await db().query(
    `update seer.conversations
        set function_name = $2, function_source = $3
      where id = $1
        and ($3 = 'user' or coalesce(function_source, 'inferred') <> 'user')`,
    [conversationId, functionName, source],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Conversations that need a section: they have been read, are not part of a
 * matter (those inherit the matter's section on the board), and are not filed.
 * Newest first, because that is what the user is looking at.
 */
export async function conversationsNeedingFiling(
  accountId: AccountId,
  limit: number,
): Promise<{ id: string; subject: string; from: string; summary: string }[]> {
  const result = await db().query<{
    id: string;
    subject: string | null;
    from_email: string | null;
    summary: string | null;
  }>(
    `select c.id, c.subject, d.summary,
            (select m.from_email from seer.messages m
              where m.conversation_id = c.id
              order by m.sent_at desc nulls last limit 1) as from_email
       from seer.conversations c
       join seer.conversation_decisions d
         on d.conversation_id = c.id
        and d.account_id = c.account_id
        and d.is_current
      where c.account_id = $1
        and c.is_deleted = false
        and c.function_name is null
        and d.home <> 'matter'
      order by c.last_message_at desc nulls last
      limit $2`,
    [accountId, limit],
  );
  return result.rows.map((r) => ({
    id: r.id,
    subject: r.subject ?? "",
    from: r.from_email ?? "",
    summary: r.summary ?? "",
  }));
}

/** Matters still needing a section, newest first. */
export async function mattersNeedingFiling(
  accountId: AccountId,
  limit: number,
): Promise<{ id: string; title: string; orgUnit: string | null }[]> {
  const result = await db().query<{
    id: string;
    title: string;
    org_unit: string | null;
  }>(
    `select id, title, org_unit
       from seer.matters
      where account_id = $1 and function_name is null
      order by updated_at desc
      limit $2`,
    [accountId, limit],
  );
  return result.rows.map((r) => ({
    id: r.id,
    title: r.title,
    orgUnit: r.org_unit,
  }));
}
