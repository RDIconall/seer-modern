import type { TriageAction } from "@/lib/inbox/classify";
import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * Native Gmail labels as the durable decision store: Gemini reviews a
 * message once and its call is saved as a `Seer/<action>` label on the
 * message itself. Later loads read the label — zero tokens, survives
 * serverless restarts, and the triage is visible inside Gmail too.
 */

const LABEL_PREFIX = "Seer/";

const SEER_ACTIONS: TriageAction[] = [
  "respond",
  "read_and_archive",
  "read_and_delete",
  "delete_now",
  "act_today",
  "unsubscribe",
  "review_subscription",
  "glance_promo",
  "needs_review",
];

export type SeerLabelStore = {
  /** Action saved on this message via a Seer label, if any. */
  lookup: (item: { labelIds?: string[] }) => TriageAction | null;
  /** Save decisions as labels (one batchModify per distinct action). */
  persist: (
    decisions: { id: string; action: TriageAction }[],
  ) => Promise<void>;
};

const MAP_TTL_MS = 6 * 60 * 60 * 1000;

type LabelMap = Partial<Record<TriageAction, string>>;
type MapCacheFile = { builtAt: string; map: LabelMap };

function mapKey(accountEmail: string) {
  return `gmail-labels:${accountKey(accountEmail)}`;
}

async function gmail(
  accessToken: string,
  pathname: string,
  init?: RequestInit,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Gmail labels ${pathname}: ${res.status}`);
  }
  if (res.status === 204) return null;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fetchLabelMap(accessToken: string): Promise<LabelMap> {
  const json = await gmail(accessToken, "/users/me/labels");
  const labels = (json?.labels ?? []) as { id: string; name: string }[];
  const map: LabelMap = {};
  for (const l of labels) {
    if (!l.name.startsWith(LABEL_PREFIX)) continue;
    const action = l.name.slice(LABEL_PREFIX.length) as TriageAction;
    if (SEER_ACTIONS.includes(action)) map[action] = l.id;
  }
  return map;
}

async function loadLabelMap(
  accessToken: string,
  accountEmail: string,
): Promise<LabelMap> {
  const parsed = await kvGet<MapCacheFile>(mapKey(accountEmail));
  if (
    parsed &&
    Date.now() - new Date(parsed.builtAt).getTime() < MAP_TTL_MS
  ) {
    return parsed.map;
  }
  const map = await fetchLabelMap(accessToken);
  await saveLabelMap(accountEmail, map).catch(() => {});
  return map;
}

async function saveLabelMap(accountEmail: string, map: LabelMap) {
  const payload: MapCacheFile = { builtAt: new Date().toISOString(), map };
  await kvSet(mapKey(accountEmail), payload);
}

async function ensureLabel(
  accessToken: string,
  accountEmail: string,
  map: LabelMap,
  action: TriageAction,
): Promise<string> {
  const existing = map[action];
  if (existing) return existing;
  const created = (await gmail(accessToken, "/users/me/labels", {
    method: "POST",
    body: JSON.stringify({
      name: `${LABEL_PREFIX}${action}`,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  })) as { id: string } | null;
  if (!created?.id) throw new Error("Label create failed");
  map[action] = created.id;
  await saveLabelMap(accountEmail, map).catch(() => {});
  return created.id;
}

/** Gmail-only. Returns null for other providers. */
export async function makeGmailLabelStore(
  accessToken: string,
  accountEmail: string,
): Promise<SeerLabelStore | null> {
  let map: LabelMap;
  try {
    map = await loadLabelMap(accessToken, accountEmail);
  } catch {
    return null; // label reads unavailable — triage still works
  }

  const idToAction = new Map<string, TriageAction>();
  for (const [action, id] of Object.entries(map)) {
    if (id) idToAction.set(id, action as TriageAction);
  }

  return {
    lookup: (item) => {
      for (const id of item.labelIds ?? []) {
        const action = idToAction.get(id);
        if (action) return action;
      }
      return null;
    },

    persist: async (decisions) => {
      if (decisions.length === 0) return;
      const byAction = new Map<TriageAction, string[]>();
      for (const d of decisions) {
        const list = byAction.get(d.action) ?? [];
        list.push(d.id);
        byAction.set(d.action, list);
      }
      for (const [action, ids] of byAction) {
        try {
          const labelId = await ensureLabel(
            accessToken,
            accountEmail,
            map,
            action,
          );
          const removeLabelIds = Object.values(map).filter(
            (id): id is string => Boolean(id) && id !== labelId,
          );
          await gmail(accessToken, "/users/me/messages/batchModify", {
            method: "POST",
            body: JSON.stringify({
              ids: ids.slice(0, 1000),
              addLabelIds: [labelId],
              ...(removeLabelIds.length > 0 ? { removeLabelIds } : {}),
            }),
          });
        } catch (e) {
          console.error(
            "[seer] Failed to save decision labels:",
            e instanceof Error ? e.message : e,
          );
        }
      }
    },
  };
}
