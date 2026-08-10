import type { Address, Conversation } from "../providers/types";

/**
 * Pure recipient logic for the reader's reply actions, kept out of the React
 * component so it is testable. Reply goes to the last sender; reply-all adds the
 * other recipients, always excluding the user themselves and deduplicating.
 */

export function replyRecipients(
  conversation: Conversation,
  selfEmail: string,
  all: boolean,
): { to: Address[]; cc: Address[] } {
  const self = selfEmail.toLowerCase();
  const last = conversation.messages[conversation.messages.length - 1];
  if (!last) return { to: [], cc: [] };

  const to = new Map<string, Address>();
  if (last.from.email && last.from.email.toLowerCase() !== self) {
    to.set(last.from.email.toLowerCase(), last.from);
  }

  const cc = new Map<string, Address>();
  if (all) {
    for (const a of [...last.to, ...last.cc]) {
      const key = a.email.toLowerCase();
      if (key === self || to.has(key)) continue;
      cc.set(key, a);
    }
  }
  return { to: [...to.values()], cc: [...cc.values()] };
}

/** A minimal quoted-body prefix for a reply/forward draft. */
export function quoteBody(conversation: Conversation): string {
  const last = conversation.messages[conversation.messages.length - 1];
  if (!last) return "";
  const who = last.from.name || last.from.email;
  const when = last.sentAt;
  const body = last.bodyText ?? last.bodyHtml?.replace(/<[^>]+>/g, " ") ?? last.snippet;
  return `\n\nOn ${when}, ${who} wrote:\n> ${body.replace(/\n/g, "\n> ")}`;
}
