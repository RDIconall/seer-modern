import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * "While you were away" — the moment the user last opened the app,
 * per account. The catch-up brief summarizes everything graded since.
 */

function keyFor(accountEmail: string) {
  return `last-open:${accountKey(accountEmail)}`;
}

export async function readLastOpen(
  accountEmail: string,
): Promise<string | null> {
  return await kvGet<string>(keyFor(accountEmail));
}

export async function markOpened(accountEmail: string): Promise<void> {
  await kvSet(keyFor(accountEmail), new Date().toISOString());
}
