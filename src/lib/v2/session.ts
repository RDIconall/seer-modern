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

/**
 * Cookie is the explicit switch from Settings. When it is missing — a fresh
 * login, or the Auth.js jwt callback failing to write cookies — the mailbox
 * signed into (JWT / session) is the one that must appear, not another owned
 * account leftover from last week.
 */
export function resolveMailboxAccount(
  accounts: MailAccount[],
  cookieId: string | null | undefined,
  sessionAccountId: string | null | undefined,
  sessionEmail: string,
): MailAccount | null {
  const fromCookie = cookieId
    ? accounts.find((account) => account.id === cookieId)
    : undefined;
  if (fromCookie) return fromCookie;
  const fromSession = sessionAccountId
    ? accounts.find((account) => account.id === sessionAccountId)
    : undefined;
  if (fromSession) return fromSession;
  return selectV2Account(accounts, null, sessionEmail);
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
  return resolveMailboxAccount(
    accounts,
    await getActiveAccountId(),
    session?.activeAccountId,
    email,
  );
}
