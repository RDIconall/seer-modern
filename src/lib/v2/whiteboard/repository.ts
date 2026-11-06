import type { Pool, PoolClient } from "pg";
import { db } from "../db/pool";
import { inTransaction } from "../db/transaction";
import { isMissingRelation } from "../db/missing";
import { isUuid, type AccountId } from "../db/types";
import { WHITEBOARD_CATALOG } from "./domains";
import { WHITEBOARD_SEED_ITEMS, seedWhiteboardView } from "./seed";
import {
  isWhiteboardItemStatus,
  type WhiteboardActor,
  type WhiteboardItem,
  type WhiteboardItemStatus,
  type WhiteboardSection,
  type WhiteboardView,
} from "./types";

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

let tablesKnown: boolean | null = null;

export async function whiteboardTablesReady(
  client: Runner = runner(),
): Promise<boolean> {
  if (tablesKnown !== null) return tablesKnown;
  try {
    const r = await client.query<{ exists: boolean }>(
      `select exists (
         select 1 from information_schema.tables
          where table_schema = 'seer' and table_name = 'whiteboard_items'
       ) as exists`,
    );
    tablesKnown = Boolean(r.rows[0]?.exists);
  } catch (error) {
    if (isMissingRelation(error)) {
      tablesKnown = false;
      return false;
    }
    throw error;
  }
  return tablesKnown;
}

/** Tests may boot a fresh database after the process-level probe ran. */
export function resetWhiteboardTableCache(): void {
  tablesKnown = null;
}

type SectionRow = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  sort_order: number;
};

type ItemRow = {
  id: string;
  account_id: string;
  section_id: string;
  section_slug: string;
  external_key: string | null;
  title: string;
  body: string | null;
  status: string;
  priority: number;
  due_at: Date | null;
  owner_label: string | null;
  conversation_id: string | null;
  matter_id: string | null;
  bot_task_id: string | null;
  source: string;
  created_at: Date;
  updated_at: Date;
};

function asItem(row: ItemRow): WhiteboardItem {
  return {
    id: row.id,
    accountId: row.account_id,
    sectionId: row.section_id,
    sectionSlug: row.section_slug,
    externalKey: row.external_key,
    title: row.title,
    body: row.body,
    status: isWhiteboardItemStatus(row.status) ? row.status : "open",
    priority: row.priority,
    dueAt: iso(row.due_at),
    ownerLabel: row.owner_label,
    conversationId: row.conversation_id,
    matterId: row.matter_id,
    botTaskId: row.bot_task_id,
    source: row.source === "bot" ? "bot" : "user",
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
  };
}

const ITEM_SELECT = `
  select i.id, i.account_id, i.section_id, s.slug as section_slug,
         i.external_key, i.title, i.body, i.status, i.priority, i.due_at,
         i.owner_label, i.conversation_id, i.matter_id, i.bot_task_id,
         i.source, i.created_at, i.updated_at
    from seer.whiteboard_items i
    join seer.whiteboard_sections s on s.id = i.section_id
`;

async function ensureCatalog(
  accountId: AccountId,
  client: Runner,
): Promise<SectionRow[]> {
  for (const entry of WHITEBOARD_CATALOG) {
    await client.query(
      `insert into seer.whiteboard_sections (account_id, slug, title, subtitle, sort_order)
       values ($1, $2, $3, $4, $5)
       on conflict (account_id, slug) do update
         set title = excluded.title,
             subtitle = excluded.subtitle,
             sort_order = excluded.sort_order`,
      [accountId, entry.slug, entry.title, entry.subtitle, entry.sortOrder],
    );
  }
  const r = await client.query<SectionRow>(
    `select id, slug, title, subtitle, sort_order
       from seer.whiteboard_sections
      where account_id = $1
      order by sort_order, slug`,
    [accountId],
  );
  return r.rows;
}

async function seedIfEmpty(
  accountId: AccountId,
  sections: SectionRow[],
  client: Runner,
): Promise<boolean> {
  const existing = await client.query<{ n: number }>(
    `select count(*)::int as n from seer.whiteboard_items where account_id = $1`,
    [accountId],
  );
  if ((existing.rows[0]?.n ?? 0) > 0) return false;
  const bySlug = new Map(sections.map((row) => [row.slug, row.id]));
  for (const row of WHITEBOARD_SEED_ITEMS) {
    const sectionId = bySlug.get(row.section);
    if (!sectionId) continue;
    await client.query(
      `insert into seer.whiteboard_items (
         account_id, section_id, external_key, title, status, priority,
         owner_label, source
       )
       select $1,$2,$3,$4,$5,$6,$7,'user'
        where not exists (
          select 1 from seer.whiteboard_items
           where account_id = $1 and external_key = $3
        )`,
      [
        accountId,
        sectionId,
        row.externalKey,
        row.title,
        row.status ?? "open",
        row.priority ?? 100,
        row.ownerLabel ?? null,
      ],
    );
  }
  return true;
}

