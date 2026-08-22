import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { findOutboxById } from "@/lib/v3/outbox/repository";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Provider confirmation state for one queued mailbox action. */
export async function GET(_request: Request, context: RouteContext) {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }
  const { id } = await context.params;
  const item = await findOutboxById(account.id, id);
  if (!item) {
    return NextResponse.json({ error: "action not found" }, { status: 404 });
  }
  return NextResponse.json({
    status: item.status,
    attempts: item.attempts,
    lastError: item.lastError,
    reconcileNeeded: item.reconcileNeeded,
    updatedAt: item.updatedAt,
  });
}
