import type { TriageAction } from "@/lib/inbox/classify";
import { kvGet, kvSet } from "@/lib/store/kv";

const OVERRIDES_KEY = "sender-overrides";

type OverrideMap = Record<string, TriageAction>;

// The classifier asks about EVERY sender — one KV round trip per email
// was ~65ms × N, sequentially (the entire "classify is slow" problem).
// One read serves the whole burst; writes invalidate immediately.
let memo: { at: number; map: OverrideMap } | null = null;
let inflight: Promise<OverrideMap> | null = null;
const MEMO_TTL_MS = 15_000;

async function readOverrides(): Promise<OverrideMap> {
  if (memo && Date.now() - memo.at < MEMO_TTL_MS) return memo.map;
  if (!inflight) {
    inflight = (async () => {
      const map = (await kvGet<OverrideMap>(OVERRIDES_KEY)) ?? {};
      memo = { at: Date.now(), map };
      inflight = null;
      return map;
    })();
  }
  return inflight;
}

async function writeOverrides(map: OverrideMap) {
  memo = { at: Date.now(), map };
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
