import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import {
  isGeminiConfigured,
  resolveAssistantModel,
} from "@/lib/inbox/gemini-triage";
import { historySignals } from "@/lib/inbox/mail-history";
import { listGmailFolder, listGmailInbox } from "@/lib/mail/gmail";
import { listGraphFolder, listGraphInbox } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { loadActionMemory } from "@/lib/store/action-memory";
import { getSenderOverride } from "@/lib/store/senders";
import { generateText, Output } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";

export const maxDuration = 60;

const MAX_SENDERS = 60;

const agentSchema = z.object({
  senders: z.array(
    z.object({
      email: z.string(),
      /** Cut this sender loose? */
      unsubscribe: z.boolean(),
      /** Does the user's PHONE already push this exact information? */
      phoneDup: z.boolean(),
      reason: z.string(),
    }),
  ),
});

const AGENT_PROMPT = `You are Seer's aggressive unsubscribe agent. The user wants a QUIET inbox: every mailing list they don't truly read is a tax on their attention.

Input: sender aggregates from their inbox. Fields: email, name, count (emails in inbox now), engaged (user has written to them), trashRate (share of their mail the user deletes), subjects (samples).

For each sender decide:
- unsubscribe: TRUE for marketing lists, promos, digests, community updates, and any bulk sender the user never engages with. Be AGGRESSIVE — when in doubt, cut. FALSE only for: senders the user writes to, transactional-only senders (receipts, security codes, bills, government/school), and anything clearly load-bearing.
- phoneDup: TRUE when the email duplicates a push notification their phone already shows — payment apps (Venmo/Zelle/PayPal activity), bank transaction alerts, rideshare/delivery status (Uber/Lyft/DoorDash), social activity (Instagram/Facebook/LinkedIn/X likes, follows, messages, connection requests), package tracking pings, smart-home alerts (Ring/Nest), community apps (Nextdoor), chat apps (Discord/GroupMe). The email adds nothing the lock screen didn't.
- reason: one blunt sentence the user will read, e.g. "Coupon blasts you delete 90% of the time" or "Your phone already pings you for every Venmo payment".

Do NOT suggest unsubscribing from real people. Receipts/security-only senders stay unless every email they send is also a phone push.`;

export async function GET() {
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

    const raw =
      session.provider === "google"
        ? await listGmailInbox(session.accessToken, 500)
        : await listGraphInbox(session.accessToken, 500);

    const [history, actionMemory] = await Promise.all([
      getOrBuildMailHistory(
        session.email,
        session.accessToken,
        {
          listFolder: (token, folder, max) =>
            session.provider === "google"
              ? listGmailFolder(token, folder, max)
              : listGraphFolder(token, folder, max),
        },
        raw,
      ),
      loadActionMemory(session.email),
    ]);

    // Aggregate inbox by sender
    type Agg = {
      email: string;
      name: string;
      count: number;
      subjects: string[];
      latestId: string;
      lastAt: string;
    };
    const bySender = new Map<string, Agg>();
    for (const m of raw) {
      const key = m.fromEmail.toLowerCase();
      const agg = bySender.get(key) ?? {
        email: m.fromEmail,
        name: m.fromName,
        count: 0,
        subjects: [],
        latestId: m.id,
        lastAt: m.receivedAt,
      };
      agg.count += 1;
      if (agg.subjects.length < 3) agg.subjects.push(m.subject.slice(0, 70));
      if (m.receivedAt > agg.lastAt) {
        agg.lastAt = m.receivedAt;
        agg.latestId = m.id;
      }
      bySender.set(key, agg);
    }

    // Candidates: bulk-ish senders the user doesn't write to and hasn't
    // already taught. Real people never enter the list.
    const candidates: (Agg & { engaged: boolean; trashRate: number })[] = [];
    for (const agg of bySender.values()) {
      const sig = historySignals(history, agg.email);
      if (sig.sentTo > 0) continue;
      const taught = await getSenderOverride(agg.email);
      if (taught) continue;
      const stat = actionMemory[agg.email.toLowerCase()];
      const total = (stat?.archive ?? 0) + (stat?.trash ?? 0);
      candidates.push({
        ...agg,
        engaged: false,
        trashRate: total > 0 ? (stat?.trash ?? 0) / total : 0,
      });
    }
    candidates.sort((a, b) => b.count - a.count);
    const batch = candidates.slice(0, MAX_SENDERS);

    if (batch.length === 0) {
      return NextResponse.json({ suggestions: [], scanned: bySender.size });
    }

    const { model } = await resolveAssistantModel();
    const { output } = await generateText({
      model,
      temperature: 0,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(30_000),
      output: Output.object({ schema: agentSchema }),
      system: AGENT_PROMPT,
      prompt: JSON.stringify(
        batch.map((c) => ({
          email: c.email,
          name: c.name.slice(0, 50),
          count: c.count,
          trashRate: Math.round(c.trashRate * 100) / 100,
          subjects: c.subjects,
        })),
      ),
    });

    const verdicts = new Map(
      (output?.senders ?? []).map((s) => [s.email.toLowerCase(), s]),
    );
    const suggestions = batch
      .map((c) => {
        const v = verdicts.get(c.email.toLowerCase());
        if (!v?.unsubscribe && !v?.phoneDup) return null;
        return {
          fromEmail: c.email,
          fromName: c.name,
          count: c.count,
          lastAt: c.lastAt,
          latestId: c.latestId,
          phoneDup: Boolean(v?.phoneDup),
          reason: v?.reason ?? "Bulk sender you never engage with",
        };
      })
      .filter(Boolean);

    return NextResponse.json({
      suggestions,
      scanned: bySender.size,
      considered: batch.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Agent failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
