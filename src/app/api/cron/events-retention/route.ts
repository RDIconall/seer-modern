import { NextResponse } from "next/server";
import { cronUnauthorized } from "@/lib/v2/cron/auth";
import {
  EVENTS_RETENTION_MIN_DAYS,
  eventsRetentionDays,
  purgeOldEvents,
} from "@/lib/v2/events/retention";

export const maxDuration = 60;

/**
 * Deletes seer.events rows older than 90 days (or SEER_EVENTS_RETENTION_DAYS
 * if that is a larger integer). Does not delete conversations, messages,
 * decisions, yields, matters, outbox, receipts, or staff tables.
 */
export async function GET(request: Request) {
  const denied = cronUnauthorized(request);
  if (denied) return denied;

  let days: number;
  try {
    days = eventsRetentionDays();
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : "invalid retention" },
      { status: 500 },
    );
  }
  if (days < EVENTS_RETENTION_MIN_DAYS) {
    return NextResponse.json(
      { error: `refusing to purge events newer than ${EVENTS_RETENTION_MIN_DAYS} days` },
      { status: 500 },
    );
  }

  const deleted = await purgeOldEvents(days);
  return NextResponse.json({
    ok: true,
    deleted,
    retentionDays: days,
    table: "seer.events",
    removes:
      "rows in seer.events whose created_at is older than the retention window",
    doesNotRemove: [
      "conversations",
      "messages",
      "conversation_decisions",
      "yields",
      "matters",
      "outbox",
      "command_receipts",
      "bot_tasks",
      "triage_proposals",
    ],
  });
}
