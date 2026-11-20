import {
  clearBlueBubbles,
  loadBlueBubbles,
  loadTextingStats,
  saveBlueBubbles,
  syncTexting,
  testBlueBubbles,
} from "@/lib/imessage/bluebubbles";
import { loadPeople, savePeople, type PeopleDb } from "@/lib/store/people";
import { requireMailSession } from "@/lib/mail/session";
import { NextResponse } from "next/server";

export const maxDuration = 60;

const IMESSAGE_REASON = "You text them (iMessage";

/** Drop rows an earlier iMessage sync wrote that `keep` no longer backs. */
function dropStaleImessage(people: PeopleDb, keep: Set<string>): number {
  let dropped = 0;
  for (const [email, row] of Object.entries(people)) {
    if (row.by !== "evidence") continue;
    if (!row.reason?.startsWith(IMESSAGE_REASON)) continue;
    if (keep.has(email)) continue;
    delete people[email];
    dropped += 1;
  }
  return dropped;
}

/**
 * BlueBubbles wiring: save the server, test it, sync texting evidence,
 * and promote texted people to the Person Graph's inner circle —
 * "you text them 400 times a month" is the definition of inner.
 */

export async function GET() {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const [cfg, stats] = await Promise.all([
    loadBlueBubbles(session.email),
    loadTextingStats(session.email),
  ]);
  return NextResponse.json({
    configured: Boolean(cfg),
    url: cfg?.url ?? null,
    stats: stats
      ? {
          syncedAt: stats.syncedAt,
          contactCount: stats.contactCount,
          chatCount: stats.chatCount,
          emailsMatched: Object.keys(stats.people).length,
        }
      : null,
  });
}

export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    const body = (await request.json()) as {
      action?: "save" | "sync" | "clear";
      url?: string;
      password?: string;
    };

    if (body.action === "clear") {
      await clearBlueBubbles(session.email);
      const people = await loadPeople(session.email);
      if (dropStaleImessage(people, new Set()) > 0) {
        await savePeople(session.email, people);
      }
      return NextResponse.json({ ok: true, configured: false });
    }

    if (body.action === "save") {
      if (!body.url?.trim() || !body.password?.trim()) {
        return NextResponse.json(
          { error: "Provide the server URL and password" },
          { status: 400 },
        );
      }
      const probe = await testBlueBubbles({
        url: body.url.trim(),
        password: body.password.trim(),
      });
      if (!probe.ok) {
        return NextResponse.json(
          { error: `Could not reach BlueBubbles: ${probe.detail}` },
          { status: 502 },
        );
      }
      await saveBlueBubbles(session.email, {
        url: body.url.trim(),
        password: body.password.trim(),
        computerId: probe.computerId,
      });
      return NextResponse.json({ ok: true, configured: true, detail: probe.detail });
    }

    // sync: pull texting evidence and promote to the Person Graph
    const handSet = new Set(
      Object.entries(await loadPeople(session.email))
        .filter(([, row]) => row.by === "user")
        .map(([email]) => email),
    );
    const stats = await syncTexting(session.email, {
      skip: (email) => handSet.has(email),
    });
    const people = await loadPeople(session.email);
    dropStaleImessage(people, new Set(Object.keys(stats.people)));
    let promoted = 0;
    for (const [email, ev] of Object.entries(stats.people)) {
      const existing = people[email];
      // The user's own explicit calls are never overwritten
      if (existing?.by === "user") continue;
      if (existing?.tier === "inner" && existing.vip) continue;
      people[email] = {
        email,
        name: ev.name ?? existing?.name,
        tier: "inner",
        vip: existing?.vip,
        reason: `${IMESSAGE_REASON}${ev.name ? ` · ${ev.name}` : ""})`,
        by: "evidence",
        judgedAt: new Date().toISOString(),
      };
      promoted += 1;
    }
    await savePeople(session.email, people);

    return NextResponse.json({
      ok: true,
      contacts: stats.contactCount,
      chats: stats.chatCount,
      emailsMatched: Object.keys(stats.people).length,
      promotedToInner: promoted,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "iMessage sync failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
