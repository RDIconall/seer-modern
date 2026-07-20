import {
  isGeminiConfigured,
  resolveAssistantModel,
} from "@/lib/inbox/gemini-triage";
import { getGmailMessage } from "@/lib/mail/gmail";
import { getGraphMessage } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import {
  loadUserProfile,
  profilePromptBlock,
} from "@/lib/store/user-profile";
import { generateText, Output } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";

export const maxDuration = 60;

const draftSchema = z.object({
  body: z.string(),
});

const INTENT_HINTS: Record<string, string> = {
  yes: "The user wants to say YES / agree / accept. Keep it warm and brief.",
  no: "The user wants to decline politely but clearly, without over-apologizing.",
  later:
    "The user can't deal with this now. Buy time gracefully: acknowledge, give a realistic follow-up window, no fake excuses.",
  delegate:
    "This is NOT a reply to the sender. Write a short forwarding note handing off this task to a helper. Open by addressing them by first name, say the user wants their help with this, then say exactly what to do (call the company/bank, chase the status, schedule, fill the form, handle the return…), what outcome to report back, and any deadline. Include the key facts from the email so they don't have to ask. Warm, direct, zero fluff.",
  nudge:
    "The email shown is the user's OWN earlier message that never got a reply. Write a short, friendly follow-up to the same recipient: reference what was asked in one clause, ask if there's any update, offer to make it easy ('happy to resend / jump on a call'). 1-3 sentences, zero guilt-tripping, no 'just checking in' filler openings.",
};

/**
 * One-tap AI reply drafts. Gemini reads the full email and writes a
 * ready-to-edit reply in a natural voice.
 */
export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    if (!isGeminiConfigured()) {
      return NextResponse.json(
        { error: "Gemini is not configured" },
        { status: 503 },
      );
    }

    const { id, intent, to, toName, instruction } =
      (await request.json()) as {
        id?: string;
        intent?: string;
        /** Delegate: who the handoff goes to */
        to?: string;
        toName?: string;
        /** Delegate: what the user wants done, in their words */
        instruction?: string;
      };
    if (!id) {
      return NextResponse.json({ error: "Provide { id }" }, { status: 400 });
    }

    const message =
      session.provider === "google"
        ? await getGmailMessage(session.accessToken, id)
        : await getGraphMessage(session.accessToken, id);

    const bodyText = (
      message.textBody ||
      message.htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
    ).slice(0, 5000);

    const firstName = (session.name || session.email).split(/[\s@]/)[0];
    const hint = intent ? INTENT_HINTS[intent] : undefined;

    const profile = await loadUserProfile(session.email);
    const profileBlock = profilePromptBlock(profile);

    const { model } = await resolveAssistantModel();
    const { output } = await generateText({
      model,
      temperature: 0.4,
      maxRetries: 1,
      output: Output.object({ schema: draftSchema }),
      system: `You draft email replies for ${firstName} <${session.email}>.
Rules:
- Write ONLY the reply body (no subject, no quoted original).
- Sound like a busy, warm human: short sentences, no corporate filler, no "I hope this email finds you well".
- Answer what was actually asked. If information is missing, make the smallest reasonable assumption and move on — do not ask the user questions.
- 1-4 sentences unless the email genuinely requires more.
- Sign off with just "${firstName}".${profileBlock ? `\n\n${profileBlock}\nUse this to answer accurately as them (their role, family, commitments) and to match their voice — never contradict it.` : ""}`,
      prompt: JSON.stringify({
        from: `${message.fromName} <${message.fromEmail}>`,
        subject: message.subject,
        email: bodyText,
        ...(hint ? { direction: hint } : {}),
        ...(intent === "delegate" && toName
          ? { handoffTo: toName }
          : {}),
        ...(intent === "delegate" && instruction?.trim()
          ? { userWants: instruction.trim() }
          : {}),
      }),
    });

    if (!output?.body) {
      return NextResponse.json({ error: "Draft failed" }, { status: 502 });
    }

    // Delegation goes to the chosen helper as a forward, not the sender
    if (intent === "delegate") {
      return NextResponse.json({
        body: output.body.trim(),
        to: to?.trim() || process.env.SEER_EA_EMAIL?.trim() || "",
        subject: /^(fwd|fw):/i.test(message.subject)
          ? message.subject
          : `Fwd: ${message.subject}`,
        replyToId: id,
        mode: "forward",
        archiveOriginal: true,
      });
    }

    // Nudges reply to the RECIPIENT of the user's own sent message
    const to =
      intent === "nudge"
        ? (message.toEmail.split(",")[0]?.trim() ?? message.fromEmail)
        : message.fromEmail;

    return NextResponse.json({
      body: output.body.trim(),
      to,
      subject: /^re:/i.test(message.subject)
        ? message.subject
        : `Re: ${message.subject}`,
      replyToId: id,
      mode: "reply",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Draft failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
