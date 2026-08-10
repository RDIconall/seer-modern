import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * MATTER ORDER — the user's own priority order within each column of the
 * Atlas whiteboard. Matters normally sort by urgency and money; once the
 * user drags a matter into place, that column's order is theirs and
 * survives every rebuild (the board applies it as an overlay by id).
 */

export type MatterOrder = Record<string, string[]>;

function keyFor(accountEmail: string) {
  return `matter-order:${accountKey(accountEmail)}`;
}

export async function loadMatterOrder(
  accountEmail: string,
): Promise<MatterOrder> {
  return (await kvGet<MatterOrder>(keyFor(accountEmail))) ?? {};
}

export async function saveMatterOrder(
  accountEmail: string,
  orgUnit: string,
  orderedIds: string[],
): Promise<MatterOrder> {
  const order = await loadMatterOrder(accountEmail);
  order[orgUnit] = [...new Set(orderedIds)];
  await kvSet(keyFor(accountEmail), order);
  return order;
}
