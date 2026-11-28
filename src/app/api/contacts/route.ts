import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import { getPersonalContext } from "@/lib/inbox/personal-context";
import { listGmailFolder } from "@/lib/mail/gmail";
import { listGraphFolder } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { loadPeople } from "@/lib/store/people";
import { NextResponse } from "next/server";

/**
 * CONTACT SUGGESTIONS for compose. Three sources, merged and ranked by
 * how much the user actually deals with someone:
 *   - the saved address book (explicit — they chose to keep them)
 *   - the person graph (real names, VIP flags and tiers the user set)
 *   - the mail graph (how often they write to them)
 *
 * Ranking matters more than recall here: the right address should be the
 * first suggestion, not the twentieth.
 */

type Suggestion = { name?: string; email: string; score: number };

export async function GET(request: Request) {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const q = (new URL(request.url).searchParams.get("q") ?? "")
    .toLowerCase()
    .trim();

  const isGoogle = session.provider === "google";
  const [personal, people, history] = await Promise.all([
    getPersonalContext({
      accountEmail: session.email,
      accessToken: session.accessToken,
      provider: session.provider,
    }).catch(() => null),
    loadPeople(session.email).catch(() => ({})),
    getOrBuildMailHistory(session.email, session.accessToken, {
      listFolder: (t, f, max) =>
        isGoogle ? listGmailFolder(t, f, max) : listGraphFolder(t, f, max),
    }).catch(() => null),
  ]);

  const me = session.email.toLowerCase();
  const byEmail = new Map<string, Suggestion>();
  const add = (email: string, name: string | undefined, score: number) => {
    const key = email.toLowerCase().trim();
    if (!key.includes("@") || key === me) return;
    const existing = byEmail.get(key);
    if (existing) {
      existing.score += score;
      if (!existing.name && name) existing.name = name;
      return;
    }
    byEmail.set(key, { email: key, name, score });
  };

  // Saved contacts are an explicit choice — weigh them heavily.
  for (const e of personal?.contacts ?? []) add(e, undefined, 40);
  // Auto-collected addresses are weak evidence on their own.
  for (const e of personal?.autoContacts ?? []) add(e, undefined, 2);

  // Only tiers the user set. Evidence and AI tiers can come from inbound mail
  // alone (repeat sends, a meeting invite, a credible-sounding body), which an
  // outside sender controls.
  for (const p of Object.values(people)) {
    if (!p.vip && p.by !== "user") continue;
    add(p.email, p.name, p.vip ? 60 : p.tier === "inner" ? 20 : 5);
  }

  // Revealed preference: who they actually write to. Inbound volume is not a
  // preference — any sender can raise it.
  for (const c of Object.values(history?.contacts ?? {})) {
    if (c.sentTo > 0) add(c.email, undefined, Math.min(30, c.sentTo * 6));
  }

  for (const p of Object.values(people)) {
    const existing = byEmail.get(p.email.toLowerCase().trim());
    if (existing && !existing.name && p.name) existing.name = p.name;
  }

  const matches = [...byEmail.values()]
    .filter((s) =>
      q
        ? s.email.includes(q) || (s.name ?? "").toLowerCase().includes(q)
        : true,
    )
    .sort((a, b) => b.score - a.score || a.email.localeCompare(b.email))
    .slice(0, 10)
    .map(({ name, email }) => ({ name, email }));

  return NextResponse.json({ contacts: matches });
}
