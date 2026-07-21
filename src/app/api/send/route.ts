import { getGmailMessage, gmailAction, sendGmailMessage } from "@/lib/mail/gmail";
import {
  getGraphMessage,
  graphAction,
  replyGraphMessage,
  sendGraphMessage,
} from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { recordRepliedThread } from "@/lib/store/replied-threads";
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
      /** Delegation: the forward hands it off, the original leaves the inbox */
      archiveOriginal?: boolean;
    };

    const mode: Mode = body.mode ?? "compose";
    const text = (body.body ?? "").trim();
    // A forward's body IS the original message — a note on top is
    // optional. Compose/reply with nothing to say is still an error.
    if (!text && mode !== "forward") {
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

      const originalText = (
        original.textBody ||
        original.htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") ||
        original.snippet
      ).slice(0, 20_000);

      if (mode === "forward") {
        if (!body.to?.trim()) {
          return NextResponse.json({ error: "To required" }, { status: 400 });
        }
        const quoted = `${text ? `${text}\n\n` : ""}---------- Forwarded message ----------\nFrom: ${original.fromName} <${original.fromEmail}>\nDate: ${new Date(original.receivedAt).toLocaleString()}\nSubject: ${original.subject}\nTo: ${original.toEmail}\n\n${originalText}`;
        const sent = await sendGmailMessage(session.accessToken, {
          to: body.to.trim(),
          cc: body.cc,
          subject: ensureFwd(body.subject?.trim() || original.subject),
          body: quoted,
        });
        if (body.archiveOriginal) {
          await gmailAction(
            session.accessToken,
            body.replyToId,
            "archive",
          ).catch(() => {});
        }
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

      // Quote the original under the reply, the way every mail client
      // does — the recipient sees what's being answered.
      const quotedReply = `${text}\n\nOn ${new Date(
        original.receivedAt,
      ).toLocaleString()}, ${original.fromName} <${original.fromEmail}> wrote:\n${originalText
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")}`;

      const sent = await sendGmailMessage(session.accessToken, {
        to: body.to?.trim() || to,
        cc:
          mode === "replyAll"
            ? body.cc?.trim() || original.ccEmail
            : body.cc,
        subject: ensureRe(body.subject?.trim() || original.subject),
        body: quotedReply,
        threadId: original.threadId,
        inReplyTo: original.messageIdHeader || undefined,
        references: original.messageIdHeader || undefined,
      });
      // Replied = handled: remember the thread (cards flip to "done"
      // instantly) and archive the original — inbox stays small.
      await recordRepliedThread(session.email, original.threadId).catch(
        () => {},
      );
      await gmailAction(session.accessToken, body.replyToId, "archive").catch(
        () => {},
      );
      return NextResponse.json({ ok: true, ...sent, archived: true });
    }

    // Microsoft Graph
    if (mode === "reply" || mode === "replyAll") {
      if (!body.replyToId) {
        return NextResponse.json(
          { error: "replyToId required" },
          { status: 400 },
        );
      }
      const original = await getGraphMessage(
        session.accessToken,
        body.replyToId,
      );
      await replyGraphMessage(
        session.accessToken,
        body.replyToId,
        text,
        mode === "replyAll",
      );
      await recordRepliedThread(session.email, original.threadId).catch(
        () => {},
      );
      await graphAction(session.accessToken, body.replyToId, "archive").catch(
        () => {},
      );
      return NextResponse.json({ ok: true, archived: true });
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
      const quoted = `${text ? `${text}\n\n` : ""}---------- Forwarded message ----------\nFrom: ${original.fromName} <${original.fromEmail}>\nSubject: ${original.subject}\n\n${original.textBody || original.snippet}`;
      await sendGraphMessage(session.accessToken, {
        to: body.to.trim(),
        cc: body.cc,
        subject: ensureFwd(body.subject?.trim() || original.subject),
        body: quoted,
      });
      if (body.archiveOriginal) {
        await graphAction(
          session.accessToken,
          body.replyToId,
          "archive",
        ).catch(() => {});
      }
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
