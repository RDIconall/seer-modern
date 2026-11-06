import type { MatterCard } from "../view/types";
import type { StaffTask, StaffView } from "../staff/types";
import type { AtlasLens, WhiteboardItem, WhiteboardView } from "./types";

export type AtlasAnchorKind = "matter" | "item" | "task";

export type AtlasAnchor = {
  kind: AtlasAnchorKind;
  id: string;
  title: string;
  section: string;
  status: string;
  nextAction: string | null;
  owner: string | null;
  conversationId: string | null;
  lens: AtlasLens;
};

function latestConversationId(matter: MatterCard): string | null {
  let latest: string | null = null;
  let latestAt = -1;
  for (const conversation of matter.conversations) {
    const at = conversation.at ? Date.parse(conversation.at) : NaN;
    const rank = Number.isNaN(at) ? 0 : at;
    if (rank >= latestAt) {
      latestAt = rank;
      latest = conversation.conversationId;
    }
  }
  return latest;
}

export function matterOwnsConversation(
  matter: MatterCard,
  conversationId: string,
): boolean {
  return matter.conversations.some(
    (conversation) => conversation.conversationId === conversationId,
  );
}

export function findMatterForConversation(
  matters: readonly MatterCard[],
  conversationId: string | null | undefined,
): MatterCard | null {
  if (!conversationId) return null;
  return (
    matters.find((matter) => matterOwnsConversation(matter, conversationId)) ??
    null
  );
}

export function findItemForConversation(
  view: WhiteboardView | null | undefined,
  conversationId: string | null | undefined,
): WhiteboardItem | null {
  if (!view || !conversationId) return null;
  for (const section of view.sections) {
    const item = section.items.find(
      (row) => row.conversationId === conversationId,
    );
    if (item) return item;
  }
  return null;
}

export function findTaskForConversation(
  view: StaffView | null | undefined,
  conversationId: string | null | undefined,
): StaffTask | null {
  if (!view || !conversationId) return null;
  return (
    view.tasks.find((task) => task.conversationId === conversationId) ?? null
  );
}

export function anchorFromMatter(matter: MatterCard): AtlasAnchor {
  return {
    kind: "matter",
    id: matter.matterId,
    title: matter.shortTitle || matter.title,
    section: matter.section,
    status: matter.status,
    nextAction: matter.nextAction || null,
    owner: matter.owner === "you" ? "You" : matter.owner,
    conversationId: latestConversationId(matter),
    lens: "mail",
  };
}

export function anchorFromItem(
  item: WhiteboardItem,
  sectionTitle?: string,
): AtlasAnchor {
  return {
    kind: "item",
    id: item.id,
    title: item.title,
    section: sectionTitle || item.sectionSlug,
    status: item.status,
    nextAction: item.body,
    owner: item.ownerLabel,
    conversationId: item.conversationId,
    lens: "board",
  };
}

export function anchorFromTask(task: StaffTask): AtlasAnchor {
  return {
    kind: "task",
    id: task.id,
    title: task.title,
    section: task.botName,
    status: task.status,
    nextAction: task.nextAction,
    owner: task.botName,
    conversationId: task.conversationId ?? null,
    lens: "bots",
  };
}

/**
 * Prefer a whiteboard item that explicitly links the thread, then the Atlas
 * matter that owns it, then a bot task. Opening `#section=atlas&conversation=`
 * must land on the mail-backed task, not a bot that happens to cite the same
 * thread.
 */
export function findAnchorForConversation(input: {
  conversationId: string | null | undefined;
  matters: readonly MatterCard[];
  whiteboard?: WhiteboardView | null;
  staff?: StaffView | null;
}): AtlasAnchor | null {
  const { conversationId } = input;
  if (!conversationId) return null;
  const item = findItemForConversation(input.whiteboard, conversationId);
  if (item) {
    const section = input.whiteboard?.sections.find(
      (row) => row.id === item.sectionId,
    );
    return anchorFromItem(item, section?.title);
  }
  const matter = findMatterForConversation(input.matters, conversationId);
  if (matter) return anchorFromMatter(matter);
  const task = findTaskForConversation(input.staff, conversationId);
  return task ? anchorFromTask(task) : null;
}
