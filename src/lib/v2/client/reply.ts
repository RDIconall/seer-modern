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

/**
 * The exact list a reply or reply-all will address, in display order. Compose
 * shows this list and pins it on the command; the server sends to it as given
 * and never re-derives recipients from the thread, so what the user confirmed
 * and what goes out cannot differ. Answering your own latest message continues
 * to the people it was sent to.
 */
export function pinnedReplyRecipients(
  conversation: Conversation,
  selfEmail: string | null | undefined,
  all: boolean,
): Address[] {
  const self = (selfEmail ?? "").trim().toLowerCase();
  const { to, cc } = replyRecipients(conversation, self, all);
  let addresses = [...to, ...cc];
  if (!all && addresses.length === 0) {
    const last = conversation.messages[conversation.messages.length - 1];
    addresses = (last?.to ?? []).filter(
      (address) => address.email.toLowerCase() !== self,
    );
  }
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const address of addresses) {
    const email = address.email.trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    out.push({ email, name: address.name });
  }
  return out;
}

/** Name and mailbox together, so a display name can never stand in for the address. */
export function formatAddress(address: Address): string {
  const name = address.name?.trim();
  return name && name.toLowerCase() !== address.email.toLowerCase()
    ? `${name} <${address.email}>`
    : address.email;
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
