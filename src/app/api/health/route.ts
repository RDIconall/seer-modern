import { requireMailSession } from "@/lib/mail/session";
import { getAssistantStatus } from "@/lib/inbox/gemini-triage";
import { NextResponse } from "next/server";

/**
 * Integration health — every external dependency probed live, so
 * "silently returns empty" can never masquerade as "working". This is
 * how the disabled-Calendar-API class of failure becomes visible.
 */

type Check = { name: string; ok: boolean; detail: string };

function classify(status: number, body: string): string {
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used in project/i.test(body)) {
    return "API disabled in the app's Google Cloud project — enable it in the Cloud console";
  }
  if (status === 401 || status === 403) {
    return "permission missing — Reconnect this account and approve all access";
  }
  return `http ${status}`;
}

async function probe(
  name: string,
  url: string,
  token: string,
  countOf?: (json: Record<string, unknown>) => number,
): Promise<Check> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      return { name, ok: false, detail: classify(res.status, await res.text()) };
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const n = countOf ? countOf(json) : undefined;
    return { name, ok: true, detail: n != null ? `ok · ${n} found` : "ok" };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? e.message : "failed" };
  }
}

export async function GET() {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const t = session.accessToken;

  if (session.provider !== "google") {
    return NextResponse.json({ provider: session.provider, checks: [] });
  }

  const [gmail, calendar, contacts, otherContacts, docs, tokeninfo] =
    await Promise.all([
      probe(
        "Gmail",
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        t,
        (j) => (j.labels as unknown[])?.length ?? 0,
      ),
      probe(
        "Calendar",
        "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1",
        t,
      ),
      probe(
        "Contacts (saved)",
        "https://people.googleapis.com/v1/people/me/connections?personFields=emailAddresses&pageSize=500",
        t,
        (j) => (j.connections as unknown[])?.length ?? 0,
      ),
      probe(
        "Contacts (auto-collected)",
        "https://people.googleapis.com/v1/otherContacts?readMask=emailAddresses&pageSize=500",
        t,
        (j) => (j.otherContacts as unknown[])?.length ?? 0,
      ),
      probe(
        "Google Docs (profile import)",
        // Bogus id: NOT_FOUND means the API itself is alive
        "https://docs.googleapis.com/v1/documents/seer-health-probe",
        t,
      ).then((c) =>
        c.detail === "http 404"
          ? { ...c, ok: true, detail: "ok" }
          : c,
      ),
      fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(t)}`,
        { cache: "no-store" },
      )
        .then(async (r) => (await r.json()) as { scope?: string })
        .catch(() => ({ scope: "" })),
    ]);

  const scopes = (tokeninfo.scope ?? "")
    .split(" ")
    .map((s) => s.replace("https://www.googleapis.com/auth/", ""))
    .filter((s) => s && !/^https?:/.test(s));

  const assistant = getAssistantStatus();

  return NextResponse.json({
    provider: "google",
    email: session.email,
    checks: [gmail, calendar, contacts, otherContacts, docs],
    grantedScopes: scopes,
    engine: { model: assistant.model, error: assistant.error },
  });
}
