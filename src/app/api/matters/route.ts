import { loadBrief, saveBrief, type Matter } from "@/lib/inbox/matters";
import { requireMailSession } from "@/lib/mail/session";
import {
  addToMatter,
  createMatter,
  deleteMatter,
  loadMatterEdits,
  renameMatter,
} from "@/lib/store/manual-matters";
import { NextResponse } from "next/server";

/**
 * The user's own matters: rename anything, create their own, add emails to
 * it. Applied to the stored brief immediately so Atlas reflects the change
 * without waiting for a rebuild, and persisted so rebuilds respect it.
 */
export async function GET() {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  return NextResponse.json({ edits: await loadMatterEdits(session.email) });
}

export async function POST(req: Request) {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    action?: "create" | "rename" | "add" | "delete";
    matterId?: string;
    title?: string;
    orgUnit?: string;
    goal?: string;
    emailIds?: string[];
  };

  const brief = await loadBrief(session.email);

  if (body.action === "rename") {
    if (!body.matterId || !body.title?.trim()) {
      return NextResponse.json(
        { error: "matterId and title required" },
        { status: 400 },
      );
    }
    await renameMatter(session.email, body.matterId, body.title.trim());
    if (brief) {
      const m = brief.matters.find((x) => x.id === body.matterId);
      const p = brief.pinned?.find((x) => x.id === body.matterId);
      if (m) m.title = body.title.trim();
      if (p) p.title = body.title.trim();
      await saveBrief(session.email, brief);
    }
    return NextResponse.json({ ok: true, brief });
  }

  if (body.action === "create") {
    if (!body.title?.trim()) {
      return NextResponse.json({ error: "title required" }, { status: 400 });
    }
    const { matter } = await createMatter(session.email, {
      title: body.title.trim(),
      emailIds: body.emailIds,
      orgUnit: body.orgUnit,
      goal: body.goal,
    });

    // Reflect it in the stored brief now: move the chosen emails out of
    // their filed rows and into the new matter.
    if (brief) {
      const chosen = new Set(matter.emailIds);
      const rows = (brief.filed ?? []).filter((f) => chosen.has(f.emailId));
      const fresh: Matter = {
        id: matter.id,
        title: matter.title,
        category: "mine",
        orgUnit:
          matter.orgUnit ??
          rows[0]?.orgUnit ??
          brief.functions?.[0] ??
          "unsorted",
        orgConfidence: 1,
        people: [],
        goal: matter.goal,
        narrative: `${rows.length || matter.emailIds.length} email${
          (rows.length || matter.emailIds.length) === 1 ? "" : "s"
        } you grouped yourself`,
        nextAction: body.goal ? `Work toward: ${body.goal}` : "none — yours to define",
        owner: "you",
        urgency: 2,
        emails: rows.map((f) => ({
          id: f.emailId,
          threadId: f.threadId,
          from: f.line.split(" — ")[0] ?? "",
          line: f.line,
          suggestion: f.suggestion ?? "",
        })),
        emailIds: matter.emailIds,
        threadIds: [...new Set(rows.map((f) => f.threadId))],
        updatedAt: matter.updatedAt,
      };
      brief.matters = [fresh, ...brief.matters];
      brief.filed = (brief.filed ?? []).filter((f) => !chosen.has(f.emailId));
      await saveBrief(session.email, brief);
    }
    return NextResponse.json({ ok: true, matterId: matter.id, brief });
  }

  if (body.action === "add") {
    if (!body.matterId || !body.emailIds?.length) {
      return NextResponse.json(
        { error: "matterId and emailIds required" },
        { status: 400 },
      );
    }
    await addToMatter(session.email, body.matterId, body.emailIds);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "delete") {
    if (!body.matterId) {
      return NextResponse.json({ error: "matterId required" }, { status: 400 });
    }
    await deleteMatter(session.email, body.matterId);
    if (brief) {
      brief.matters = brief.matters.filter((m) => m.id !== body.matterId);
      await saveBrief(session.email, brief);
    }
    return NextResponse.json({ ok: true, brief });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
