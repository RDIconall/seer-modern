import { gmailAction, gmailThreadAction } from "@/lib/mail/gmail";
import { graphAction, graphThreadAction } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import {
  unsubscribeGmail,
  unsubscribeGraph,
  type UnsubscribeResult,
} from "@/lib/mail/unsubscribe";
import {
  MAX_MAILBOX_WRITES,
  MailWriteBudget,
  MailWriteDeferred,
} from "@/lib/mail/write-budget";
import { setSenderOverride } from "@/lib/store/senders";
import { NextResponse } from "next/server";

export const maxDuration = 60;

type Item = { id: string; threadId?: string; fromEmail?: string };

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
      threadId?: string;
      fromEmail?: string;
      items?: Item[];
    };
    if (Array.isArray(body.items) && body.items.length > MAX_MAILBOX_WRITES) {
      return NextResponse.json(
        { error: `At most ${MAX_MAILBOX_WRITES} items per request` },
        { status: 400 },
      );
    }
    const items: Item[] = Array.isArray(body.items) && body.items.length
      ? body.items
      : body.id
        ? [{ id: body.id, threadId: body.threadId, fromEmail: body.fromEmail }]
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
    /** Unsubscribed and muted, but the trash did not fit this request. */
    const untrashed: { id: string; threadId?: string }[] = [];
    const budget = new MailWriteBudget();

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

      const keepUntrashed = (e: unknown) => {
        if (e instanceof MailWriteDeferred) {
          untrashed.push({ id: item.id, threadId: item.threadId });
        }
      };
      if (item.threadId) {
        const threadTrash =
          session.provider === "google" ? gmailThreadAction : graphThreadAction;
        await threadTrash(session.accessToken, item.threadId, "trash", budget).catch(
          keepUntrashed,
        );
      } else {
        await doTrash(session.accessToken, item.id, "trash", budget).catch(
          keepUntrashed,
        );
      }
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
      untrashed,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unsubscribe failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
