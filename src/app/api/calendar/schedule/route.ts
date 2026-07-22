import { gmailAction } from "@/lib/mail/gmail";
import { requireMailSession } from "@/lib/mail/session";
import { NextResponse } from "next/server";

export const maxDuration = 30;

/**
 * "Schedule it" — time-blocking straight from an email. Creates a
 * calendar event holding the task (the ask, spelled out) with a deep
 * link back to the email, then archives the email: the inbox is not a
 * todo list; the calendar is.
 */
export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    if (session.provider !== "google") {
      return NextResponse.json(
        { error: "Schedule-from-email is Gmail-only for now" },
        { status: 400 },
      );
    }

    const body = (await request.json()) as {
      messageId?: string;
      title?: string;
      startsAt?: string;
      durationMins?: number;
      ask?: string;
      subject?: string;
      fromName?: string;
    };
    const title = body.title?.trim();
    const start = body.startsAt ? new Date(body.startsAt) : null;
    const mins = Math.max(5, Math.min(240, body.durationMins ?? 30));
    if (!title || !start || Number.isNaN(start.getTime())) {
      return NextResponse.json(
        { error: "Provide { title, startsAt, durationMins }" },
        { status: 400 },
      );
    }
    const end = new Date(start.getTime() + mins * 60 * 1000);

    const description = [
      body.ask ? `The ask: ${body.ask}` : null,
      body.subject
        ? `Email: "${body.subject}"${body.fromName ? ` — from ${body.fromName}` : ""}`
        : null,
      body.messageId
        ? `Open the email: https://mail.google.com/mail/u/0/#all/${body.messageId}`
        : null,
      "⏱ Time-blocked by Seer",
    ]
      .filter(Boolean)
      .join("\n\n");

    const res = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: title,
          description,
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
          reminders: {
            useDefault: false,
            overrides: [{ method: "popup", minutes: 10 }],
          },
        }),
        cache: "no-store",
      },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      // Two very different 403s: the USER hasn't granted the scope, vs
      // the app's own Google Cloud project has the API switched off.
      const detail = /accessNotConfigured|SERVICE_DISABLED|has not been used in project/i.test(
        errText,
      )
        ? "The app's Google project has the Calendar API disabled — enable it in the Google Cloud console (APIs & Services → Calendar API → Enable)."
        : res.status === 401 || res.status === 403
          ? "Sign in again in Settings to grant calendar write access."
          : `Calendar event failed (${res.status}).`;
      return NextResponse.json({ error: detail }, { status: 502 });
    }
    const event = (await res.json()) as { id?: string; htmlLink?: string };

    // Scheduled = handled: the task lives on the calendar now
    if (body.messageId) {
      await gmailAction(session.accessToken, body.messageId, "archive").catch(
        () => {},
      );
    }

    return NextResponse.json({
      ok: true,
      eventId: event.id,
      link: event.htmlLink,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Schedule failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
