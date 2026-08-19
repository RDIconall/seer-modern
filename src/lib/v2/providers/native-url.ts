import type { ProviderKind } from "./types";

export type NativeUrlOptions = {
  /** The newest message in the thread — Outlook needs this, not conversationId. */
  messageId?: string | null;
  /** When Graph returns one, it is the link that actually opens in OWA. */
  webLink?: string | null;
};

/**
 * The one place that builds a provider deep link to an exact conversation. Both
 * the adapters and the inbox view use it, so the "Open in Gmail/Outlook" escape
 * hatch is always correct and consistent.
 *
 * Outlook's `/mail/deeplink/read/` path expects a *message* id with the same id
 * repeated as ItemID — conversation ids spin forever in the in-app browser.
 * When we have Graph's webLink, use it; otherwise build the read deeplink from
 * the latest message we hold.
 */
export function nativeUrlFor(
  provider: ProviderKind,
  conversationId: string,
  options: NativeUrlOptions = {},
): string {
  if (provider === "google") {
    return `https://mail.google.com/mail/u/0/#all/${conversationId}`;
  }

  if (options.webLink?.trim()) return options.webLink.trim();

  const id = (options.messageId ?? conversationId).trim();
  const encoded = encodeURIComponent(id);
  return `https://outlook.office.com/mail/deeplink/read/${encoded}?ItemID=${encoded}&exvsurl=1`;
}
