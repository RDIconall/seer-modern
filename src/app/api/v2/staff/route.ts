import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { loadStaffView } from "@/lib/v2/staff/repository";

export const dynamic = "force-dynamic";

/**
 * Atlas staff projection: delegated tasks, pending triage proposals, and
 * Chief of staff chat. The bot never calls this (SSO); Conall's client does.
 */
export async function GET(request: Request) {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }
  const url = new URL(request.url);
  const taskId = url.searchParams.get("taskId");
  try {
    const view = await loadStaffView(account.id, { taskId });
    return NextResponse.json({ view });
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : "staff projection failed" },
      { status: 500 },
    );
  }
}
