import { getGmailMessage, sendGmailMessage } from "@/lib/mail/gmail";
import {
  getGraphMessage,
  replyGraphMessage,
  sendGraphMessage,
} from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { NextResponse } from "next/server";

type Mode = "compose" | "reply" | "replyAll" | "forward";

function ensureRe(subject: string) {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function ensureFwd(subject: string) {
  return /^(fwd|fw):/i.test(subject) ? subject : `Fwd: ${subject}`;
}

export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const body = (await request.json()) as {
      mode?: Mode;
      to?: string;
      cc?: string;
      subject?: string;
      body?: string;
      replyToId?: string;
    };

    const mode: Mode = body.mode ?? "compose";
    const text = (body.body ?? "").trim();
    if (!text) {
      return NextResponse.json({ error: "Message body required" }, { status: 400 });
    }

    if (session.provider === "google") {
      if (mode === "compose") {
        if (!body.to?.trim()) {
          return NextResponse.json({ error: "To required" }, { status: 400 });
        }
        const sent = await sendGmailMessage(session.accessToken, {
          to: body.to.trim(),
          cc: body.cc,
          subject: body.subject?.trim() || "(no subject)",
          body: text,
        });
        return NextResponse.json({ ok: true, ...sent });
      }

      if (!body.replyToId) {
        return NextResponse.json(
          { error: "replyToId required for reply/forward" },
          { status: 400 },
        );
      }
      const original = await getGmailMessage(
        session.accessToken,
        body.replyToId,
      );

      if (mode === "forward") {
        if (!body.to?.trim()) {
          return NextResponse.json({ error: "To required" }, { status: 400 });
        }
        const quoted = `${text}\n\n---------- Forwarded message ----------\nFrom: ${original.fromName} <${original.fromEmail}>\nSubject: ${original.subject}\n\n${original.textBody || original.snippet}`;
        const sent = await sendGmailMessage(session.accessToken, {
          to: body.to.trim(),
          cc: body.cc,
          subject: ensureFwd(body.subject?.trim() || original.subject),
          body: quoted,
        });
        return NextResponse.json({ ok: true, ...sent });
      }

      const extractEmails = (raw: string) =>
        raw
          .split(/[,;]/)
          .map((part) => {
            const m = part.match(/<([^>]+)>/);
            return (m?.[1] ?? part).trim();
          })
          .filter((e) => e.includes("@"));

      const to =
        mode === "replyAll"
          ? [...extractEmails(original.fromEmail), ...extractEmails(original.toEmail)]
              .filter(
                (e) => e.toLowerCase() !== session.email.toLowerCase(),
              )
              .filter((e, i, arr) => arr.indexOf(e) === i)
              .join(", ") || original.fromEmail
          : original.fromEmail;

      const sent = await sendGmailMessage(session.accessToken, {
        to: body.to?.trim() || to,
        cc:
          mode === "replyAll"
            ? body.cc?.trim() || original.ccEmail
            : body.cc,
        subject: ensureRe(body.subject?.trim() || original.subject),
        body: text,
        threadId: original.threadId,
        inReplyTo: original.messageIdHeader || undefined,
        references: original.messageIdHeader || undefined,
      });
      return NextResponse.json({ ok: true, ...sent });
    }

    // Microsoft Graph
    if (mode === "reply" || mode === "replyAll") {
      if (!body.replyToId) {
        return NextResponse.json(
          { error: "replyToId required" },
          { status: 400 },
        );
      }
      await replyGraphMessage(
        session.accessToken,
        body.replyToId,
        text,
        mode === "replyAll",
      );
      return NextResponse.json({ ok: true });
    }

    if (mode === "forward") {
      if (!body.to?.trim() || !body.replyToId) {
        return NextResponse.json(
          { error: "to and replyToId required" },
          { status: 400 },
        );
      }
      const original = await getGraphMessage(
        session.accessToken,
        body.replyToId,
      );
      const quoted = `${text}\n\n---------- Forwarded message ----------\nFrom: ${original.fromName} <${original.fromEmail}>\nSubject: ${original.subject}\n\n${original.textBody || original.snippet}`;
      await sendGraphMessage(session.accessToken, {
        to: body.to.trim(),
        cc: body.cc,
        subject: ensureFwd(body.subject?.trim() || original.subject),
        body: quoted,
      });
      return NextResponse.json({ ok: true });
    }

    if (!body.to?.trim()) {
      return NextResponse.json({ error: "To required" }, { status: 400 });
    }
    await sendGraphMessage(session.accessToken, {
      to: body.to.trim(),
      cc: body.cc,
      subject: body.subject?.trim() || "(no subject)",
      body: text,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Send failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
