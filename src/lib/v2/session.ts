import { auth } from "@/auth";
import {
  listOwnedAccounts,
  upsertUser,
  type MailAccount,
} from "./db/accounts";
import { getActiveAccountId } from "../store/accounts";

/**
 * Resolve the signed-in user's active v2 mail account, gated by the cutover
 * allowlist. Returns null when the user is not on the v2 path, so callers fall
 * back to the legacy experience during migration.
 */

function allowlist(): Set<string> {
  return new Set(
    (process.env.SEER_V2_ACCOUNT_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isV2Enabled(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = allowlist();
  return list.has(email.toLowerCase());
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
