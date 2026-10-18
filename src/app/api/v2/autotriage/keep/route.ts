import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { originAllowed } from "@/lib/security/origin";
import { executeCommand } from "@/lib/v2/commands/execute";

export const dynamic = "force-dynamic";

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
  let body: { sender?: string; logId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.sender) {
    return NextResponse.json({ error: "sender is required" }, { status: 400 });
  }
  const result = await executeCommand(
    { accountId: account.id },
    { type: "alwaysKeepSender", sender: body.sender, logId: body.logId },
    `autotriage-keep:${body.sender.toLowerCase()}:${body.logId ?? "none"}`,
  );
  return NextResponse.json({ result }, { status: result.ok ? 200 : 400 });
}
