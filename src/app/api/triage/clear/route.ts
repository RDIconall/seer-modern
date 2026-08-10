import { gmailAction, gmailThreadAction } from "@/lib/mail/gmail";
import { graphAction, graphThreadAction } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { loadBrief, saveBrief } from "@/lib/inbox/matters";
import {
  applyTriageClear,
  planTriageClear,
  type TriageClearRequest,
} from "@/lib/inbox/triage-clear";
import { appendLedger } from "@/lib/store/triage-ledger";
import { recordAccepted } from "@/lib/store/autonomy";
import { NextResponse } from "next/server";

export const maxDuration = 60;

/**
 * One authoritative Triage clear transaction:
 * 1. Protect active matter threads (message-only there; thread-wide elsewhere).
 * 2. Execute provider actions.
 * 3. Persist only successful removals into the Brief.
 * 4. Recompute the same accounting object Atlas and Triage both render.
 */
export async function POST(request: Request) {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    rows?: TriageClearRequest[];
    reason?: string;
    /** "trash" is Triage's delete; "archive" closes something out. */
    mode?: "archive" | "trash";
  };
  if (!body.rows?.length) {
    return NextResponse.json({ error: "No rows" }, { status: 400 });
  }
  const brief = await loadBrief(session.email);
  if (!brief) {
    return NextResponse.json({ error: "Brief not ready" }, { status: 409 });
  }

  const actions = planTriageClear(brief, body.rows);
  const mode = body.mode === "trash" ? "trash" : "archive";
  const run = async (action: (typeof actions)[number]) => {
    if (action.threadId) {
      return session.provider === "google"
        ? gmailThreadAction(session.accessToken, action.threadId, mode)
        : graphThreadAction(session.accessToken, action.threadId, mode);
    }
    return session.provider === "google"
      ? gmailAction(session.accessToken, action.id, mode)
      : graphAction(session.accessToken, action.id, mode);
  };

  const results = await Promise.allSettled(actions.map(run));
  const succeeded = actions.filter((_, index) => results[index].status === "fulfilled");
  const failed = actions.length - succeeded.length;
  if (succeeded.length === 0) {
    return NextResponse.json(
      { error: "Nothing could be cleared", processed: 0, failed },
      { status: 502 },
    );
  }

  const updated = applyTriageClear(brief, succeeded);
  const removedCount = Math.max(
    0,
    (brief.providerTotal?.messages ?? brief.totalInbox ?? 0) -
      (updated.providerTotal?.messages ?? updated.totalInbox ?? 0),
  );
  await saveBrief(session.email, updated);

  const reason = body.reason?.slice(0, 100) || "Triage";
  await Promise.allSettled([
    appendLedger(session.email, {
      kind: "sweep",
      summary: `${mode === "trash" ? "Deleted" : "Closed"} ${removedCount} — ${reason}`,
      reason,
      source: "confirmed",
      emailIds: succeeded.map((action) => action.id),
      threadIds: succeeded
        .map((action) => action.threadId)
        .filter((id): id is string => Boolean(id)),
    }),
    recordAccepted(session.email, reason),
  ]);

  return NextResponse.json({
    ok: failed === 0,
    processed: succeeded.length,
    removedCount,
    failed,
    cleared: succeeded,
    brief: updated,
  });
}
