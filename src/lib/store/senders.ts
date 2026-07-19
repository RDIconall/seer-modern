import type { TriageAction } from "@/lib/inbox/classify";
import { kvGet, kvSet } from "@/lib/store/kv";

const OVERRIDES_KEY = "sender-overrides";

type OverrideMap = Record<string, TriageAction>;

async function readOverrides(): Promise<OverrideMap> {
  return (await kvGet<OverrideMap>(OVERRIDES_KEY)) ?? {};
}

async function writeOverrides(map: OverrideMap) {
  await kvSet(OVERRIDES_KEY, map);
}

export async function getSenderOverride(
  fromEmail: string,
): Promise<TriageAction | null> {
  const map = await readOverrides();
  return map[fromEmail.toLowerCase()] ?? null;
}

export async function setSenderOverride(
  fromEmail: string,
  action: TriageAction,
) {
  const map = await readOverrides();
  map[fromEmail.toLowerCase()] = action;
  await writeOverrides(map);
}

export async function listSenderOverrides(): Promise<
  { email: string; action: TriageAction }[]
> {
  const map = await readOverrides();
  return Object.entries(map).map(([email, action]) => ({ email, action }));
}