export async function loadWhiteboardView(
  accountId: AccountId,
): Promise<WhiteboardView> {
  const ready = await whiteboardTablesReady();
  if (!ready) {
    return seedWhiteboardView(accountId);
  }
  try {
    return await inTransaction(async (client) => {
      const sections = await ensureCatalog(accountId, client);
      const seeded = await seedIfEmpty(accountId, sections, client);
      const itemsRes = await client.query<ItemRow>(
        `${ITEM_SELECT}
          where i.account_id = $1
          order by i.priority asc, i.created_at asc`,
        [accountId],
      );
      const items = itemsRes.rows.map(asItem);
      const grouped = new Map<string, WhiteboardItem[]>();
      for (const item of items) {
        const list = grouped.get(item.sectionId) ?? [];
        list.push(item);
        grouped.set(item.sectionId, list);
      }
      const viewSections: WhiteboardSection[] = sections.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        subtitle: row.subtitle,
        sortOrder: row.sort_order,
        items: grouped.get(row.id) ?? [],
      }));
      return {
        asOf: new Date().toISOString(),
        persisted: true,
        seeded,
        sections: viewSections,
      };
    });
  } catch (error) {
    if (isMissingRelation(error)) {
      tablesKnown = false;
      return seedWhiteboardView(accountId);
    }
    throw error;
  }
}

export async function getWhiteboardItem(
  accountId: AccountId,
  itemId: string,
  client: Runner = runner(),
): Promise<WhiteboardItem | null> {
  if (!isUuid(itemId)) return null;
  const r = await client.query<ItemRow>(
    `${ITEM_SELECT} where i.account_id = $1 and i.id = $2`,
    [accountId, itemId],
  );
  return r.rows[0] ? asItem(r.rows[0]) : null;
}

export type CreateWhiteboardItemInput = {
  accountId: AccountId;
  sectionSlug: string;
  title: string;
  body?: string | null;
  status?: WhiteboardItemStatus;
  priority?: number;
  dueAt?: string | null;
  ownerLabel?: string | null;
  conversationId?: string | null;
  externalKey?: string | null;
  source?: WhiteboardActor;
};

export async function createWhiteboardItem(
  input: CreateWhiteboardItemInput,
): Promise<WhiteboardItem> {
  const title = input.title.trim();
  if (!title) throw new Error("a whiteboard item needs a title");
  if (!(await whiteboardTablesReady())) {
    throw new Error("whiteboard tables are not migrated yet");
  }
  return inTransaction(async (client) => {
    const sections = await ensureCatalog(input.accountId, client);
    const section =
      sections.find((row) => row.slug === input.sectionSlug.trim()) ?? sections[0];
    if (!section) throw new Error("unknown whiteboard section");
    const r = await client.query<ItemRow>(
      `insert into seer.whiteboard_items (
         account_id, section_id, external_key, title, body, status, priority,
         due_at, owner_label, conversation_id, source
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning id, account_id, section_id, $12::text as section_slug,
                 external_key, title, body, status, priority, due_at,
                 owner_label, conversation_id, matter_id, bot_task_id,
                 source, created_at, updated_at`,
      [
        input.accountId,
        section.id,
        input.externalKey?.trim() || null,
        title,
        input.body ?? null,
        input.status ?? "open",
        input.priority ?? 100,
        input.dueAt ?? null,
        input.ownerLabel ?? null,
        input.conversationId && isUuid(input.conversationId)
          ? input.conversationId
          : null,
        input.source ?? "user",
        section.slug,
      ],
    );
    return asItem(r.rows[0]);
  });
}

export type UpdateWhiteboardItemPatch = {
  title?: string;
  body?: string | null;
  status?: WhiteboardItemStatus;
  sectionSlug?: string;
  priority?: number;
  dueAt?: string | null;
  ownerLabel?: string | null;
  conversationId?: string | null;
};

export async function updateWhiteboardItem(
  accountId: AccountId,
  itemId: string,
  patch: UpdateWhiteboardItemPatch,
): Promise<WhiteboardItem> {
  if (!isUuid(itemId)) throw new Error("item not found");
  if (!(await whiteboardTablesReady())) {
    throw new Error("whiteboard tables are not migrated yet");
  }
  return inTransaction(async (client) => {
    const current = await getWhiteboardItem(accountId, itemId, client);
    if (!current) throw new Error("item not found");
    let sectionId = current.sectionId;
    let sectionSlug = current.sectionSlug;
    if (patch.sectionSlug && patch.sectionSlug !== current.sectionSlug) {
      const sections = await ensureCatalog(accountId, client);
      const next = sections.find((row) => row.slug === patch.sectionSlug);
      if (!next) throw new Error("unknown whiteboard section");
      sectionId = next.id;
      sectionSlug = next.slug;
    }
    const title = patch.title?.trim() || current.title;
    const status = patch.status ?? current.status;
    const r = await client.query<ItemRow>(
      `update seer.whiteboard_items set
         section_id = $3,
         title = $4,
         body = $5,
         status = $6,
         priority = $7,
         due_at = $8,
         owner_label = $9,
         conversation_id = $10
       where account_id = $1 and id = $2
       returning id, account_id, section_id, $11::text as section_slug,
                 external_key, title, body, status, priority, due_at,
                 owner_label, conversation_id, matter_id, bot_task_id,
                 source, created_at, updated_at`,
      [
        accountId,
        itemId,
        sectionId,
        title,
        patch.body === undefined ? current.body : patch.body,
        status,
        patch.priority ?? current.priority,
        patch.dueAt === undefined ? current.dueAt : patch.dueAt,
        patch.ownerLabel === undefined ? current.ownerLabel : patch.ownerLabel,
        patch.conversationId === undefined
          ? current.conversationId
          : patch.conversationId && isUuid(patch.conversationId)
            ? patch.conversationId
            : null,
        sectionSlug,
      ],
    );
    if (!r.rows[0]) throw new Error("item not found");
    return asItem(r.rows[0]);
  });
}
