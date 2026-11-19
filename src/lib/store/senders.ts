import { isTriageAction, type TriageAction } from "@/lib/inbox/classify";
import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

// Teachings belong to the mailbox that made them. The old deployment-wide
// "sender-overrides" document is never read: any signed-in mailbox could
// write to it, so nothing in it can be attributed to an account.
const OVERRIDES_PREFIX = "sender-overrides:";

type OverrideMap = Record<string, TriageAction>;

function overridesKey(accountEmail: string): string {
  return `${OVERRIDES_PREFIX}${accountKey(accountEmail)}`;
}

function sanitize(raw: unknown): OverrideMap {
  const map: OverrideMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [email, action] of Object.entries(raw)) {
    if (isTriageAction(action)) map[email] = action;
  }
  return map;
}

// The classifier asks about EVERY sender — one KV round trip per email
// was ~65ms × N, sequentially (the entire "classify is slow" problem).
// One read serves the whole burst; writes invalidate immediately.
const memo = new Map<string, { at: number; map: OverrideMap }>();
const inflight = new Map<string, Promise<OverrideMap>>();
const MEMO_TTL_MS = 15_000;

async function readOverrides(key: string): Promise<OverrideMap> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.map;
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const map = sanitize(await kvGet<unknown>(key));
        memo.set(key, { at: Date.now(), map });
        return map;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
  }
  return pending;
}

async function writeOverrides(key: string, map: OverrideMap) {
  memo.set(key, { at: Date.now(), map });
  await kvSet(key, map);
}

/**
 * The mailbox a call acts for. Routes pass the account they resolved;
 * without one, fall back to the signed-in mailbox, and to no mailbox at
 * all outside a request.
 */
async function resolveAccount(accountEmail?: string): Promise<string | null> {
  if (accountEmail?.trim()) return accountEmail;
  try {
    const { requireMailSession } = await import("@/lib/mail/session");
    const session = await requireMailSession();
    return session?.email?.trim() ? session.email : null;
  } catch {
    return null;
  }
}

export async function getSenderOverride(
  fromEmail: string,
  accountEmail?: string,
): Promise<TriageAction | null> {
  const account = await resolveAccount(accountEmail);
  if (!account) return null;
  const map = await readOverrides(overridesKey(account));
  const action = map[fromEmail.toLowerCase()];
  return isTriageAction(action) ? action : null;
}

export async function setSenderOverride(
  fromEmail: string,
  action: TriageAction,
  accountEmail?: string,
) {
  if (!isTriageAction(action)) {
    throw new Error(`Unknown triage action: ${String(action)}`);
  }
  const account = await resolveAccount(accountEmail);
  if (!account) throw new Error("No mailbox to teach this sender for");
  const key = overridesKey(account);
  const map = { ...(await readOverrides(key)) };
  map[fromEmail.toLowerCase()] = action;
  await writeOverrides(key, map);
}

export async function listSenderOverrides(accountEmail?: string): Promise<
  { email: string; action: TriageAction }[]
> {
  const account = await resolveAccount(accountEmail);
  if (!account) return [];
  const map = await readOverrides(overridesKey(account));
  return Object.entries(map).map(([email, action]) => ({ email, action }));
}
