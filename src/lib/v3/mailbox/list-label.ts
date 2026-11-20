import { personName } from "@/lib/v2/view/person-name";
import { plainDisplayName } from "@/lib/v2/providers/reply-recipients";

/** Turn `may.yau` into `May Yau` so a recipient never reads as a month. */
export function formatLocalPart(local: string): string {
  const trimmed = local.trim();
  if (!trimmed) return "";
  if (trimmed.includes(".")) {
    return trimmed
      .split(".")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return formatLocalPart(local);
}

/**
 * The name column on a mailbox row.
 *
 * Incoming mail names the sender. When you sent the latest message, it names
 * who you wrote to — with an explicit To: so May Yau never reads as mail
 * "from May".
 */
export function mailboxListLabel(input: {
  latestOutgoing: boolean;
  personDisplay?: string | null;
  fromName?: string | null;
  fromEmail?: string | null;
  recipientDisplay?: string | null;
  toEmail?: string | null;
}): string {
  if (input.latestOutgoing) {
    const named =
      personName(input.recipientDisplay ?? undefined) ||
      (input.toEmail ? nameFromEmail(input.toEmail) : "") ||
      personName(input.fromName ?? undefined) ||
      "";
    return named ? `To ${named}` : "To …";
  }

  // Incoming names are the sender's to choose, so the mailbox always rides along.
  const email = (input.fromEmail ?? "").trim();
  const named =
    personName(plainDisplayName(input.personDisplay)) ||
    personName(plainDisplayName(input.fromName));
  if (!email) return named;
  if (!named || named.toLowerCase() === email.toLowerCase()) return email;
  return `${named} <${email}>`;
}

/**
 * A thread you have already answered should not stay bold just because an
 * older message in the chain is still marked unread in the provider.
 */
export function effectiveUnread(
  conversationUnread: boolean,
  latestOutgoing: boolean,
  latestUnread: boolean,
): boolean {
  if (latestOutgoing && !latestUnread) return false;
  return conversationUnread;
}
