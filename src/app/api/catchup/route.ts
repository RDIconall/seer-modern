import { classifyMessage } from "@/lib/inbox/classify";
import { classifyInboxWithAssistant } from "@/lib/inbox/gemini-triage";
import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import { stripEmoji } from "@/lib/inbox/types";
import { getInboxSnapshot } from "@/lib/mail/inbox-snapshot";
import {
  getGmailThreadLast,
  listGmailFolder,
  searchGmail,
} from "@/lib/mail/gmail";
import { listGraphFolder } from "@/lib/mail/graph";
import { makeGmailLabelStore } from "@/lib/mail/seer-labels";
import { requireMailSession } from "@/lib/mail/session";
import { originAllowed } from "@/lib/security/origin";
import { markOpened, readLastOpen } from "@/lib/store/last-open";
import { getSenderOverride } from "@/lib/store/senders";
import { NextResponse } from "next/server";

/** Deep enough to cover a real 500+ inbox in one pass */
const INBOX_DEPTH = 1200;

export const maxDuration = 30;

const NEEDS = new Set(["respond", "act_today", "needs_review", "review_subscription"]);
const MIN_NEW = 3;

/**
 * The open is recorded only from a same-origin POST. A cross-site top-level
 * navigation carries the SameSite=Lax session cookie, so GET must stay
 * read-only or any link could consume the away window.
 */
function sameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  // `next dev` reports request.url as localhost whatever host it serves on;
  // the browser-set Host header names the origin the page was loaded from.
  const served = new URL(request.url);
  const host = request.headers.get("host");
  if (host) served.host = host;
  return originAllowed({
    origin: request.headers.get("origin"),
    requestOrigin: served.origin,
    allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
    production: process.env.NODE_ENV === "production",
  });
}

/** The brief's `openedAt`, if sent; never later than now. */
function openedAtFrom(body: unknown): Date {
  const now = new Date();
  const at =
    body && typeof body === "object" && "at" in body
      ? (body as { at: unknown }).at
      : undefined;
  if (typeof at !== "string") return now;
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime()) || parsed > now) return now;
  return parsed;
}

/**
 * The catch-up screen calls this once the person has actually used the app
 * after seeing the brief, passing the brief's `openedAt` so mail that lands
 * in between is still counted next time.
 */
export async function POST(request: Request) {
  if (!sameOriginRequest(request)) {
    return NextResponse.json({ error: "invalid request origin" }, { status: 403 });
  }
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    const body: unknown = await request.json().catch(() => null);
    await markOpened(session.email, openedAtFrom(body));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Catch-up failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

/**
 * The catch-up brief: everything that arrived since the user last
 * opened the app, already graded, distilled to one glance. Built from
 * the AI's own task lines — no extra model call, so it's instant.
 * Read-only: the open is recorded by POST.
 */
export async function GET() {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const openedAt = new Date().toISOString();
    const since = await readLastOpen(session.email);
    // First open ever: nothing to summarize until the client records the open
    if (!since) {
      return NextResponse.json({ quiet: true, openedAt });
    }

    const raw = await getInboxSnapshot(session.email, () =>
      session.provider === "google"
        ? listGmailFolder(session.accessToken, "inbox", INBOX_DEPTH)
        : listGraphFolder(session.accessToken, "inbox", INBOX_DEPTH),
    );
    const fresh = raw.filter((m) => m.receivedAt > since);
    if (fresh.length < MIN_NEW) {
      return NextResponse.json({ quiet: true, newCount: fresh.length, openedAt });
    }

    const [history, labels] = await Promise.all([
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
    ]);

    // Cache/labels serve instantly for anything the background pipeline
    // already graded; the remainder returns provisional (still useful).
    const decisions = await classifyInboxWithAssistant(
      session.email,
      fresh.map((m) => ({
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

    let needsYou = 0;
    let fyi = 0;
    let cleared = 0;
    const headlines: { id: string; who: string; line: string }[] = [];
    for (const m of fresh) {
      const r = decisions.get(m.id);
      if (!r) continue;
      if (NEEDS.has(r.action)) {
        needsYou += 1;
        if (headlines.length < 4) {
          headlines.push({
            id: m.id,
            who: stripEmoji(m.fromName || m.fromEmail),
            line: stripEmoji(r.task ?? r.reason ?? m.subject).slice(0, 70),
          });
        }
      } else if (r.action === "read_and_delete") fyi += 1;
      else cleared += 1;
    }

    return NextResponse.json({
      quiet: false,
      since,
      openedAt,
      newCount: fresh.length,
      needsYou,
      fyi,
      cleared,
      headlines,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Catch-up failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
