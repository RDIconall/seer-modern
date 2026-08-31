import { NextResponse } from "next/server";
import { defaultReaderModel } from "@/lib/v2/intelligence/model";
import { runReadTick } from "@/lib/v2/intelligence/read-tick";

export const maxDuration = 300;

/**
 * The read cron: turn ingested-but-unread conversations into decisions. Sync
 * ingests mail; this produces the chief-of-staff reads. Bounded per tick by a
 * deadline and split fairly across mailboxes so one backlog cannot stall the
 * others. Auth is mandatory in production.
 */
export async function GET(request: Request) {
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

  const report = await runReadTick({
    deadlineMs: Date.now() + 250_000,
    model: defaultReaderModel,
  });
  return NextResponse.json({ ok: true, report });
}
