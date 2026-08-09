import type { Brief } from "@/lib/inbox/matters";
import { withInboxAccounting } from "@/lib/inbox/inbox-accounting";

export type TriageClearRequest = { id: string; threadId: string };
export type TriageClearAction = { id: string; threadId?: string };

/**
 * Decide whether each requested clear is thread-wide or message-only.
 * A thread that belongs to an active matter is protected: Triage may remove
 * its FYI/noise message, but must not archive the whole live conversation.
 */
export function planTriageClear(
  brief: Brief,
  requested: TriageClearRequest[],
): TriageClearAction[] {
  const matterThreads = new Set(
    [...(brief.pinned ?? []), ...brief.matters].flatMap(
      (matter) => matter.threadIds,
    ),
  );
  const seenThreads = new Set<string>();
  const seenMessages = new Set<string>();
  const actions: TriageClearAction[] = [];
  for (const row of requested) {
    if (matterThreads.has(row.threadId)) {
      if (!seenMessages.has(row.id)) {
        seenMessages.add(row.id);
        actions.push({ id: row.id });
      }
      continue;
    }
    if (!seenThreads.has(row.threadId)) {
      seenThreads.add(row.threadId);
      actions.push({ id: row.id, threadId: row.threadId });
    }
  }
  return actions;
}

/**
 * Apply only SUCCESSFUL provider actions to the stored Brief. Thread actions
 * remove every Triage message in that thread; message actions remove one id.
 * Active matter data is never pruned here (the plan protects those threads).
 */
export function applyTriageClear(
  brief: Brief,
  actions: TriageClearAction[],
): Brief {
  const removedThreads = new Set(
    actions.flatMap((action) => (action.threadId ? [action.threadId] : [])),
  );
  const requestedIds = new Set(actions.map((action) => action.id));
  const removedIds = new Set<string>();

  for (const row of brief.filed ?? []) {
    const ids = row.messageIds?.length ? row.messageIds : [row.emailId];
    if (removedThreads.has(row.threadId)) {
      for (const id of ids) removedIds.add(id);
    } else {
      for (const id of ids) if (requestedIds.has(id)) removedIds.add(id);
    }
  }
  for (const row of brief.headlineIds) {
    if (removedThreads.has(row.threadId) || requestedIds.has(row.id)) {
      removedIds.add(row.id);
    }
  }
  for (const theme of brief.digest?.themes ?? []) {
    for (const item of theme.items ?? []) {
      if (removedThreads.has(item.threadId) || requestedIds.has(item.id)) {
        removedIds.add(item.id);
      }
    }
  }

  const filed = (brief.filed ?? []).flatMap((row) => {
    if (removedThreads.has(row.threadId)) return [];
    const ids = (row.messageIds?.length ? row.messageIds : [row.emailId]).filter(
      (id) => !removedIds.has(id),
    );
    if (ids.length === 0) return [];
    if (ids.length === (row.messageIds?.length ?? 1)) return [row];
    return [
      {
        ...row,
        emailId: ids[ids.length - 1],
        messageIds: ids.length > 1 ? ids : undefined,
        count: ids.length > 1 ? ids.length : undefined,
      },
    ];
  });

  const digest = brief.digest
    ? {
        ...brief.digest,
        themes: brief.digest.themes
          .map((theme) => ({
            ...theme,
            emailIds: theme.emailIds.filter((id) => !removedIds.has(id)),
            items: theme.items?.filter((item) => !removedIds.has(item.id)),
          }))
          .filter((theme) => theme.emailIds.length > 0),
      }
    : brief.digest;

  const removedCount = removedIds.size;
  return withInboxAccounting({
    ...brief,
    filed,
    digest,
    headlines: brief.headlines.filter((row) => !removedIds.has(row.id)),
    headlineIds: brief.headlineIds.filter((row) => !removedIds.has(row.id)),
    totalInbox:
      brief.totalInbox != null
        ? Math.max(0, brief.totalInbox - removedCount)
        : brief.totalInbox,
    providerTotal: brief.providerTotal
      ? {
          ...brief.providerTotal,
          messages: Math.max(
            0,
            brief.providerTotal.messages - removedCount,
          ),
        }
      : brief.providerTotal,
  });
}
