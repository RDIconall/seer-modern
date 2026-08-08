import { PROMPT_VERSION } from "@/lib/inbox/gemini-triage";
import { ACTION_META, type TriageAction } from "@/lib/inbox/classify";
import { makeGmailLabelStore } from "@/lib/mail/seer-labels";
import { requireMailSession } from "@/lib/mail/session";
import {
  loadDecisions,
  saveDecisions,
  type CachedDecision,
} from "@/lib/store/decision-cache";
import { NextResponse } from "next/server";

const ALLOWED = new Set<TriageAction>([
  "act_today",
  "respond",
  "read_and_archive",
  "read_and_delete",
  "delete_now",
]);

/**
 * Correct ONE email, not the sender. "This LA28 presale is actionable"
 * must not teach "tickets@la28.org is always urgent" — the exception is
 * the point. The correction is stored as a user-sourced decision (top
 * of the chain: urgency decay and every floor respect it) and saved as
 * the message's Gmail label.
 */
export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    const body = (await request.json()) as {
      id?: string;
      action?: TriageAction;
      task?: string;
    };
    const action = body.action ?? "act_today";
    if (!body.id || !ALLOWED.has(action)) {
      return NextResponse.json(
        { error: "Provide { id, action }" },
        { status: 400 },
      );
    }

    const task =
      body.task?.trim().slice(0, 80) ||
      (action === "act_today" ? "Act on this — you flagged it" : undefined);

    const decision: CachedDecision = {
      action,
      confidence: "HIGH",
      reason: "You corrected this email yourself",
      instruction: ACTION_META[action].label,
      task,
      source: "override",
      ruleId: "user-corrected-message",
      ts: Date.now(),
      v: PROMPT_VERSION,
    };
    // Merge into the cache without clobbering unrelated entries
    await loadDecisions(session.email, [], PROMPT_VERSION).catch(() => null);
    await saveDecisions(session.email, new Map([[body.id, decision]]));

    if (session.provider === "google") {
      const labels = await makeGmailLabelStore(
        session.accessToken,
        session.email,
      ).catch(() => null);
      await labels?.persist([{ id: body.id, action }]).catch(() => {});
    }

    return NextResponse.json({ ok: true, action, task: decision.task });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Correction failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
