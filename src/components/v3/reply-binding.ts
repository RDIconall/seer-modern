import type { Conversation } from "@/lib/v2/providers/types";
import {
  displayNameConflicts,
  mailboxLabel,
  replyMailboxes,
  replyTargets,
  type DisplayNameConflict,
  type ReplyTargets,
} from "@/lib/v2/providers/reply-recipients";

/**
 * What a reply is about to do, fixed at the moment it is shown: the message it
 * answers and every mailbox it goes to. The send carries exactly this, and the
 * server refuses if the provider would address anyone else.
 */
export type ReplyBinding = ReplyTargets & {
  messageId: string;
  all: boolean;
  mailboxes: string[];
  conflicts: DisplayNameConflict[];
  /** Changes whenever anything above does, so a confirmation cannot outlive what it confirmed. */
  key: string;
};

export function replyBinding(
  conversation: Conversation | null | undefined,
  all: boolean,
  ownEmail?: string | null,
): ReplyBinding | null {
  const message = conversation?.messages.at(-1);
  if (!message?.providerMessageId) return null;
  const targets = replyTargets(message, all, ownEmail);
  const mailboxes = replyMailboxes(targets);
  if (mailboxes.length === 0) return null;
  return {
    ...targets,
    messageId: message.providerMessageId,
    all,
    mailboxes,
    conflicts: displayNameConflicts([...targets.to, ...targets.cc]),
    key: JSON.stringify([message.providerMessageId, all, mailboxes]),
  };
}

export function replyRecipientsText(binding: ReplyBinding): string {
  const to = binding.to.map(mailboxLabel).join(", ");
  const cc = binding.cc.map(mailboxLabel).join(", ");
  return cc ? `${to}; cc ${cc}` : to;
}

export function displayNameWarning(binding: ReplyBinding): string {
  return binding.conflicts
    .map(
      (conflict) =>
        `“${conflict.claimed.join(", ")}” is only a display name. This reply goes to ${conflict.email}.`,
    )
    .join(" ");
}

export function confirmRecipientsLabel(binding: ReplyBinding): string {
  return `Send to ${binding.mailboxes.join(", ")}`;
}

export function needsRecipientConfirmation(
  binding: ReplyBinding | null,
  confirmedKey: string | null,
): boolean {
  return Boolean(binding && binding.conflicts.length > 0 && confirmedKey !== binding.key);
}
