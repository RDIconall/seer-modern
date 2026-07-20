import { MACHINE_LOCALPART } from "@/lib/store/people";
import { listGmailFolder } from "@/lib/mail/gmail";
import { requireMailSession } from "@/lib/mail/session";
import { accountKey, kvGet, kvSet } from "@/lib/store/kv";
import { NextResponse } from "next/server";

export const maxDuration = 30;

/**
 * The EA's third state: WAITING ON — threads where the user sent the
 * last word to a real person and has heard nothing for N days. Old
 * Seer called this the follow-up queue; every EA playbook keeps one.
 */

const WAIT_DAYS = 3;
const MAX_THREADS = 20;
const CACHE_TTL_MS = 30 * 60 * 1000;

export type WaitingItem = {
  threadId: string;
  messageId: string;
  to: string;
  toName: string;
  subject: string;
  sentAt: string;
  daysWaiting: number;
};

type CacheFile = { builtAt: string; items: WaitingItem[] };

function cacheKey(email: string) {
  return `waiting:${accountKey(email)}`;
}

export async function GET(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    if (session.provider !== "google") {
      return NextResponse.json({ items: [] });
    }

    const fresh = new URL(request.url).searchParams.get("fresh") === "1";
    if (!fresh) {
      const cached = await kvGet<CacheFile>(cacheKey(session.email));
      if (
        cached &&
        Date.now() - new Date(cached.builtAt).getTime() < CACHE_TTL_MS
      ) {
        return NextResponse.json({ items: cached.items, cached: true });
      }
    }

    // Threads the user last wrote to a human-shaped recipient
    const sent = await listGmailFolder(session.accessToken, "sent", 60);
    const me = session.email.toLowerCase();
    const byThread = new Map<string, (typeof sent)[number]>();
    for (const m of sent) {
      const to = (m.peerEmail ?? "").toLowerCase();
      if (!to || to === me || !to.includes("@")) continue;
      if (MACHINE_LOCALPART.test(to.split("@")[0] ?? "")) continue;
      const prev = byThread.get(m.threadId);
      if (!prev || m.receivedAt > prev.receivedAt) byThread.set(m.threadId, m);
    }

    const now = Date.now();
    const candidates = [...byThread.values()]
      .filter((m) => {
        const age = (now - new Date(m.receivedAt).getTime()) / 86_400_000;
        return age >= WAIT_DAYS && age <= 30;
      })
      .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
      .slice(0, MAX_THREADS);

    // Confirm nobody replied after their last send (thread metadata)
    const items: WaitingItem[] = [];
    for (const m of candidates) {
      try {
        const res = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${m.threadId}?format=metadata&metadataHeaders=From`,
          {
            headers: { Authorization: `Bearer ${session.accessToken}` },
            cache: "no-store",
          },
        );
        if (!res.ok) continue;
        const thread = (await res.json()) as {
          messages?: {
            id: string;
            internalDate?: string;
            payload?: { headers?: { name: string; value: string }[] };
          }[];
        };
        const msgs = thread.messages ?? [];
        const last = msgs[msgs.length - 1];
        const lastFrom =
          last?.payload?.headers
            ?.find((h) => h.name === "From")
            ?.value?.toLowerCase() ?? "";
        // Still waiting only if the LAST message in the thread is his
        if (!lastFrom.includes(me)) continue;
        items.push({
          threadId: m.threadId,
          messageId: last.id,
          to: m.peerEmail ?? "",
          toName: m.fromName === session.name ? (m.peerEmail ?? "") : m.fromName,
          subject: m.subject,
          sentAt: m.receivedAt,
          daysWaiting: Math.floor(
            (now - new Date(m.receivedAt).getTime()) / 86_400_000,
          ),
        });
      } catch {
        /* skip thread */
      }
    }

    await kvSet(cacheKey(session.email), {
      builtAt: new Date().toISOString(),
      items,
    }).catch(() => {});

    return NextResponse.json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Waiting scan failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
