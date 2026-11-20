import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { originAllowed } from "@/lib/security/origin";
import {
  previewMailboxStyle,
  refreshMailboxInference,
  type StoredMailboxStyle,
} from "@/lib/v2/intelligence/mailbox-style-store";

export const dynamic = "force-dynamic";

function requestOriginAllowed(request: Request): boolean {
  return originAllowed({
    origin: request.headers.get("origin"),
    requestOrigin: new URL(request.url).origin,
    allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
    production: process.env.NODE_ENV === "production",
  });
}

function styleResponse(style: StoredMailboxStyle) {
  return NextResponse.json({
    clearHabit: style.clearHabit,
    importanceCues: style.importanceCues,
    matterBar: style.matterBar,
    confirmed: style.confirmed,
    inferred: style.inferred,
    driftPrompt: style.driftPrompt,
    snapshot: style.snapshot,
    confirmedAt: style.confirmedAt,
  });
}

/**
 * Hypothesis + confirmed style for this mailbox. GET is read-only: a
 * cross-site navigation carries the session cookie, so it must not write.
 */
export async function GET() {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active account" }, { status: 404 });
  }
  return styleResponse(await previewMailboxStyle(account.id));
}

/**
 * Recompute the inference and store it. An unconfirmed style takes the new
 * hypothesis; a confirmed style keeps its fields.
 */
export async function POST(request: Request) {
  if (!requestOriginAllowed(request)) {
    return NextResponse.json({ error: "invalid request origin" }, { status: 403 });
  }
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active account" }, { status: 404 });
  }
  return styleResponse(await refreshMailboxInference(account.id));
}
