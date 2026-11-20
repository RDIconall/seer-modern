import { accountKey, kvGet, kvSet, kvDelete } from "@/lib/store/kv";

/**
 * BlueBubbles = the user's real texting life (iMessage), self-hosted on
 * their own Mac. Who they text is the strongest relationship signal
 * there is — 10k texts in six months beats any email heuristic. The
 * sync maps email handles the user texts → the Person Graph
 * as inner circle, so "best friend on iMessage" can never be graded
 * like a stranger again.
 */

export type BlueBubblesConfig = {
  url: string;
  password: string;
  /** server/info computer_id seen when the user saved and verified it */
  computerId?: string;
  savedAt: string;
};

/** Distinct sent-in chats a handle needs before it counts as texted. */
export const MIN_TEXTED_CHATS = 2;

export type TextingStats = {
  /** email (lowercase) → texting evidence */
  people: Record<
    string,
    { name?: string; chats: number; lastMessageAt?: string }
  >;
  syncedAt: string;
  contactCount: number;
  chatCount: number;
};

function cfgKey(accountEmail: string) {
  return `bluebubbles:${accountKey(accountEmail)}`;
}
function statsKey(accountEmail: string) {
  return `imessage:${accountKey(accountEmail)}`;
}

export async function loadBlueBubbles(
  accountEmail: string,
): Promise<BlueBubblesConfig | null> {
  return await kvGet<BlueBubblesConfig>(cfgKey(accountEmail));
}

export async function saveBlueBubbles(
  accountEmail: string,
  cfg: { url: string; password: string; computerId: string },
): Promise<void> {
  await kvSet(cfgKey(accountEmail), {
    url: cfg.url.replace(/\/+$/, ""),
    password: cfg.password,
    computerId: cfg.computerId,
    savedAt: new Date().toISOString(),
  });
}

export async function clearBlueBubbles(accountEmail: string): Promise<void> {
  await kvDelete(cfgKey(accountEmail));
  await kvDelete(statsKey(accountEmail));
}

export async function loadTextingStats(
  accountEmail: string,
): Promise<TextingStats | null> {
  return await kvGet<TextingStats>(statsKey(accountEmail));
}

async function bb(
  cfg: { url: string; password: string },
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(
    `${cfg.url}${path}${sep}password=${encodeURIComponent(cfg.password)}`,
    {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    },
  );
  // A redirect elsewhere means the body is not from the saved server.
  if (!res.url || new URL(res.url).origin !== new URL(cfg.url).origin) {
    await res.body?.cancel().catch(() => {});
    throw new Error(
      `BlueBubbles ${path.split("?")[0]}: answered from a different server than the one you saved`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg =
      ((json.error as { message?: string })?.message ??
        (json.message as string)) ||
      `http ${res.status}`;
    throw new Error(`BlueBubbles ${path.split("?")[0]}: ${msg}`);
  }
  return json;
}

async function serverComputerId(cfg: {
  url: string;
  password: string;
}): Promise<{ computerId: string; serverVersion?: string }> {
  const info = await bb(cfg, "/api/v1/server/info");
  const data = info.data as
    | { computer_id?: unknown; server_version?: string }
    | undefined;
  const computerId =
    typeof data?.computer_id === "string" ? data.computer_id.trim() : "";
  if (!computerId) {
    throw new Error("BlueBubbles /api/v1/server/info: no computer_id");
  }
  return { computerId, serverVersion: data?.server_version };
}

export async function testBlueBubbles(cfg: {
  url: string;
  password: string;
}): Promise<
  | { ok: true; detail: string; computerId: string }
  | { ok: false; detail: string }
> {
  try {
    const { computerId, serverVersion } = await serverComputerId(cfg);
    return {
      ok: true,
      detail: `ok · server v${serverVersion ?? "?"}`,
      computerId,
    };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : "unreachable",
    };
  }
}

type BbContact = {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  phoneNumbers?: { address?: string }[];
  emails?: { address?: string }[];
};

