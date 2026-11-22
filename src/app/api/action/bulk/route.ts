import { gmailAction, gmailThreadAction } from "@/lib/mail/gmail";
import { graphAction, graphThreadAction } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import {
  MAX_MAILBOX_WRITES,
  MailWriteBudget,
  MailWriteDeferred,
} from "@/lib/mail/write-budget";
import { recordAccepted } from "@/lib/store/autonomy";
import { appendLedger } from "@/lib/store/triage-ledger";
import { NextResponse } from "next/server";

export const maxDuration = 60;

/** Parallelism per wave — Gmail per-user quota tolerates ~10-15 writes/s. */
const CONCURRENCY = 15;

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
    if (items.length > MAX_MAILBOX_WRITES) {
      return NextResponse.json(
        { error: `At most ${MAX_MAILBOX_WRITES} items per request` },
        { status: 400 },
      );
    }

    // Every provider write in this request draws from one allowance, so
    // Outlook conversations cannot multiply the row cap.
    const budget = new MailWriteBudget();

    // Thread-wide when the caller knows the thread, message-only otherwise
    const run = (
      token: string,
      item: { id: string; threadId?: string; action: "archive" | "trash" | "read" },
    ) =>
      item.threadId
        ? session.provider === "google"
          ? gmailThreadAction(token, item.threadId, item.action, budget)
          : graphThreadAction(token, item.threadId, item.action, budget)
        : session.provider === "google"
          ? gmailAction(token, item.id, item.action, budget)
          : graphAction(token, item.id, item.action, budget);

    // EVERY item is either processed or handed back as `deferred` (never
    // touched, safe to resend) — the old silent cap dropped the rest of a
    // "Delete all 40" and Seer showed clean while Gmail didn't. Waves of
    // parallel calls; one bad id must not sink the rest.
    let processed = 0;
    let failed = 0;
    const deferred: string[] = [];
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const wave = items.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        wave.map((item) => run(session.accessToken, item)),
      );
      results.forEach((r, index) => {
        if (r.status === "fulfilled") processed += 1;
        else if (r.reason instanceof MailWriteDeferred) deferred.push(wave[index].id);
        else failed += 1;
      });
    }
    const deferredIds = new Set(deferred);
    const attempted = items.filter((i) => !deferredIds.has(i.id));

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
        emailIds: attempted.map((i) => i.id),
        threadIds: attempted
          .map((i) => i.threadId)
          .filter((t): t is string => Boolean(t)),
      }).catch(() => null);
      ledgerId = entry?.id;
      if (source === "confirmed") {
        await recordAccepted(session.email, body.reason).catch(() => {});
      }
    }

    return NextResponse.json({ ok: true, processed, failed, deferred, ledgerId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Bulk action failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
