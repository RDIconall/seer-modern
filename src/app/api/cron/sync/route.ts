import { buildActionGuideQuick } from "@/lib/inbox/action-guide";
import { classifyMessage } from "@/lib/inbox/classify";
import { classifyInboxWithAssistant } from "@/lib/inbox/gemini-triage";
import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import { BRIEF_ENGINE, buildBrief, loadBrief } from "@/lib/inbox/matters";
import type { EmailItem } from "@/lib/inbox/types";
import { getInboxSnapshot } from "@/lib/mail/inbox-snapshot";
import {
  getGmailInboxTotals,
  getGmailMessage,
  getGmailThreadLast,
  listGmailFolder,
  searchGmail,
} from "@/lib/mail/gmail";
import {
  getGraphInboxTotals,
  getGraphMessage,
  listGraphFolder,
} from "@/lib/mail/graph";
import { makeGmailLabelStore } from "@/lib/mail/seer-labels";
import { withFreshToken } from "@/lib/mail/vault";
import { listAccountsWithTokens } from "@/lib/store/accounts";
import { loadActionMemory } from "@/lib/store/action-memory";
import { loadRepliedThreads } from "@/lib/store/replied-threads";
import { loadFunctions } from "@/lib/store/functions";
import { readEmails } from "@/lib/inbox/understanding";
import {
  loadUnderstanding,
  mergeUnderstanding,
  unreadIds,
} from "@/lib/store/understanding-store";
import { loadUserProfile } from "@/lib/store/user-profile";
import { getSenderOverride } from "@/lib/store/senders";
import { NextResponse } from "next/server";

/** Deep enough to cover a real 500+ inbox in one pass */
const INBOX_DEPTH = 1200;

/**
 * Deep reads per tick. A full backlog drains over several ticks rather
 * than blowing the function's time budget in one.
 */
const DEEP_READS_PER_TICK = 90;

export const maxDuration = 300;

