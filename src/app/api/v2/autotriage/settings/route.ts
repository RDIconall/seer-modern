import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { originAllowed } from "@/lib/security/origin";
import { executeCommand } from "@/lib/v2/commands/execute";
import { ensureSettings } from "@/lib/v2/autotriage/repository";
import {
  effectiveAutoTriageMode,
  envAutoTriageMode,
} from "@/lib/v2/autotriage/run";
import type { AutoTriageMode } from "@/lib/v2/autotriage/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }
  const settings = await ensureSettings(account.id);
  const envMode = envAutoTriageMode();
  return NextResponse.json({
    settings,
    envMode,
    effectiveMode: effectiveAutoTriageMode(envMode, settings.mode),
  });
}

export async function POST(request: Request) {
  if (
    !originAllowed({
      origin: request.headers.get("origin"),
      requestOrigin: new URL(request.url).origin,
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
  let body: { mode?: AutoTriageMode };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.mode) {
    return NextResponse.json({ error: "mode is required" }, { status: 400 });
  }
  const result = await executeCommand(
    { accountId: account.id },
    { type: "setAutoTriageMode", mode: body.mode },
    `autotriage-mode:${account.id}:${body.mode}`,
  );
  return NextResponse.json({ result }, { status: result.ok ? 200 : 400 });
}
