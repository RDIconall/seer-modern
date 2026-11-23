import type { Message } from "../providers/types";

/**
 * Bounds for any read that returns a stored thread's bodies. A correspondent
 * controls how many messages a thread has and how large each body is, so a
 * single read must never scale with either.
 */
export const THREAD_READ_MESSAGE_CAP = 20;
export const THREAD_READ_BODY_BYTE_CAP = 256 * 1024;
/** Applies to each statement of a thread read, including time spent waiting on locks. */
export const THREAD_READ_STATEMENT_TIMEOUT_MS = 2_000;

function utf8Bytes(value: string | null | undefined): number {
  return value ? Buffer.byteLength(value, "utf8") : 0;
}

/** Cut `value` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

function truncateBody(message: Message, maxBytes: number): Message {
  if (message.bodyText) {
    return {
      ...message,
      bodyHtml: null,
      bodyText: truncateUtf8(message.bodyText, maxBytes),
      bodyTruncated: true,
    };
  }
  return {
    ...message,
    bodyHtml: message.bodyHtml ? truncateUtf8(message.bodyHtml, maxBytes) : null,
    bodyText: null,
    bodyTruncated: true,
  };
}

/**
 * Keep the newest messages whose bodies fit the byte budget, returned oldest
 * first. The newest message is always kept, shortened if it alone is over the
 * budget; older messages that do not fit are left for a later page.
 */
export function boundThreadMessages(newestFirst: Message[]): Message[] {
  let remaining = THREAD_READ_BODY_BYTE_CAP;
  const kept: Message[] = [];
  for (const message of newestFirst.slice(0, THREAD_READ_MESSAGE_CAP)) {
    const size = utf8Bytes(message.bodyHtml) + utf8Bytes(message.bodyText);
    if (size <= remaining) {
      kept.push(message);
      remaining -= size;
      continue;
    }
    if (kept.length === 0) kept.push(truncateBody(message, remaining));
    break;
  }
  return kept.reverse();
}
