import { getGmailMessage, sendGmailMessage, gmailAction } from "@/lib/mail/gmail";
import {
  getGraphMessage,
  graphAction,
  sendGraphMessage,
} from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { loadEa } from "@/lib/store/ea";
import { NextResponse } from "next/server";

export const maxDuration = 30;

function ensureFwd(subject: string) {
  return /^(fwd|fw):/i.test(subject) ? subject : `Fwd: ${subject}`;
}

/**
 * Delegate to EA: forward the email to the configured assistant with a
 * short handoff note, then archive it — off your plate, on theirs.
 */
export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const body = (await request.json()) as { id?: string; note?: string };
    if (!body.id) {
      return NextResponse.json({ error: "Provide { id }" }, { status: 400 });
    }

    const ea = await loadEa(session.email);
    if (!ea) {
      return NextResponse.json(
        { error: "No EA configured — add one in Settings", needsEa: true },
        { status: 412 },
      );
    }

    const note =
      body.note?.trim() ||
      `${ea.name ? `${ea.name.split(" ")[0]} — c` : "C"}an you take care of this one? Thanks!`;

    if (session.provider === "google") {
      const original = await getGmailMessage(session.accessToken, body.id);
      const quoted = `${note}\n\n---------- Forwarded message ----------\nFrom: ${original.fromName} <${original.fromEmail}>\nSubject: ${original.subject}\n\n${original.textBody || original.snippet}`;
      await sendGmailMessage(session.accessToken, {
        to: ea.email,
        subject: ensureFwd(original.subject),
        body: quoted,
      });
      await gmailAction(session.accessToken, body.id, "archive").catch(() => {});
    } else {
      const original = await getGraphMessage(session.accessToken, body.id);
      const quoted = `${note}\n\n---------- Forwarded message ----------\nFrom: ${original.fromName} <${original.fromEmail}>\nSubject: ${original.subject}\n\n${original.textBody || original.snippet}`;
      await sendGraphMessage(session.accessToken, {
        to: ea.email,
        subject: ensureFwd(original.subject),
        body: quoted,
      });
      await graphAction(session.accessToken, body.id, "archive").catch(() => {});
    }

    return NextResponse.json({ ok: true, ea: ea.email });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Delegate failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
