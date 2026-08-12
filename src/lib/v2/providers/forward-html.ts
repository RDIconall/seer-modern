import { hasAttachments, quotedThreadHtml } from "@/lib/v3/compose/quoted-thread";
import type { Conversation } from "./types";

/**
 * Gmail forwards are sent as new messages — include quoted thread content in the
 * outbound HTML. Attachments are not forwarded (provider contract has no bytes).
 *
 * Quote markup comes from the shared Outlook-style builder so the compose
 * preview and the MIME body cannot drift apart.
 */
export function gmailForwardHtml(conversation: Conversation, userBodyHtml: string): string {
  const attachmentNote = hasAttachments(conversation)
    ? `<p><em>Attachments from the original thread are not included in this forward.</em></p>`
    : "";

  return `${userBodyHtml}${attachmentNote}${quotedThreadHtml(conversation)}`;
}
