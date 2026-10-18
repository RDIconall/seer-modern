import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { ensureSettings, loadAudit } from "@/lib/v2/autotriage/repository";
import {
  effectiveAutoTriageMode,
  envAutoTriageMode,
} from "@/lib/v2/autotriage/run";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }
  const url = new URL(request.url);
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7));
  const [groups, settings] = await Promise.all([
    loadAudit(account.id, days),
    ensureSettings(account.id),
  ]);
  const envMode = envAutoTriageMode();
  return NextResponse.json({
    groups,
    settings,
    envMode,
    effectiveMode: effectiveAutoTriageMode(envMode, settings.mode),
  });
}
