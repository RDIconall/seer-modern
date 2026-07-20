import { accountKey, kvDelete, kvGet, kvSet } from "@/lib/store/kv";

/**
 * The user's EA (executive assistant) — where "Delegate" forwards mail.
 * Stored per account like every other Seer memory.
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
  if (parsed?.email?.includes("@")) return parsed;

  // Serverless fallback: /tmp KV evaporates between instances,
  // SEER_EA_EMAIL (Vercel env var) survives.
  const envEmail = process.env.SEER_EA_EMAIL?.trim();
  if (envEmail?.includes("@")) {
    return {
      email: envEmail,
      name: process.env.SEER_EA_NAME?.trim() || undefined,
      updatedAt: "2000-01-01T00:00:00.000Z",
    };
  }
  return null;
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