type BbChat = {
  guid?: string;
  participants?: { address?: string }[];
  lastMessage?: { dateCreated?: number; isFromMe?: boolean };
};

const EMAIL_HANDLE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const addr = raw.toLowerCase().trim();
  return EMAIL_HANDLE.test(addr) ? addr : null;
}

async function assertSameServer(cfg: BlueBubblesConfig): Promise<void> {
  if (!cfg.computerId) {
    throw new Error("Save the BlueBubbles server again to verify it before syncing");
  }
  const { computerId } = await serverComputerId(cfg);
  if (computerId !== cfg.computerId) {
    throw new Error(
      "BlueBubbles server changed since you saved it — save it again to trust the new Mac",
    );
  }
}

/**
 * Pull contacts + chats from the user's Mac and distill: which EMAIL
 * addresses does the user actually text? Only the email handle of a
 * one-to-one chat the user sent in counts, and only across
 * MIN_TEXTED_CHATS distinct chats. Other addresses on a contact card
 * are not evidence — the card only supplies a display name.
 */
export async function syncTexting(
  accountEmail: string,
  opts?: { skip?: (email: string) => boolean },
): Promise<TextingStats> {
  const cfg = await loadBlueBubbles(accountEmail);
  if (!cfg) throw new Error("BlueBubbles is not configured");

  await assertSameServer(cfg);

  const contactsRes = await bb(cfg, "/api/v1/contact");
  const contacts = (
    Array.isArray(contactsRes.data) ? contactsRes.data : []
  ) as BbContact[];

  const byHandle = new Map<string, BbContact>();
  for (const c of contacts) {
    for (const e of c.emails ?? []) {
      const addr = emailHandle(e.address);
      if (addr && !byHandle.has(addr)) byHandle.set(addr, c);
    }
  }

  // Chats, newest-first, with participants
  const chats: BbChat[] = [];
  for (let offset = 0; offset < 1000; offset += 250) {
    const page = await bb(cfg, "/api/v1/chat/query", {
      method: "POST",
      body: JSON.stringify({
        limit: 250,
        offset,
        with: ["participants", "lastMessage"],
        sort: "lastmessage",
      }),
    });
    const rows = (Array.isArray(page.data) ? page.data : []) as BbChat[];
    chats.push(...rows);
    if (rows.length < 250) break;
  }

  await assertSameServer(cfg);

  const self = accountEmail.toLowerCase().trim();
  const seen = new Map<
    string,
    { guids: Set<string>; name?: string; lastMessageAt?: string }
  >();
  for (const chat of chats) {
    const guid = typeof chat.guid === "string" ? chat.guid.trim() : "";
    if (!guid) continue;
    if (chat.lastMessage?.isFromMe !== true) continue;
    const parts = Array.isArray(chat.participants) ? chat.participants : [];
    if (parts.length !== 1) continue;
    const addr = emailHandle(parts[0]?.address);
    if (!addr || addr === self || opts?.skip?.(addr)) continue;

    const when = chat.lastMessage.dateCreated;
    const last =
      typeof when === "number" && Number.isFinite(when)
        ? new Date(when).toISOString()
        : undefined;
    const contact = byHandle.get(addr);
    const name =
      contact?.displayName ||
      [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") ||
      undefined;
    const cur = seen.get(addr) ?? { guids: new Set<string>() };
    cur.guids.add(guid);
    cur.name = cur.name ?? name;
    if (!cur.lastMessageAt || (last && last > cur.lastMessageAt)) {
      cur.lastMessageAt = last;
    }
    seen.set(addr, cur);
  }

  const people: TextingStats["people"] = {};
  for (const [email, ev] of seen) {
    if (ev.guids.size < MIN_TEXTED_CHATS) continue;
    people[email] = {
      name: ev.name,
      chats: ev.guids.size,
      lastMessageAt: ev.lastMessageAt,
    };
  }

  const stats: TextingStats = {
    people,
    syncedAt: new Date().toISOString(),
    contactCount: contacts.length,
    chatCount: chats.length,
  };
  await kvSet(statsKey(accountEmail), stats);
  return stats;
}
