import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { buildInboxView } from "@/lib/v2/view/build";
import { parseMailboxLimit } from "@/lib/v3/mailbox/limit";
import { cancelPending } from "@/lib/v3/outbox/repository";
import { getMailboxView } from "@/lib/v3/mailbox/repository";
import { originAllowed } from "@/lib/security/origin";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Undo a pending outbox mutation: cancel the row and revert the optimistic
 * corpus patch. Only works while the command is still pending — no provider
 * call has been made yet.
 */
export async function POST(_request: Request, context: RouteContext) {
  if (
    !originAllowed({
      origin: _request.headers.get("origin"),
      requestOrigin: new URL(_request.url).origin,
      allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
      production: process.env.NODE_ENV === "production",
    })
  ) {
    return NextResponse.json({ error: "invalid request origin" }, { status: 403 });
  }
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }

  const { id } = await context.params;
  const cancelled = await cancelPending(account.id, id);
  if (!cancelled) {
    return NextResponse.json(
      { error: "outbox row not pending or not found" },
      { status: 409 },
    );
  }

  const view = await buildInboxView(account.id, account.provider);
  const mailbox = await getMailboxView(
    account.id,
    "inbox",
    parseMailboxLimit(null),
  );
  return NextResponse.json({ ok: true, view, mailbox });
}
