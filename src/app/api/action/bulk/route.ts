import { gmailAction, gmailThreadAction } from "@/lib/mail/gmail";
import { graphAction, graphThreadAction } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
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
    };
    const items = body.items ?? [];
    if (items.length === 0) {
      return NextResponse.json({ error: "No items" }, { status: 400 });
    }

    // Thread-wide when the caller knows the thread, message-only otherwise
    const run = (
      token: string,
      item: { id: string; threadId?: string; action: "archive" | "trash" | "read" },
    ) =>
      item.threadId
        ? session.provider === "google"
          ? gmailThreadAction(token, item.threadId, item.action)
          : graphThreadAction(token, item.threadId, item.action)
        : session.provider === "google"
          ? gmailAction(token, item.id, item.action)
          : graphAction(token, item.id, item.action);

    // EVERY item gets processed (the old 15-item cap silently dropped
    // the rest of a "Delete all 40" — Seer showed clean, Gmail didn't).
    // Waves of parallel calls; one bad id must not sink the rest.
    let processed = 0;
    let failed = 0;
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const wave = items.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        wave.map((item) => run(session.accessToken, item)),
      );
      for (const r of results) {
        if (r.status === "fulfilled") processed += 1;
        else failed += 1;
      }
    }

    // NO implicit teaching from bulk sweeps: accepting Seer's own
    // "delete all 30" suggestion is not the user judging each sender —
    // recording it let Seer teach itself its own opinion (three AA
    // receipts swept in one tap became "always delete American
    // Airlines"). Only individual, deliberate actions teach.

    return NextResponse.json({ ok: true, processed, failed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Bulk action failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
