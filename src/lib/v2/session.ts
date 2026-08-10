import { auth } from "@/auth";
import { db } from "./db/pool";
import { asAccountId, asUserId } from "./db/types";
import type { MailAccount } from "./db/accounts";

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

export async function getActiveV2Account(): Promise<MailAccount | null> {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email || !isV2Enabled(email)) return null;

  const r = await db().query(
    "select id, user_id, provider, email, display_name from seer.mail_accounts where email = $1",
    [email],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: asAccountId(row.id),
    userId: asUserId(row.user_id),
    provider: row.provider,
    email: row.email,
    displayName: row.display_name,
  };
}
