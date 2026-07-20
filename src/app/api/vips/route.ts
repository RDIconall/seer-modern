import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import { getPersonalContext } from "@/lib/inbox/personal-context";
import { listGmailFolder } from "@/lib/mail/gmail";
import { listGraphFolder } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { clearDecisions } from "@/lib/store/decision-cache";
import {
  loadPeople,
  MACHINE_LOCALPART,
  savePeople,
} from "@/lib/store/people";
import { loadUserProfile } from "@/lib/store/user-profile";
import { NextResponse } from "next/server";

export const maxDuration = 30;

/**
 * VIPs — the Seer thesis made visible: history predicts importance.
 * Suggestions are SCORED from the user's own behavior (who they write
 * to, meet with, keep in contacts, get named in their profile); the
 * user just confirms or adjusts. Pins live in the Person Graph.
 */

export async function GET() {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const [people, history, personal, profile] = await Promise.all([
      loadPeople(session.email),
      getOrBuildMailHistory(session.email, session.accessToken, {
        listFolder: (token, folder, max) =>
          session.provider === "google"
            ? listGmailFolder(token, folder, max)
            : listGraphFolder(token, folder, max),
      }),
      getPersonalContext({
        accountEmail: session.email,
        accessToken: session.accessToken,
        provider: session.provider,
      }),
      loadUserProfile(session.email),
    ]);

    const vips = Object.values(people)
      .filter((p) => p.vip)
      .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));

    // Score candidates from pure history: writes, meetings, contacts,
    // profile mentions. Machines and existing VIPs excluded.
    const meetingCounts = new Map<string, number>();
    for (const e of personal.events) {
      for (const a of e.attendees) {
        meetingCounts.set(a, (meetingCounts.get(a) ?? 0) + 1);
      }
    }
    const contactSet = new Set(personal.contacts);
    const profileText = (profile?.text ?? "").toLowerCase();

    const suggestions = Object.values(history.contacts)
      .filter((c) => {
        const local = c.email.split("@")[0] ?? "";
        if (MACHINE_LOCALPART.test(local)) return false;
        if (people[c.email]?.vip) return false;
        return c.sentTo > 0 || meetingCounts.has(c.email);
      })
      .map((c) => {
        const meetings = meetingCounts.get(c.email) ?? 0;
        const namePart = c.email.split("@")[0]?.split(/[._-]/)[0] ?? "";
        const inProfile =
          namePart.length >= 3 && profileText.includes(namePart.toLowerCase());
        const recentSent =
          c.lastSentAt &&
          Date.now() - new Date(c.lastSentAt).getTime() <
            45 * 24 * 60 * 60 * 1000;
        const score =
          c.sentTo * 3 +
          meetings * 5 +
          (contactSet.has(c.email) ? 4 : 0) +
          (inProfile ? 10 : 0) +
          (recentSent ? 5 : 0);
        const evidence = [
          c.sentTo > 0 ? `you wrote ${c.sentTo}×` : null,
          meetings > 0 ? `${meetings} meeting${meetings > 1 ? "s" : ""}` : null,
          contactSet.has(c.email) ? "in contacts" : null,
          inProfile ? "named in your profile" : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return { email: c.email, score, evidence, sentTo: c.sentTo };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    return NextResponse.json({ vips, suggestions });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "VIP load failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    const body = (await request.json()) as {
      email?: string;
      name?: string;
      vip?: boolean;
    };
    const email = body.email?.trim().toLowerCase();
    if (!email?.includes("@") || typeof body.vip !== "boolean") {
      return NextResponse.json(
        { error: "Provide { email, vip: true|false }" },
        { status: 400 },
      );
    }

    const people = await loadPeople(session.email);
    people[email] = {
      email,
      name: body.name?.trim() || people[email]?.name,
      tier: "inner",
      vip: body.vip,
      reason: body.vip ? "You pinned them as a VIP" : people[email]?.reason,
      by: "user",
      judgedAt: new Date().toISOString(),
    };
    await savePeople(session.email, people);
    // VIP status changes decisions — this sender's mail gets a fresh look
    await clearDecisions(session.email).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "VIP save failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
