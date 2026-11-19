import { accountKey, kvDelete, kvGet, kvSet } from "@/lib/store/kv";

/**
 * The user's EA (executive assistant) — where "Delegate" forwards mail.
 * Stored per account like every other Seer memory. There is deliberately no
 * deployment-wide default: sign-in is open to the whole organization, so a
 * shared address would receive other people's mail.
 */

export type EaContact = {
  email: string;
  name?: string;
  updatedAt: string;
};

function keyFor(accountEmail: string) {
  return `ea:${accountKey(accountEmail)}`;
}

export async function loadEa(accountEmail: string): Promise<EaContact | null> {
  const parsed = await kvGet<EaContact>(keyFor(accountEmail));
  return parsed?.email?.includes("@") ? parsed : null;
}

export async function saveEa(
  accountEmail: string,
  ea: { email: string; name?: string },
): Promise<EaContact> {
  const saved: EaContact = {
    email: ea.email.trim(),
    name: ea.name?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  await kvSet(keyFor(accountEmail), saved);
  return saved;
}

export async function clearEa(accountEmail: string): Promise<void> {
  await kvDelete(keyFor(accountEmail));
}
