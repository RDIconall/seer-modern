import type { ClassifyDebug, TriageAction } from "@/lib/inbox/classify";

/**
 * Answers the two questions every email should answer instantly:
 *   1. Who is this sender/company to ME?
 *   2. What's the harm in deleting it — or when do I actually need it?
 * Built locally from history/contacts/calendar/action-memory signals —
 * zero API cost, available on every decision path (rules, cache, label).
 */

export type SenderStory = {
  who: string;
  harm: string;
};

function domainHint(ruleId: string): string | null {
  if (/product-notify/.test(ruleId)) {
    return "a product/service notification account";
  }
  if (/finance|receipt|subscription/.test(ruleId)) {
    return "a bank/payments/billing sender";
  }
  if (/shopping|promo|marketing|urgency-bait/.test(ruleId)) {
    return "a store's marketing list";
  }
  if (/sales-cold/.test(ruleId)) return "a cold sales pitch";
  return null;
}

export function senderStory(
  action: TriageAction,
  debug: ClassifyDebug | undefined,
  fromName?: string,
): SenderStory {
  const name = fromName?.trim() || "This sender";
  const d = debug;

  // ---- Who is this to me? ----
  let who: string;
  if (d?.meeting) {
    who = `${name} is on your calendar — ${d.meeting}.`;
  } else if (d?.inContacts) {
    who =
      d.sentTo > 0
        ? `In your contacts; you've written them ${d.sentTo}× recently.`
        : "In your contacts — someone you know, even if you haven't written lately.";
  } else if (d?.relationship === "engaged") {
    who = d.staleEngagement
      ? `You've emailed them ${d.sentTo}×, but not in the last month.`
      : `A real correspondent — you've emailed them ${d.sentTo}× recently.`;
  } else if (d?.relationship === "known") {
    who = `They write you often (${d.receivedFrom} recent) but you've never replied.`;
  } else if (d?.relationship === "bulk") {
    who = "A machine, not a person — an automated sender you've never written.";
  } else {
    who = "No history with you — a first-time or rare sender.";
  }

  const hint = d ? domainHint(d.ruleId) : null;
  if (hint && d?.relationship !== "engaged" && !d?.inContacts) {
    who = `${who} Looks like ${hint}.`;
  }
  if (d?.ruleId.startsWith("learned")) {
    who = `${who} Seer learned your habit with this sender.`;
  }

  // ---- Harm in deleting / when do you need it? ----
  let harm: string;
  switch (action) {
    case "respond":
      harm = "Deleting ghosts a real person — they're waiting on you.";
      break;
    case "act_today":
      harm =
        "It has a clock on it: valuable today, worthless next week. See it now.";
      break;
    case "read_and_archive":
      harm =
        "Don't delete — you may want the record later (receipts, confirmations, search). But nothing needs you today.";
      break;
    case "review_subscription":
      harm =
        "Deleting could cost money — check the charge or price change first.";
      break;
    case "read_and_delete":
      harm =
        "Almost none — skim once in case it's personal, then nothing here is load-bearing.";
      break;
    case "delete_now":
      harm =
        "None. If it truly mattered, they'd send it again — bulk mail always does.";
      break;
    case "unsubscribe":
      harm =
        "None — but deleting alone won't stop the next one. Unsubscribe first.";
      break;
    case "glance_promo":
      harm =
        "Only a missed deal. The subject line is all the value — you never need the body.";
      break;
    case "needs_review":
    default:
      harm =
        "Unknown — that's exactly why it's flagged. Could be a person or money; look once.";
      break;
  }

  if (d?.meeting && (action === "read_and_archive" || action === "respond")) {
    harm = `You'll want this before your meeting (${d.meeting}). ${harm}`;
  }

  return { who, harm };
}
