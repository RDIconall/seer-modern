import { NextResponse } from "next/server";
import { cutoverEligible, type ShadowReport } from "@/lib/v2/shadow/report";

export const dynamic = "force-dynamic";

/**
 * Report the current cutover eligibility for an account. This endpoint is
 * read-only: it evaluates a supplied shadow report against the gate. Producing a
 * live report is done by the offline runner (scripts/run-v2-shadow.mts), which
 * needs the durable database and model keys.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "CRON_SECRET is required in production" },
      { status: 500 },
    );
  }

  let report: ShadowReport;
  try {
    report = (await request.json()) as ShadowReport;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  return NextResponse.json({ decision: cutoverEligible(report) });
}
