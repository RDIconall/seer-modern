import type { MailMessageDetail } from "@/lib/mail/types";

/**
 * Anyone who can deliver mail can grow a conversation, so a conversation read
 * is bounded: only the newest messages are loaded, bodies are downloaded a few
 * at a time, and only a prefix of each body is kept.
 */

/** Newest messages a single conversation read loads. */
export const CONVERSATION_MESSAGE_LIMIT = 20;

/** Message bodies downloaded at the same time while loading a conversation. */
export const CONVERSATION_FETCH_BATCH = 5;

/** Characters kept from each message body. */
export const MESSAGE_BODY_CHAR_LIMIT = 32_768;

function cutAt(body: string, limit: number): string {
  let cut = body.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

export function capText(body: string): string;
export function capText(body: string | null): string | null;
export function capText(body: string | null): string | null {
  if (body === null || body.length <= MESSAGE_BODY_CHAR_LIMIT) return body;
  return cutAt(body, MESSAGE_BODY_CHAR_LIMIT);
}

/** Like capText, but never ends inside a tag. */
export function capHtml(body: string): string;
export function capHtml(body: string | null): string | null;
export function capHtml(body: string | null): string | null {
  if (body === null || body.length <= MESSAGE_BODY_CHAR_LIMIT) return body;
  const cut = cutAt(body, MESSAGE_BODY_CHAR_LIMIT);
  const open = cut.lastIndexOf("<");
  return open > cut.lastIndexOf(">") ? cut.slice(0, open) : cut;
}

export function capMessageDetail(message: MailMessageDetail): MailMessageDetail {
  return {
    ...message,
    textBody: capText(message.textBody),
    htmlBody: capHtml(message.htmlBody),
  };
}

/** Runs `fn` over `items` with at most `size` calls in flight, preserving order. */
export async function mapInBatches<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}
