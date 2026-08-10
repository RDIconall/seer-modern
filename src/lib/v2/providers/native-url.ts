import type { ProviderKind } from "./types";

/**
 * The one place that builds a provider deep link to an exact conversation. Both
 * the adapters and the inbox view use it, so the "Open in Gmail/Outlook" escape
 * hatch is always correct and consistent.
 */
export function nativeUrlFor(provider: ProviderKind, conversationId: string): string {
  if (provider === "google") {
    return `https://mail.google.com/mail/u/0/#all/${conversationId}`;
  }
  return `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(conversationId)}`;
}
