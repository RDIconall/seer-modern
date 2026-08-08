import { accountKey, kvGet, kvSet } from "@/lib/store/kv";
import type { SalesforceRegistry } from "@/lib/crm/registry";

/**
 * SALESFORCE REGISTRY — persistence only. Types and pure helpers live in
 * @/lib/crm/registry so client components can use them safely.
 */

export * from "@/lib/crm/registry";

const EMPTY: SalesforceRegistry = { studies: [], opportunities: [], sites: [] };

function keyFor(accountEmail: string) {
  return `salesforce:${accountKey(accountEmail)}`;
}

export async function loadSalesforce(
  accountEmail: string,
): Promise<SalesforceRegistry> {
  return (await kvGet<SalesforceRegistry>(keyFor(accountEmail))) ?? EMPTY;
}

export async function saveSalesforce(
  accountEmail: string,
  reg: SalesforceRegistry,
): Promise<void> {
  await kvSet(keyFor(accountEmail), {
    ...reg,
    syncedAt: new Date().toISOString(),
  });
}
