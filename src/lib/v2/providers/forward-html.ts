import type { Conversation } from "./types";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function messageBodyHtml(message: Conversation["messages"][number]): string {
  if (message.bodyHtml) return message.bodyHtml;
  if (message.bodyText) {
    return `<pre>${escapeHtml(message.bodyText)}</pre>`;
  }
  return `<p>${escapeHtml(message.snippet)}</p>`;
}

/**
 * Gmail forwards are sent as new messages — include quoted thread content in the
 * outbound HTML. Attachments are not forwarded (provider contract has no bytes).
 */
export function gmailForwardHtml(conversation: Conversation, userBodyHtml: string): string {
  const hasAttachments = conversation.messages.some((m) => m.attachments.length > 0);
  const quoted = conversation.messages
    .map((message) => {
      const who = escapeHtml(message.from.name || message.from.email);
      const when = escapeHtml(message.sentAt);
      const subject = escapeHtml(conversation.subject);
      return [
        `<div class="gmail_quote">`,
        `<div>---------- Forwarded message ---------</div>`,
        `<div>From: <strong>${who}</strong></div>`,
        `<div>Date: ${when}</div>`,
        `<div>Subject: ${subject}</div>`,
        messageBodyHtml(message),
        `</div>`,
      ].join("");
    })
    .join("<br/>");

  const attachmentNote = hasAttachments
    ? `<p><em>Attachments from the original thread are not included in this forward.</em></p>`
    : "";

  return `${userBodyHtml}${attachmentNote}<br/>${quoted}`;
}
