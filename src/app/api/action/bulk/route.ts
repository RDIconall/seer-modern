import { createLimiter, MAX_ACTION_ROWS } from "@/lib/mail/bounds";
import { gmailAction, gmailThreadAction } from "@/lib/mail/gmail";
import { graphAction, graphThreadAction } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { recordAccepted } from "@/lib/store/autonomy";
import { appendLedger } from "@/lib/store/triage-ledger";
import { NextResponse } from "next/server";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const body = (await request.json()) as {
      items?: {
        id: string;
        threadId?: string;
        action: "archive" | "trash" | "read";
        fromEmail?: string;
      }[];
      /** When a sweep slate confirms a whole reason, name it so the
       *  Cleaned ledger records it and the reason earns autonomy trust. */
      reason?: string;
      source?: "auto" | "confirmed";
    };
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      return NextResponse.json({ error: "No items" }, { status: 400 });
    }
    // Never silently drop items (the old 15-item cap dropped the rest of a
    // "Delete all 40" — Seer showed clean, Gmail didn't): refuse an
    // oversized request so the client sends it in parts.
    if (items.length > MAX_ACTION_ROWS) {
      return NextResponse.json(
        { error: `At most ${MAX_ACTION_ROWS} items per request` },
        { status: 413 },
      );
    }

    // One limiter for every provider call, including each message of an
    // Outlook conversation; one bad id must not sink the rest.
    const limit = createLimiter();
    const token = session.accessToken;
    const run = (item: {
      id: string;
      threadId?: string;
      action: "archive" | "trash" | "read";
    }) => {
      const { threadId } = item;
      // Thread-wide when the caller knows the thread, message-only otherwise
      if (threadId) {
        return session.provider === "google"
          ? limit(() => gmailThreadAction(token, threadId, item.action))
          : graphThreadAction(token, threadId, item.action, limit);
      }
      return limit(() =>
        session.provider === "google"
          ? gmailAction(token, item.id, item.action)
          : graphAction(token, item.id, item.action),
      );
    };

    let processed = 0;
    let failed = 0;
    for (const r of await Promise.allSettled(items.map(run))) {
      if (r.status === "fulfilled") processed += 1;
      else failed += 1;
    }

    // NO implicit SENDER teaching from bulk sweeps: accepting Seer's own
    // "delete all 30" suggestion is not the user judging each sender —
    // recording it let Seer teach itself its own opinion (three AA
    // receipts swept in one tap became "always delete American
    // Airlines"). Only individual, deliberate actions teach senders.
    //
    // But a confirmed sweep DOES teach at the REASON level, and it lands
    // in the Cleaned ledger so it can be undone. This is how a reason
    // earns its way up the autonomy ladder without ever training on a
    // per-sender opinion.
    let ledgerId: string | undefined;
    if (body.reason && processed > 0) {
      const source = body.source === "auto" ? "auto" : "confirmed";
      const entry = await appendLedger(session.email, {
        kind: "sweep",
        summary: `Swept ${processed} — ${body.reason}`,
        reason: body.reason,
        source,
        emailIds: items.map((i) => i.id),
        threadIds: items
          .map((i) => i.threadId)
          .filter((t): t is string => Boolean(t)),
      }).catch(() => null);
      ledgerId = entry?.id;
      if (source === "confirmed") {
        await recordAccepted(session.email, body.reason).catch(() => {});
      }
    }

    return NextResponse.json({ ok: true, processed, failed, ledgerId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Bulk action failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
