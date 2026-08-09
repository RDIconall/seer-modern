import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * SETTLED MATTERS — matters the user has closed. Kept as a client overlay
 * by matter id so the matter still exists in the brief (its conversations
 * are untouched) but the board files it into the greyed "Settled" column.
 * Dragging a matter back out clears its entry and reopens it.
 */

export type SettledMatters = Record<string, { at: string }>;

function keyFor(accountEmail: string) {
  return `settled-matters:${accountKey(accountEmail)}`;
}

export async function loadSettledMatters(
  accountEmail: string,
): Promise<SettledMatters> {
  return (await kvGet<SettledMatters>(keyFor(accountEmail))) ?? {};
}

export async function settleMatter(
  accountEmail: string,
  matterId: string,
): Promise<SettledMatters> {
  const settled = await loadSettledMatters(accountEmail);
  settled[matterId] = { at: new Date().toISOString() };
  await kvSet(keyFor(accountEmail), settled);
  return settled;
}

export async function unsettleMatter(
  accountEmail: string,
  matterId: string,
): Promise<SettledMatters> {
  const settled = await loadSettledMatters(accountEmail);
  delete settled[matterId];
  await kvSet(keyFor(accountEmail), settled);
  return settled;
}
