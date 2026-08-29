import { auth } from "@/auth";
import {
  listOwnedAccounts,
  upsertUser,
  type MailAccount,
} from "./db/accounts";
import { getActiveAccountId } from "../store/accounts";
import { isAllowedOrgEmail } from "@/lib/auth/org";

/**
 * Resolve the signed-in user's active v2 mail account. Returns null when the
 * user is not on the v2 path, so callers fall back to the legacy experience.
 */

/**
 * Every signed-in RDI account is on the v3 client. There is no named-user
 * allowlist; the organization domain is the only gate.
 */
export function isV2Enabled(email: string | null | undefined): boolean {
  return isAllowedOrgEmail(email);
}

export function selectV2Account(
  accounts: MailAccount[],
  activeId: string | null,
  sessionEmail: string,
): MailAccount | null {
  return (
    (activeId
      ? accounts.find((account) => account.id === activeId)
      : undefined) ??
    accounts.find(
      (account) => account.email.toLowerCase() === sessionEmail.toLowerCase(),
    ) ??
    null
  );
}

export function effectiveActiveAccountId(
  accounts: MailAccount[],
  activeId: string | null,
  sessionEmail: string,
): string | null {
  return selectV2Account(accounts, activeId, sessionEmail)?.id ?? null;
}

export async function getActiveV2Account(): Promise<MailAccount | null> {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email || !isV2Enabled(email)) return null;

  const userId = await upsertUser(email);
  const accounts = await listOwnedAccounts(userId);
  // The cookie is absent or invalid/foreign: only the signed-in identity's
  // mailbox is eligible as the fallback. The list is owner-scoped before the
  // cookie is applied, so a foreign id can never switch users.
  return selectV2Account(accounts, await getActiveAccountId(), email);
}
