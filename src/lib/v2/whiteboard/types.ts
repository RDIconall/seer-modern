export const WHITEBOARD_ITEM_STATUSES = ["open", "done", "dropped"] as const;

export type WhiteboardItemStatus = (typeof WHITEBOARD_ITEM_STATUSES)[number];

export type WhiteboardActor = "user" | "bot";

export type WhiteboardCatalogEntry = {
  slug: string;
  title: string;
  subtitle: string | null;
  sortOrder: number;
};

export type WhiteboardItem = {
  id: string;
  accountId: string;
  sectionId: string;
  sectionSlug: string;
  externalKey: string | null;
  title: string;
  body: string | null;
  status: WhiteboardItemStatus;
  priority: number;
  dueAt: string | null;
  ownerLabel: string | null;
  conversationId: string | null;
  matterId: string | null;
  botTaskId: string | null;
  source: WhiteboardActor;
  createdAt: string;
  updatedAt: string;
};

export type WhiteboardSection = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  sortOrder: number;
  items: WhiteboardItem[];
};

export type WhiteboardView = {
  asOf: string;
  /** False when the additive tables have not been migrated yet. */
  persisted: boolean;
  /** True when the Oct 30 seed (or a first-load insert) is what the account holds. */
  seeded: boolean;
  sections: WhiteboardSection[];
};

export type AtlasLens = "board" | "mail" | "bots";

export const ATLAS_LENSES: readonly AtlasLens[] = ["board", "mail", "bots"];

export function isWhiteboardItemStatus(
  value: string,
): value is WhiteboardItemStatus {
  return (WHITEBOARD_ITEM_STATUSES as readonly string[]).includes(value);
}

export function isAtlasLens(value: string | null | undefined): value is AtlasLens {
  return value === "board" || value === "mail" || value === "bots";
}
