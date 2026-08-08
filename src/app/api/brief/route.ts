import { buildActionGuideQuick } from "@/lib/inbox/action-guide";
import { classifyMessage } from "@/lib/inbox/classify";
import { classifyInboxWithAssistant } from "@/lib/inbox/gemini-triage";
import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import { buildBrief, loadBrief, saveBrief } from "@/lib/inbox/matters";
import { saveMatterFix } from "@/lib/store/matter-fixes";
import type { EmailItem } from "@/lib/inbox/types";
import { getInboxSnapshot } from "@/lib/mail/inbox-snapshot";
import {
  getGmailInboxTotals,
  getGmailThreadLast,
  listGmailFolder,
  searchGmail,
} from "@/lib/mail/gmail";
import { getGraphInboxTotals, listGraphFolder } from "@/lib/mail/graph";
import { makeGmailLabelStore } from "@/lib/mail/seer-labels";
import { requireMailSession } from "@/lib/mail/session";
import { loadUnderstanding } from "@/lib/store/understanding-store";
import { loadUserProfile } from "@/lib/store/user-profile";
import { getSenderOverride } from "@/lib/store/senders";
import { NextResponse, after } from "next/server";

/** Deep enough to cover a real 500+ inbox in one pass */
const INBOX_DEPTH = 1200;

export const maxDuration = 60;

/** PATCH: fix a matter's org placement — the user's call is ground truth. */
export async function PATCH(req: Request) {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const { matterId, orgUnit } = (await req.json().catch(() => ({}))) as {
    matterId?: string;
    orgUnit?: string;
  };
  if (!matterId || !orgUnit) {
    return NextResponse.json(
      { error: "matterId and orgUnit required" },
      { status: 400 },
    );
  }
  await saveMatterFix(session.email, matterId, orgUnit);
  // Reflect immediately in the stored brief — no rebuild needed
  const brief = await loadBrief(session.email);
  if (brief) {
    const m = brief.matters.find((x) => x.id === matterId);
    if (m) {
      m.orgUnit = orgUnit;
      m.orgConfidence = 1;
      await saveBrief(session.email, brief);
    }
  }
  return NextResponse.json({ ok: true, brief });
}

/** GET: the stored brief. POST: rebuild it (AI pass runs after response). */
export async function GET() {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const brief = await loadBrief(session.email);
  return NextResponse.json({ brief });
}

export async function POST() {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const raw = await getInboxSnapshot(session.email, () =>
      session.provider === "google"
        ? listGmailFolder(session.accessToken, "inbox", INBOX_DEPTH)
        : listGraphFolder(session.accessToken, "inbox", INBOX_DEPTH),
    );

    const [history, labels, profile] = await Promise.all([
      getOrBuildMailHistory(
        session.email,
        session.accessToken,
        {
          listFolder: (t, f, max) =>
            session.provider === "google"
              ? listGmailFolder(t, f, max)
              : listGraphFolder(t, f, max),
          listArchive:
            session.provider === "google"
              ? (t, max) =>
                  searchGmail(
                    t,
                    "-in:inbox -in:sent -in:trash -in:spam is:read",
                    max,
                  )
              : undefined,
        },
        raw,
      ),
      session.provider === "google"
        ? makeGmailLabelStore(session.accessToken, session.email)
        : Promise.resolve(null),
      loadUserProfile(session.email),
    ]);

    // Grades from cache/labels — instant; the matters call is the only
    // AI work and it runs after the response.
    const decisions = await classifyInboxWithAssistant(
      session.email,
      raw.map((m) => ({
        id: m.id,
        fromEmail: m.fromEmail,
        fromName: m.fromName,
        subject: m.subject,
        snippet: m.snippet,
        labelIds: m.labelIds,
        threadId: m.threadId,
        receivedAt: m.receivedAt,
      })),
      history,
      (email) => getSenderOverride(email),
      classifyMessage,
      {
        labels,
        geminiEnabled: false,
        threadLast:
          session.provider === "google"
            ? (tid) => getGmailThreadLast(session.accessToken, tid)
            : undefined,
      },
    );

    const items: EmailItem[] = raw.map((m) => {
      const r = decisions.get(m.id);
      return {
        ...m,
        fromName:
          m.fromEmail.toLowerCase() === session.email.toLowerCase()
            ? "You"
            : m.fromName,
        guide: r
          ? buildActionGuideQuick(r, m.subject, m.fromName, m.snippet)
          : undefined,
      };
    });

    const providerTotal =
      session.provider === "google"
        ? await getGmailInboxTotals(session.accessToken)
        : await getGraphInboxTotals(session.accessToken);

    const understanding = await loadUnderstanding(session.email);

    after(async () => {
      try {
        const brief = await buildBrief(
          session.email,
          items,
          profile,
          providerTotal,
          understanding,
        );
        console.log(
          `[seer] brief rebuilt: ${brief.matters.length} matters · ${brief.headlines.length} headlines`,
        );
      } catch (e) {
        console.error(
          "[seer] brief build failed:",
          e instanceof Error ? e.message : e,
        );
      }
    });

    return NextResponse.json({ ok: true, building: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Brief rebuild failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
