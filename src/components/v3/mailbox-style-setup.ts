/**
 * When the first-run overlay stays on screen.
 *
 * Confirmed state lives on the payload loaded at mount. Saving must flip that
 * payload locally; navigating to Cards is not a dismiss.
 */

export type MailboxStyleOverlayData = {
  confirmed: boolean;
  driftPrompt: string | null;
};

export function applyConfirmedMailboxStyle<T extends MailboxStyleOverlayData>(
  data: T,
): T {
  return { ...data, confirmed: true, driftPrompt: null };
}

export function mailboxStyleOverlayOpen({
  data,
  error,
  force,
}: {
  data: MailboxStyleOverlayData | null;
  error: string | null;
  force?: boolean;
}): boolean {
  if (data && data.confirmed && !force && !data.driftPrompt) return false;
  if (!data && !error) return false;
  return true;
}
