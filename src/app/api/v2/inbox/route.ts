import { after, NextResponse } from "next/server";
import { originAllowed } from "@/lib/security/origin";
import { getActiveV2Account } from "@/lib/v2/session";
import { kickInboxCatchUp } from "@/lib/v2/sync/catch-up";
import { buildInboxView } from "@/lib/v2/view/build";

export const dynamic = "force-dynamic";

function requestOriginAllowed(request: Request): boolean {
  return originAllowed({
    origin: request.headers.get("origin"),
    requestOrigin: new URL(request.url).origin,
    allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
    production: process.env.NODE_ENV === "production",
  });
}

/**
 * The one inbox read for the v2 client. Everything the UI shows — Atlas,
 * records, safe-to-delete, undecided, worth-reading, coverage — is this single
 * server-computed projection. The client renders it and computes no placement.
 * A cross-site navigation carries the SameSite=Lax session cookie, so this GET
 * must never call the provider; catch-up is the POST below.
 */
export async function GET() {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }
  try {
    const view = await buildInboxView(account.id, account.provider);
    return NextResponse.json({ view });
  } catch (cause) {
    // A bare 500 here reaches the user as "inbox 500", which says nothing about
    // whether the database is unreachable, a migration is missing, or a query is
    // wrong. The reason is worth more than the status code.
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : "inbox projection failed" },
      { status: 500 },
    );
  }
}

/**
 * Kick a provider catch-up when the inbox corpus is stale, so Triage and Atlas
 * do not stay on the pre-login corpus. The signed-in client calls this before
 * reading the projection.
 */
export async function POST(request: Request) {
  if (!requestOriginAllowed(request)) {
    return NextResponse.json({ error: "invalid request origin" }, { status: 403 });
  }
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }

  let catchingUp = false;
  try {
    catchingUp = await kickInboxCatchUp(account, (work) => {
      after(() => {
        void work();
      });
    });
  } catch (cause) {
    console.error(
      "[seer] inbox catch-up kick failed",
      account.email,
      cause instanceof Error ? cause.message : cause,
    );
  }
  return NextResponse.json({ catchingUp });
}
