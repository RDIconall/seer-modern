import type { ProviderKind } from "./types";

export type NativeUrlOptions = {
  /** The newest message on the thread. Outlook needs this, not the thread id. */
  messageId?: string | null;
};

/**
 * The one place that builds a provider deep link to an exact conversation. Both
 * the adapters and the inbox view use it, so the "Open in Gmail/Outlook" escape
 * hatch is always correct and consistent.
 *
 * Gmail routes on the thread id, so a conversation is the right thing to hand
 * it. Outlook does not: `/mail/deeplink/read/` resolves an ITEM, and given a
 * conversation id it either spins or lands on "this message might have been
 * moved or deleted". The id has to be a message id, url-encoded, and repeated
 * as `ItemID` — that pair plus `exvsurl=1` is the form OWA still honours, and
 * it is the same shape Graph hands back as a message's `webLink`.
 */
export function nativeUrlFor(
  provider: ProviderKind,
  conversationId: string,
  options: NativeUrlOptions = {},
): string {
  if (provider === "google") {
    return `https://mail.google.com/mail/u/0/#all/${conversationId}`;
  }

  const id = (options.messageId ?? "").trim() || conversationId.trim();
  const encoded = encodeURIComponent(id);
  return `https://outlook.office.com/mail/deeplink/read/${encoded}?ItemID=${encoded}&exvsurl=1`;
}
