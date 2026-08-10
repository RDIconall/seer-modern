import { loadBrief, saveBrief } from "@/lib/inbox/matters";
import { gmailAction, gmailThreadAction } from "@/lib/mail/gmail";
import { requireMailSession } from "@/lib/mail/session";
import { reopenMatter } from "@/lib/store/closed-matters";
import { recordReversal } from "@/lib/store/autonomy";
import { getLedgerEntry, markUndone } from "@/lib/store/triage-ledger";
import { NextResponse } from "next/server";

/**
 * Undo one Cleaned-ledger action: put the mail back, and — when it was a
 * matter closure — reopen the closure so the matter can return. An undo
 * is also the strongest reversal signal, so it demotes that reason's
 * autonomy.
 */
export async function POST(request: Request) {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { entryId } = (await request.json().catch(() => ({}))) as {
    entryId?: string;
  };
  if (!entryId) {
    return NextResponse.json({ error: "entryId required" }, { status: 400 });
  }

  const entry = await getLedgerEntry(session.email, entryId);
  if (!entry) {
    return NextResponse.json({ error: "Entry not found" }, { status: 404 });
  }
  if (entry.undone) {
    return NextResponse.json({ ok: true, alreadyUndone: true });
  }

  // Restoring mail from the trash/archive is Gmail-only for now; Graph
  // undo needs a folder-restore path we haven't built. Be honest rather
  // than silently no-op.
  if (session.provider !== "google") {
    return NextResponse.json(
      { error: "Undo isn't supported for this account type yet" },
      { status: 501 },
    );
  }

  const threadIds = entry.threadIds ?? [];
  const emailIds = entry.emailIds ?? [];
  if (threadIds.length) {
    await Promise.allSettled(
      threadIds.map((t) => gmailThreadAction(session.accessToken, t, "restore")),
    );
  } else if (emailIds.length) {
    await Promise.allSettled(
      emailIds.map((id) => gmailAction(session.accessToken, id, "restore")),
    );
  }

  // A closed matter reopens: drop its closure so a rebuild can surface it.
  if (entry.matterId) {
    await reopenMatter(session.email, entry.matterId).catch(() => {});
  }

  // Undo is a reversal — it demotes this reason's autonomy immediately.
  if (entry.reason) {
    await recordReversal(session.email, entry.reason).catch(() => {});
  }

  await markUndone(session.email, entryId);

  // Reflect the restore in the stored brief when we can (best-effort).
  const brief = await loadBrief(session.email).catch(() => null);
  if (brief) await saveBrief(session.email, brief).catch(() => {});

  return NextResponse.json({ ok: true, restored: threadIds.length || emailIds.length });
}
