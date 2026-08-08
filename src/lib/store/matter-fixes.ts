import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * MATTER FIXES — the user's own corrections to where a matter sits in
 * their org chart. Ground truth: applied after every model run and fed
 * back into the prompt so the model learns the carving.
 */

export type MatterFixes = Record<string, { orgUnit: string; at: string }>;

function keyFor(accountEmail: string) {
  return `matter-fixes:${accountKey(accountEmail)}`;
}

export async function loadMatterFixes(
  accountEmail: string,
): Promise<MatterFixes> {
  return (await kvGet<MatterFixes>(keyFor(accountEmail))) ?? {};
}

export async function saveMatterFix(
  accountEmail: string,
  matterId: string,
  orgUnit: string,
): Promise<void> {
  const fixes = await loadMatterFixes(accountEmail);
  fixes[matterId] = { orgUnit, at: new Date().toISOString() };
  await kvSet(keyFor(accountEmail), fixes);
}
