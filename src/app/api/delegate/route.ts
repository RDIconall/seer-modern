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
 * Delegate: forward the email to whoever should own it with a short handoff
 * note, then archive it — off your plate, on theirs.
 *
 * `to` is optional. Without it the configured EA is used, which is the old
 * behaviour. With it, delegation is what it actually is in practice: a
 * forward to the right person. Locking this to a single assistant meant a
 * change order could not go to the COO or an NDA to counsel without leaving
 * the app, which is why delegation was not happening inside it.
 */
export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const body = (await request.json()) as {
      id?: string;
      to?: string;
      note?: string;
      /** Keep the thread in the inbox — used when handing off for input. */
      keep?: boolean;
    };
    if (!body.id) {
      return NextResponse.json({ error: "Provide { id }" }, { status: 400 });
    }

    let to = body.to?.trim();
    let name = "";
    if (!to) {
      const ea = await loadEa(session.email);
      if (!ea) {
        return NextResponse.json(
          { error: "No recipient given and no EA configured", needsEa: true },
          { status: 412 },
        );
      }
      to = ea.email;
      name = ea.name ?? "";
    }

    const first = (name || to).split(/[\s@]/)[0];
    const note =
      body.note?.trim() ||
      `${first ? `${first} — c` : "C"}an you take this one? Thanks!`;

    const quote = (o: {
      fromName: string;
      fromEmail: string;
      subject: string;
      textBody?: string;
      snippet?: string;
    }) =>
      `${note}\n\n---------- Forwarded message ----------\nFrom: ${o.fromName} <${o.fromEmail}>\nSubject: ${o.subject}\n\n${o.textBody || o.snippet}`;

    if (session.provider === "google") {
      const original = await getGmailMessage(session.accessToken, body.id);
      await sendGmailMessage(session.accessToken, {
        to,
        subject: ensureFwd(original.subject),
        body: quote(original),
      });
      if (!body.keep) {
        await gmailAction(session.accessToken, body.id, "archive").catch(() => {});
      }
    } else {
      const original = await getGraphMessage(session.accessToken, body.id);
      await sendGraphMessage(session.accessToken, {
        to,
        subject: ensureFwd(original.subject),
        body: quote(original),
      });
      if (!body.keep) {
        await graphAction(session.accessToken, body.id, "archive").catch(() => {});
      }
    }

    return NextResponse.json({ ok: true, to });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Delegate failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
