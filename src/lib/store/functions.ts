import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * THE FUNCTION REGISTRY — the user's own org chart, not the AI's
 * invented taxonomy. Matters resolve their orgUnit against this list;
 * edits are user-only (corrections are law, applied to dimensions).
 */

export const DEFAULT_FUNCTIONS = [
  "board",
  "sales — leads",
  "sales — new requests",
  "sales — contracting",
  "marketing",
  "operations — studies",
  "quality",
  "systems (it)",
  "recruiting",
  "hr",
  "finance (ar/ap)",
  "office / facilities",
  "personal",
];

export const UNSORTED_ORG_UNIT = "unsorted";

/**
 * A model-supplied department name, accepted only when it IS an entry on
 * the registry (ignoring case and surrounding space), returned in the
 * registry's spelling. Mail text steers what the model writes, so a near
 * miss is never "close enough": anything else is undefined, and callers
 * file it as unsorted rather than under the first entry it resembles.
 */
export function registryOrgUnit(
  claimed: string | undefined | null,
  functions: string[],
): string | undefined {
  const wanted = claimed?.trim().toLowerCase();
  if (!wanted) return undefined;
  return functions.find((f) => f.trim().toLowerCase() === wanted);
}

function keyFor(accountEmail: string) {
  return `functions:${accountKey(accountEmail)}`;
}

export async function loadFunctions(accountEmail: string): Promise<string[]> {
  const stored = await kvGet<string[]>(keyFor(accountEmail));
  return stored?.length ? stored : DEFAULT_FUNCTIONS;
}

export async function saveFunctions(
  accountEmail: string,
  functions: string[],
): Promise<void> {
  await kvSet(
    keyFor(accountEmail),
    functions.map((f) => f.trim().toLowerCase()).filter(Boolean),
  );
}
