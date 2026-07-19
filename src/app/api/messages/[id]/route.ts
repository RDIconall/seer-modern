import { buildActionGuideDetailed } from "@/lib/inbox/action-guide";
import { classifyMessage } from "@/lib/inbox/classify";
import { classifyInboxWithAssistant } from "@/lib/inbox/gemini-triage";
import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import { getGmailMessage, listGmailFolder } from "@/lib/mail/gmail";
import { getGraphMessage, listGraphFolder } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { getSenderOverride } from "@/lib/store/senders";
import { NextResponse } from "next/server";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const message =
      session.provider === "google"
        ? await getGmailMessage(session.accessToken, id)
        : await getGraphMessage(session.accessToken, id);

    const history = await getOrBuildMailHistory(
      session.email,
      session.accessToken,
      {
        listFolder: (token, folder, max) =>
          session.provider === "google"
            ? listGmailFolder(token, folder, max)
            : listGraphFolder(token, folder, max),
      },
    );

    const bodyText =
      message.textBody ||
      message.htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    const decisions = await classifyInboxWithAssistant(
      session.email,
      [
        {
          id: message.id,
          fromEmail: message.fromEmail,
          fromName: message.fromName,
          subject: message.subject,
          snippet: (message.snippet || bodyText).slice(0, 600),
        },
      ],
      history,
      (email) => getSenderOverride(email),
      classifyMessage,
    );

    const fromAssistant = decisions.get(message.id);
    const classification =
      fromAssistant ??
      ({
        ...classifyMessage(
          {
            fromEmail: message.fromEmail,
            fromName: message.fromName,
            subject: message.subject,
            snippet: message.snippet,
          },
          await getSenderOverride(message.fromEmail),
          history,
        ),
        source: "rules" as const,
      });

    const guide = await buildActionGuideDetailed(
      classification,
      message.subject,
      message.snippet,
      bodyText,
    );

    return NextResponse.json({ message, guide, classification });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to load message";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