/** Rebuild the brief when it's older than this even without new mail. */
const BRIEF_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * THE SYNC CRON — Seer checks the mail so the user doesn't. Every few
 * minutes, per account: refresh the token from the vault, pull the
 * inbox, grade whatever's new (cached forever after), and keep the
 * brief fresh. By the time the app opens, everything is already read.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const started = Date.now();
  const report: Record<string, unknown>[] = [];
  const accounts = await listAccountsWithTokens();

  for (const stored of accounts) {
    // Whole-run budget: leave headroom; the next tick continues.
    if (Date.now() - started > 240_000) {
      report.push({ email: stored.email, skipped: "time budget" });
      continue;
    }
    const acct = await withFreshToken(stored);
    if (!acct || "error" in acct || !acct.accessToken) {
      report.push({
        email: stored.email,
        error: acct && "error" in acct ? acct.error : "no usable token",
      });
      continue;
    }
    const token = acct.accessToken;
    const isGoogle = acct.provider === "google";

    try {
      const raw = await getInboxSnapshot(
        acct.email,
        () =>
          isGoogle
            ? listGmailFolder(token, "inbox", INBOX_DEPTH)
            : listGraphFolder(token, "inbox", INBOX_DEPTH),
        { force: true },
      );

      const [history, labels, profile, actionMemory, replied] =
        await Promise.all([
          getOrBuildMailHistory(
            acct.email,
            token,
            {
              listFolder: (t, f, max) =>
                isGoogle
                  ? listGmailFolder(t, f, max)
                  : listGraphFolder(t, f, max),
              listArchive: isGoogle
                ? (t, max) =>
                    searchGmail(
                      t,
                      "-in:inbox -in:sent -in:trash -in:spam is:read",
                      max,
                    )
                : undefined,
            },
            raw,
          ),
          isGoogle
            ? makeGmailLabelStore(token, acct.email)
            : Promise.resolve(null),
          loadUserProfile(acct.email),
          loadActionMemory(acct.email),
          loadRepliedThreads(acct.email),
        ]);

      // Inline grading — this IS the background, blocking is the point
      const decisions = await classifyInboxWithAssistant(
        acct.email,
        raw.map((m) => ({
          id: m.id,
          fromEmail: m.fromEmail,
          fromName: m.fromName,
          subject: m.subject,
          snippet: m.snippet,
          labelIds: m.labelIds,
          threadId: m.threadId,
          receivedAt: m.receivedAt,
        })),
        history,
        (email) => getSenderOverride(email),
        classifyMessage,
        {
          profile,
          actionMemory,
          replied,
          labels,
          geminiEnabled: true,
          threadLast: isGoogle
            ? (tid) => getGmailThreadLast(token, tid)
            : undefined,
          fetchBody: async (id) => {
            const msg = isGoogle
              ? await getGmailMessage(token, id)
              : await getGraphMessage(token, id);
            return (
              msg.textBody ||
              msg.htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
            );
          },
        },
      );

      // ---- DEEP READS -------------------------------------------------
      // The expensive, once-per-email pass that gives every downstream
      // judgment something real to work with. Bounded per tick; the
      // backlog drains over successive ticks, newest first.
      const functions = await loadFunctions(acct.email);
      const priorReads = await loadUnderstanding(acct.email);
      const needReads = unreadIds(raw, priorReads);
      let deepReads = 0;
      if (needReads.length > 0) {
        const byId = new Map(raw.map((m) => [m.id, m]));
        const queue = needReads
          .map((id) => byId.get(id)!)
          .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
          .slice(0, DEEP_READS_PER_TICK);
        const records = await readEmails(queue, {
          functions,
          deadlineMs: Math.min(
            Date.now() + 110_000,
            started + 250_000,
          ),
          fetchBody: async (id) => {
            const msg = isGoogle
              ? await getGmailMessage(token, id)
              : await getGraphMessage(token, id);
            return (
              msg.textBody ||
              msg.htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
            );
          },
        });
        deepReads = records.length;
        await mergeUnderstanding(
          acct.email,
          records,
          new Set(raw.map((m) => m.id)),
        );
      }
      const understanding = await loadUnderstanding(acct.email);

      let freshReads = 0;
      for (const r of decisions.values()) {
        if (r.source === "gemini" && !r.cached) freshReads += 1;
      }

      // Brief stays current: new grades landed, it aged out, or it came
      // from an older engine (a redesign must not leave stale Atlas up).
      const brief = await loadBrief(acct.email);
      const briefAge =
        brief && brief.engine === BRIEF_ENGINE
          ? Date.now() - new Date(brief.builtAt).getTime()
          : Infinity;
      let briefRebuilt = false;
      let briefError: string | undefined;
      if (freshReads > 0 || deepReads > 0 || briefAge > BRIEF_MAX_AGE_MS) {
        const items: EmailItem[] = raw.map((m) => {
          const r = decisions.get(m.id);
          return {
            ...m,
            fromName:
              m.fromEmail.toLowerCase() === acct.email.toLowerCase()
                ? "You"
                : m.fromName,
            guide: r
              ? buildActionGuideQuick(r, m.subject, m.fromName, m.snippet)
              : undefined,
          };
        });
        const providerTotal = isGoogle
          ? await getGmailInboxTotals(token)
          : await getGraphInboxTotals(token);
        try {
          await buildBrief(
            acct.email,
            items,
            profile,
            providerTotal,
            understanding,
          );
          briefRebuilt = true;
        } catch (e) {
          briefError =
            e instanceof Error ? e.message.slice(0, 300) : "brief failed";
          // Own log line — the end-of-run report can get truncated away
          console.error(`[seer] cron brief failed for ${acct.email}: ${briefError}`);
        }
      }

      report.push({
        email: acct.email,
        inbox: raw.length,
        graded: decisions.size,
        freshReads,
        deepReads,
        stillUnread: Math.max(0, needReads.length - deepReads),
        briefRebuilt,
        ...(briefError ? { briefError } : {}),
      });
    } catch (e) {
      report.push({
        email: acct.email,
        error: e instanceof Error ? e.message.slice(0, 160) : "sync failed",
      });
    }
  }

  console.log("[seer] cron sync:", JSON.stringify(report));
  return NextResponse.json({ ok: true, ms: Date.now() - started, report });
}
