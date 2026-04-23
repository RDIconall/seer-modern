import { auth } from "@/auth";
import { LEGACY_SESSION_COOKIE } from "@/lib/future-ios";
import type { IphoneTask } from "@/lib/api-parity/iphone-task-types";
import { NextResponse } from "next/server";

/** Stub parity for legacy GET /api/alltasks — returns empty array until tasks DB exists. */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tasks: IphoneTask[] = [];
  const res = NextResponse.json(tasks);
  res.headers.set("X-Seer-Legacy-Cookie-Ref", LEGACY_SESSION_COOKIE);
  return res;
}
