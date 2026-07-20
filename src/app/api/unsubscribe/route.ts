import { gmailAction } from "@/lib/mail/gmail";
import { graphAction } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import {
  unsubscribeGmail,
  unsubscribeGraph,
  type UnsubscribeResult,
} from "@/lib/mail/unsubscribe";
import { setSenderOverride } from "@/lib/store/senders";
import { NextResponse } from "next/server";

export const maxDuration = 60;

const BULK_CAP = 30;

type Item = { id: string; fromEmail?: string };

/**
 * Unsubscribe for real: one-click POST / mailto send / link handoff,
 * then trash the message and teach the sender as delete-on-sight so
 * stragglers (lists ignore requests for days) never resurface.
 */
export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const body = (await request.json()) as {
      id?: string;
      fromEmail?: string;
      items?: Item[];
    };
    const items: Item[] = body.items?.length
      ? body.items.slice(0, BULK_CAP)
      : body.id
        ? [{ id: body.id, fromEmail: body.fromEmail }]
        : [];
    if (items.length === 0) {
      return NextResponse.json(
        { error: "Provide { id } or { items }" },
        { status: 400 },
      );
    }

    const doUnsub =
      session.provider === "google" ? unsubscribeGmail : unsubscribeGraph;
    const doTrash = session.provider === "google" ? gmailAction : graphAction;

    let oneClick = 0;
    let mailto = 0;
    let trashedOnly = 0;
    const links: { id: string; url: string }[] = [];

    for (const item of items) {
      let result: UnsubscribeResult = { method: "none" };
      try {
        result = await doUnsub(session.accessToken, item.id);
      } catch {
        /* still trash + teach below */
      }
      if (result.method === "one-click") oneClick += 1;
      else if (result.method === "mailto") mailto += 1;
      else if (result.method === "link") links.push({ id: item.id, url: result.url });
      else trashedOnly += 1;

      await doTrash(session.accessToken, item.id, "trash").catch(() => {});
      if (item.fromEmail?.includes("@")) {
        await setSenderOverride(item.fromEmail, "delete_now").catch(() => {});
      }
    }

    return NextResponse.json({
      ok: true,
      unsubscribed: oneClick + mailto,
      oneClick,
      mailto,
      trashedOnly,
      links,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unsubscribe failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
