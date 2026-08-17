import type { Address, Conversation, Message } from "@/lib/v2/providers/types";

/**
 * The quoted thread that hangs below a forward, in the shape Outlook writes it.
 *
 * One module builds this for two callers: the compose pane, which shows the
 * user what they are about to pass on, and the Gmail adapter, which puts it on
 * the wire. Forwarding is the one action where the interesting content is the
 * part the sender did not type, so a compose box that hides it is asking
 * someone to send a thread they cannot read.
 *
 * Formatting is deliberately hand-rolled rather than locale-derived: the same
 * string has to come out of a server render and a browser render, and
 * `toLocaleString` would disagree across the two and tear the hydration.
 */

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "Wednesday, 12 August 2026 15:20" — stable regardless of where it renders. */
export function formatSentAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const minutes = String(at.getUTCMinutes()).padStart(2, "0");
  const hours = String(at.getUTCHours()).padStart(2, "0");
  return `${DAYS[at.getUTCDay()]}, ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} ${hours}:${minutes}`;
}

/** `Sandra Yasavul <sandra@example.com>`, or the bare address when unnamed. */
export function formatAddress(address: Address): string {
  const name = address.name?.trim();
  return name ? `${name} <${address.email}>` : address.email;
}

export function formatAddressList(addresses: Address[]): string {
  return addresses.map(formatAddress).join("; ");
}

export type QuoteHeaderLine = { label: string; value: string };

/**
 * The From/Sent/To/Cc/Subject block Outlook puts above a forwarded message.
 * Cc is omitted rather than shown empty, as Outlook does.
 */
export function quoteHeaderLines(
  message: Message,
  subject: string,
): QuoteHeaderLine[] {
  const lines: QuoteHeaderLine[] = [
    { label: "From", value: formatAddress(message.from) },
    { label: "Sent", value: formatSentAt(message.sentAt) },
    { label: "To", value: formatAddressList(message.to) },
  ];
  if (message.cc.length > 0) {
    lines.push({ label: "Cc", value: formatAddressList(message.cc) });
  }
  lines.push({ label: "Subject", value: subject });
  return lines;
}

function messageBodyHtml(message: Message): string {
  if (message.bodyHtml) return message.bodyHtml;
  if (message.bodyText) return `<pre>${escapeHtml(message.bodyText)}</pre>`;
  return `<p>${escapeHtml(message.snippet)}</p>`;
}

/** Newest first, the way a forwarded thread reads. */
export function quotedMessages(conversation: Conversation): Message[] {
  return [...conversation.messages].reverse();
}

/**
 * Attachments are not carried by the provider contract, so a forward that
 * would silently drop them has to say so.
 */
export function hasAttachments(conversation: Conversation): boolean {
  return conversation.messages.some((m) => m.attachments.length > 0);
}

export function quotedThreadHtml(conversation: Conversation): string {
  return quotedMessages(conversation)
    .map((message) => {
      const header = quoteHeaderLines(message, conversation.subject)
        .map(
          (line) =>
            `<div><strong>${escapeHtml(line.label)}:</strong> ${escapeHtml(line.value)}</div>`,
        )
        .join("");
      return [
        `<div class="seer-quote">`,
        `<hr />`,
        `<div class="seer-quote-header">${header}</div>`,
        messageBodyHtml(message),
        `</div>`,
      ].join("");
    })
    .join("");
}
