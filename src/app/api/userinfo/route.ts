import { auth } from "@/auth";
import { LEGACY_USER_COOKIE } from "@/lib/future-ios";
import type { IphoneUserinfo } from "@/lib/api-parity/iphone-task-types";
import { NextResponse } from "next/server";

/** Stub parity for legacy GET /api/userinfo — extend when user settings are persisted. */
export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const email = session.user.email;
  const payload: IphoneUserinfo = {
    email,
    name: session.user.name ?? email,
    autoStar: false,
    autoUnstar: false,
    subscribed: true,
    remindTime: 32_400_000,
    expiration: 14,
    reminderDelay: 1,
    followupDelay: 3,
    emailAddresses: [email],
  };

  const res = NextResponse.json(payload);
  res.headers.set("X-Seer-Legacy-Cookie-Ref", LEGACY_USER_COOKIE);
  return res;
}
