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
    "This is NOT a reply to the sender. Write a short forwarding note to the user's executive assistant handing off this task. Say exactly what to do (call the company/bank, chase the status, schedule, handle the return…), what outcome to report back, and any deadline. Include the key facts from the email so the EA doesn't have to ask. Address the EA directly.",
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

    const { id, intent } = (await request.json()) as {
      id?: string;
      intent?: string;
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
      }),
    });

    if (!output?.body) {
      return NextResponse.json({ error: "Draft failed" }, { status: 502 });
    }

    // Delegation goes to the EA as a forward, not back to the sender
    if (intent === "delegate") {
      return NextResponse.json({
        body: output.body.trim(),
        to: process.env.SEER_EA_EMAIL?.trim() ?? "",
        subject: /^(fwd|fw):/i.test(message.subject)
          ? message.subject
          : `Fwd: ${message.subject}`,
        replyToId: id,
        mode: "forward",
      });
    }

    return NextResponse.json({
      body: output.body.trim(),
      to: message.fromEmail,
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
