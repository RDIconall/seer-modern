import { MAX_MAILBOX_WRITES } from "@/lib/mail/write-budget";

/**
 * Mail-write routes refuse more than MAX_MAILBOX_WRITES rows and hand back
 * rows their write budget could not cover. Send a big selection one capped
 * batch at a time, putting handed-back rows first in the next batch. A
 * batch that hands everything back made no progress, so stop there.
 */
export async function sendInBatches<T>(
  items: T[],
  send: (batch: T[]) => Promise<T[]>,
): Promise<void> {
  let pending = items;
  while (pending.length > 0) {
    const batch = pending.slice(0, MAX_MAILBOX_WRITES);
    const retry = await send(batch);
    if (retry.length >= batch.length) {
      throw new Error("Mailbox action stalled — try again");
    }
    pending = [...retry, ...pending.slice(batch.length)];
  }
}

export type BulkActionItem = {
  id: string;
  threadId?: string;
  action: "archive" | "trash" | "read";
  fromEmail?: string;
};

export async function postBulkActions(
  items: BulkActionItem[],
): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  await sendInBatches(items, async (batch) => {
    const res = await fetch("/api/action/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: batch }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      processed?: number;
      failed?: number;
      deferred?: string[];
    };
    if (!res.ok) throw new Error(json.error ?? "Bulk failed");
    processed += json.processed ?? 0;
    failed += json.failed ?? 0;
    const deferred = new Set(json.deferred ?? []);
    return batch.filter((item) => deferred.has(item.id));
  });
  return { processed, failed };
}

export type UnsubscribeItem = { id: string; threadId?: string; fromEmail?: string };

/**
 * Unsubscribe in capped batches. Rows whose trash did not fit a batch are
 * already unsubscribed and muted, so only their trash is sent again.
 */
export async function postUnsubscribes(items: UnsubscribeItem[]): Promise<{
  unsubscribed: number;
  links: { id: string; url: string }[];
}> {
  let unsubscribed = 0;
  const links: { id: string; url: string }[] = [];
  const untrashed: { id: string; threadId?: string }[] = [];
  await sendInBatches(items, async (batch) => {
    const res = await fetch("/api/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: batch }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      unsubscribed?: number;
      links?: { id: string; url: string }[];
      untrashed?: { id: string; threadId?: string }[];
    };
    if (!res.ok) throw new Error(json.error ?? "Unsubscribe failed");
    unsubscribed += json.unsubscribed ?? 0;
    links.push(...(json.links ?? []));
    untrashed.push(...(json.untrashed ?? []));
    return [];
  });
  if (untrashed.length > 0) {
    await postBulkActions(
      untrashed.map((row) => ({ ...row, action: "trash" as const })),
    );
  }
  return { unsubscribed, links };
}
