import type { Address, Message, ReplyCommand } from "./types";

/**
 * Who a reply is addressed to.
 *
 * A From display name is whatever the sender typed, so it can read as a
 * colleague, or even be a colleague's address, while the mailbox behind it is
 * someone else's. The reply only ever goes to the mailbox. The screen and both
 * adapters derive the recipients here, from the parsed mailboxes alone, so what
 * the user is shown and what the provider is told cannot drift apart.
 */

/** Bidi overrides and zero-width marks: enough to reorder or disguise the text printed after a name. */
const INVISIBLE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const MAILBOX = /^[^\s<>()[\]\\,;:"@\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]+@[^\s<>()[\]\\,;:"@\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]+$/;
const EMBEDDED_MAILBOX = /[^\s<>()[\]\\,;:"'@]+@[^\s<>()[\]\\,;:"'@]+\.[^\s<>()[\]\\,;:"'@]+/g;

/** A display name with nothing in it that can rearrange what is shown beside it. */
export function plainDisplayName(name: string | null | undefined): string {
  return (name ?? "").replace(INVISIBLE, "").trim();
}

export function normalizeMailbox(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

function validMailbox(email: string): boolean {
  return MAILBOX.test(email);
}

export type ReplyTargets = { to: Address[]; cc: Address[] };

export function replyTargets(
  message: Pick<Message, "from" | "to" | "cc">,
  all: boolean,
  selfEmail?: string | null,
): ReplyTargets {
  const self = normalizeMailbox(selfEmail);
  const seen = new Set<string>();
  const take = (list: Address[], skipSelf: boolean): Address[] => {
    const out: Address[] = [];
    for (const address of list) {
      const email = normalizeMailbox(address.email);
      if (!validMailbox(email) || seen.has(email)) continue;
      if (skipSelf && self && email === self) continue;
      seen.add(email);
      out.push({ ...address, email });
    }
    return out;
  };
  const sender = take([message.from], false);
  if (!all) return { to: sender, cc: [] };
  return { to: [...sender, ...take(message.to, true)], cc: take(message.cc, true) };
}

export function replyMailboxes(targets: ReplyTargets): string[] {
  return [...targets.to, ...targets.cc].map((address) => address.email);
}

/** Set equality of mailboxes, ignoring case and the account's own address. */
export function sameMailboxes(
  shown: readonly string[],
  actual: readonly string[],
  selfEmail?: string | null,
): boolean {
  const self = normalizeMailbox(selfEmail);
  const set = (list: readonly string[]) =>
    new Set(list.map(normalizeMailbox).filter((email) => email && email !== self));
  const a = set(shown);
  const b = set(actual);
  return a.size === b.size && [...a].every((email) => b.has(email));
}

/** `Name <mailbox>`, or the mailbox alone when there is no distinct name. */
export function mailboxLabel(address: Address): string {
  const email = (address.email ?? "").trim();
  const name = plainDisplayName(address.name);
  if (!name || name.toLowerCase() === email.toLowerCase()) return email || name || "Unknown";
  return email ? `${name} <${email}>` : name;
}

/** Addresses written inside a display name. NFKC folds look-alike forms such as a full-width @. */
export function embeddedMailboxes(name: string | null | undefined): string[] {
  const folded = plainDisplayName(name).normalize("NFKC");
  return [...new Set((folded.match(EMBEDDED_MAILBOX) ?? []).map(normalizeMailbox))];
}

export type DisplayNameConflict = {
  /** The mailbox the reply actually goes to. */
  email: string;
  /** Addresses the display name claims instead. */
  claimed: string[];
};

export function displayNameConflicts(addresses: readonly Address[]): DisplayNameConflict[] {
  const conflicts: DisplayNameConflict[] = [];
  for (const address of addresses) {
    const email = normalizeMailbox(address.email);
    const claimed = embeddedMailboxes(address.name).filter((other) => other !== email);
    if (claimed.length > 0) conflicts.push({ email, claimed });
  }
  return conflicts;
}

export class ReplyRecipientsChanged extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyRecipientsChanged";
  }
}

/**
 * The message a reply acts on and the mailboxes it goes to.
 *
 * When the command carries what the user confirmed, the provider must address
 * exactly those mailboxes or send nothing. The confirmed message is preferred;
 * a provider whose ids move with folders may no longer know it, and then the
 * newest message is used, under the same recipient check.
 */
export function bindReply(
  messages: readonly Message[],
  command: ReplyCommand,
  selfEmail: string,
): { message: Message } & ReplyTargets {
  const confirmed = command.inReplyTo;
  const message =
    (confirmed &&
      messages.find((candidate) => candidate.providerMessageId === confirmed.messageId)) ||
    messages[messages.length - 1];
  if (!message) throw new ReplyRecipientsChanged("This conversation has no message to reply to.");
  const targets = replyTargets(message, command.all, selfEmail);
  const mailboxes = replyMailboxes(targets);
  if (mailboxes.length === 0) {
    throw new ReplyRecipientsChanged("This message has no address a reply can go to.");
  }
  if (confirmed && !sameMailboxes(confirmed.mailboxes, mailboxes, selfEmail)) {
    throw new ReplyRecipientsChanged(
      "The recipients of this reply changed after they were shown. Nothing was sent; review them and send again.",
    );
  }
  return { message, ...targets };
}
