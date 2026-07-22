import { accountKey, kvGet, kvSet, kvDelete } from "@/lib/store/kv";

/**
 * BlueBubbles = the user's real texting life (iMessage), self-hosted on
 * their own Mac. Who they text is the strongest relationship signal
 * there is — 10k texts in six months beats any email heuristic. The
 * sync maps texted people → their email addresses → the Person Graph
 * as inner circle, so "best friend on iMessage" can never be graded
 * like a stranger again.
 */

export type BlueBubblesConfig = {
  url: string;
  password: string;
  savedAt: string;
};

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
  cfg: { url: string; password: string },
): Promise<void> {
  await kvSet(cfgKey(accountEmail), {
    url: cfg.url.replace(/\/+$/, ""),
    password: cfg.password,
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

export async function testBlueBubbles(cfg: {
  url: string;
  password: string;
}): Promise<{ ok: boolean; detail: string }> {
  try {
    const info = await bb(cfg, "/api/v1/server/info");
    const data = info.data as { os_version?: string; server_version?: string };
    return {
      ok: true,
      detail: `ok · server v${data?.server_version ?? "?"}`,
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
  lastMessage?: { dateCreated?: number };
};

/** Digits-only key so "+1 (818) 786-7580" matches "8187867580". */
function phoneKey(raw: string): string {
  const d = raw.replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
}

/**
 * Pull contacts + chats from the user's Mac and distill: which EMAIL
 * addresses belong to people the user actually texts?
 */
export async function syncTexting(
  accountEmail: string,
): Promise<TextingStats> {
  const cfg = await loadBlueBubbles(accountEmail);
  if (!cfg) throw new Error("BlueBubbles is not configured");

  const contactsRes = await bb(cfg, "/api/v1/contact");
  const contacts = (contactsRes.data ?? []) as BbContact[];

  // handle (phone/email) → contact
  const byHandle = new Map<string, BbContact>();
  for (const c of contacts) {
    for (const p of c.phoneNumbers ?? []) {
      if (p.address) byHandle.set(phoneKey(p.address), c);
    }
    for (const e of c.emails ?? []) {
      if (e.address) byHandle.set(e.address.toLowerCase().trim(), c);
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
    const rows = (page.data ?? []) as BbChat[];
    chats.push(...rows);
    if (rows.length < 250) break;
  }

  const people: TextingStats["people"] = {};
  for (const chat of chats) {
    const last = chat.lastMessage?.dateCreated
      ? new Date(chat.lastMessage.dateCreated).toISOString()
      : undefined;
    for (const part of chat.participants ?? []) {
      const addr = part.address ?? "";
      if (!addr) continue;
      const contact = addr.includes("@")
        ? (byHandle.get(addr.toLowerCase().trim()) ?? null)
        : (byHandle.get(phoneKey(addr)) ?? null);
      const name =
        contact?.displayName ||
        [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") ||
        undefined;
      // Every email we can attribute to this texted person
      const emails = new Set<string>();
      if (addr.includes("@")) emails.add(addr.toLowerCase().trim());
      for (const e of contact?.emails ?? []) {
        if (e.address) emails.add(e.address.toLowerCase().trim());
      }
      for (const email of emails) {
        if (email === accountEmail.toLowerCase()) continue;
        const cur = people[email] ?? { name, chats: 0 };
        cur.chats += 1;
        cur.name = cur.name ?? name;
        if (!cur.lastMessageAt || (last && last > cur.lastMessageAt)) {
          cur.lastMessageAt = last;
        }
        people[email] = cur;
      }
    }
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
