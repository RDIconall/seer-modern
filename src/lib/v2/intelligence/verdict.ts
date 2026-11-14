import type { Home, Owner } from "../db/types";
import { formatUsd } from "./amounts";

/**
 * The grounded "does this need you, why, what to do" verdict. Computed from
 * facts after the chief-of-staff read — never a second model call, never a
 * replacement for the safety veto.
 */

export type Care =
  | "needs_you"
  | "waiting"
  | "record"
  | "ignore"
  | "review_charge";

export type VerdictEvidence = {
  kind:
    | "relationship"
    | "calendar"
    | "amount"
    | "matter"
    | "behavior"
    | "replied"
    | "profile"
    | "crm";
  ref: string;
  detail: string;
};

export type GroundedVerdict = {
  care: Care;
  why: string;
  what: string;
  who: string;
  harm: string;
  ask: string;
  task: string;
  importance: number;
  evidence: VerdictEvidence[];
  replied: boolean;
  urgencyExpired: boolean;
  anomalousAmount: boolean;
  amount: number | null;
  usualAmount: number | null;
};

export type MeetingLite = {
  subject: string;
  startsAt: string;
};

export type VerdictInput = {
  home: Home;
  owner: Owner;
  ask?: string;
  summary: string;
  obligation: boolean;
  dueDate: string | null;
  senderName?: string;
  senderEmail: string;
  senderTier: string;
  senderVip: boolean;
  inContacts: boolean;
  writtenTo: boolean;
  meeting: MeetingLite | null;
  inviteAnswered: boolean;
  weSpokeLast: boolean;
  behavior: { archive: number; trash: number } | null;
  amount: number | null;
  usualAmount: number | null;
  usualLabel: string | null;
  anomalousAmount: boolean;
  candidateMatterTitle: string | null;
  freeSlot: string | null;
  now?: Date;
};

const OPEN_ASK = (ask: string | undefined) =>
  Boolean(ask && !/^\s*nothing/i.test(ask));

function formatDue(iso: string, now: Date): string {
  const due = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return iso;
  return due.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function meetingWhen(startsAt: string, now: Date): string {
  const at = new Date(startsAt);
  if (Number.isNaN(at.getTime())) return startsAt.slice(0, 10);
  const days = Math.round((at.getTime() - now.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return at.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function meetingLabel(
  meeting: MeetingLite | null,
  now = new Date(),
): string | null {
  if (!meeting) return null;
  return `${meeting.subject.slice(0, 50)} · ${meetingWhen(meeting.startsAt, now)}`;
}

function whoLine(input: VerdictInput, now: Date): string {
  const name = input.senderName?.trim() || input.senderEmail.split("@")[0] || "This sender";
  const meet = meetingLabel(input.meeting, now);
  if (meet) return `${name} is on your calendar — ${meet}.`;
  if (input.senderVip) return `${name} is a VIP — you pinned them.`;
  if (input.inContacts && input.writtenTo) {
    return `In your contacts; you've written ${name}.`;
  }
  if (input.inContacts) {
    return `In your contacts — someone you know, even if you haven't written lately.`;
  }
  if (input.writtenTo) {
    return `A real correspondent — you've emailed ${name}.`;
  }
  if (input.senderTier === "inner" || input.senderTier === "known") {
    return `${name} is someone you know (${input.senderTier}).`;
  }
  return "No history with you — a first-time or rare sender.";
}

function harmFor(care: Care, input: VerdictInput): string {
  switch (care) {
    case "needs_you":
      if (input.obligation) {
        return "A signature, payment, or approval is still outstanding.";
      }
      return "Deleting ghosts a real person — they're waiting on you.";
    case "waiting":
      return "Nothing is required of you until they answer.";
    case "review_charge":
      return "Deleting could cost money — check the charge first.";
    case "record":
      return "Don't delete — you may want the record later. Nothing needs you today.";
    case "ignore":
      return "None. If it truly mattered, they'd send it again.";
  }
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function duePhrase(input: VerdictInput, now: Date): string | null {
  if (!input.dueDate) return null;
  return `by ${formatDue(input.dueDate, now)}`;
}

/**
 * Compose the verdict. Deterministic: the same facts always produce the same
 * sentence. The model's ask/summary supply the particulars; calendar, amounts,
 * replied state, and relationship supply the grounding.
 */
export function composeVerdict(input: VerdictInput): GroundedVerdict {
  const now = input.now ?? new Date();
  const askOpen = OPEN_ASK(input.ask);
  const ask = askOpen ? clip(input.ask!, 160) : "nothing — informational";
  const due = duePhrase(input, now);
  const today = now.toISOString().slice(0, 10);
  const urgencyExpired = Boolean(
    input.dueDate &&
      input.dueDate < today &&
      !input.obligation &&
      !askOpen,
  );
  const evidence: VerdictEvidence[] = [];

  if (input.senderVip || input.senderTier === "inner" || input.senderTier === "known") {
    evidence.push({
      kind: "relationship",
      ref: `person:${input.senderEmail}`,
      detail: input.senderVip
        ? "VIP"
        : `${input.senderTier}${input.inContacts ? ", saved contact" : ""}`,
    });
  } else if (input.inContacts || input.writtenTo) {
    evidence.push({
      kind: "relationship",
      ref: `person:${input.senderEmail}`,
      detail: input.inContacts ? "saved contact" : "you have written to them",
    });
  }

  if (input.meeting) {
    evidence.push({
      kind: "calendar",
      ref: `calendar:${input.meeting.subject}`,
      detail: meetingLabel(input.meeting, now) ?? input.meeting.subject,
    });
  }
  if (input.candidateMatterTitle) {
    evidence.push({
      kind: "matter",
      ref: `matter:${input.candidateMatterTitle}`,
      detail: input.candidateMatterTitle,
    });
  }
  if (input.amount != null) {
    evidence.push({
      kind: "amount",
      ref: `amount:${input.amount}`,
      detail: input.usualLabel
        ? `${formatUsd(input.amount)} vs ${input.usualLabel}`
        : formatUsd(input.amount),
    });
  }
  if (input.weSpokeLast) {
    evidence.push({
      kind: "replied",
      ref: "thread:we-spoke-last",
      detail: "you wrote last; no reply yet",
    });
  }
  if (input.behavior && input.behavior.archive + input.behavior.trash > 0) {
    const total = input.behavior.archive + input.behavior.trash;
    const verb = input.behavior.trash >= input.behavior.archive ? "delete" : "archive";
    const n =
      input.behavior.trash >= input.behavior.archive
        ? input.behavior.trash
        : input.behavior.archive;
    evidence.push({
      kind: "behavior",
      ref: `behavior:${input.senderEmail}`,
      detail: `you ${verb} their mail (${n}/${total})`,
    });
  }

  let care: Care;
  if (input.inviteAnswered) {
    care = "ignore";
  } else if (input.anomalousAmount) {
    care = "review_charge";
  } else if (input.weSpokeLast && !input.obligation) {
    care = "waiting";
  } else if (urgencyExpired) {
    care = "ignore";
  } else if (input.owner === "you" || input.obligation || askOpen) {
    care = "needs_you";
  } else if (input.owner === "them") {
    care = "waiting";
  } else if (input.home === "delete") {
    care = "ignore";
  } else if (input.home === "record") {
    care = "record";
  } else if (input.home === "matter") {
    care = input.owner === "nobody" ? "record" : "needs_you";
  } else {
    care = "record";
  }

  let why: string;
  let what: string;
  if (care === "review_charge" && input.amount != null) {
    why = input.usualLabel
      ? `${formatUsd(input.amount)} from ${input.senderName || "this biller"} — ${input.usualLabel}`
      : `${formatUsd(input.amount)} looks off the usual charge`;
    what = `Check the ${formatUsd(input.amount)} charge`;
  } else if (care === "waiting" && input.weSpokeLast) {
    why = "You already replied — ball is with them";
    what = "Ignore until they answer";
  } else if (care === "ignore" && input.inviteAnswered) {
    why = "RSVP already on your calendar";
    what = "Ignore — nothing changed";
  } else if (care === "ignore" && urgencyExpired) {
    why = "The window closed; nothing still needs you";
    what = "Ignore — nothing changed";
  } else if (care === "ignore") {
    why = "Nothing here needs you";
    what = "Ignore — nothing changed";
  } else if (care === "record") {
    why = clip(input.summary, 120) || "Worth keeping, nothing to do";
    what = "File it";
  } else {
    // needs_you — prefer a concrete deed with its particulars
    if (input.amount != null && due) {
      why = input.usualLabel
        ? `Pay ${due}, ${input.usualLabel}`
        : `Pay ${formatUsd(input.amount)} ${due}`;
      what = `Pay ${formatUsd(input.amount)} ${due}`;
    } else if (input.freeSlot && /time|schedul|availab|meet|call|cap\b/i.test(`${ask} ${input.summary}`)) {
      const who = input.senderName?.split(/\s+/)[0] || "They";
      why = `${who} needs a time, you're free ${input.freeSlot}`;
      what = `Offer ${input.freeSlot}`;
    } else if (askOpen && due) {
      why = `${clip(ask, 80)} ${due}`;
      what = clip(ask, 80);
    } else if (askOpen) {
      why = clip(ask, 120);
      what = clip(ask, 80);
    } else if (input.obligation) {
      why = clip(input.summary, 120) || "A step is still outstanding";
      what = "Handle the outstanding step";
    } else {
      why = clip(input.summary, 120) || "This needs you";
      what = "Reply — they're waiting";
    }
  }

  if (input.meeting && (care === "needs_you" || care === "waiting")) {
    const meet = meetingLabel(input.meeting, now);
    if (meet && !why.toLowerCase().includes(meet.split(" · ")[0].toLowerCase().slice(0, 12))) {
      why = `${why} (${meet})`;
    }
  }

  let importance = 0;
  if (care === "needs_you") importance += 2;
  if (care === "review_charge") importance += 2;
  if (input.obligation) importance += 1;
  if (input.senderVip || input.senderTier === "inner") importance += 1;
  if (care === "waiting" || care === "record") importance = Math.max(importance, 1);
  if (care === "ignore") importance = 0;
  importance = Math.min(3, importance);

  return {
    care,
    why: clip(why, 160),
    what: clip(what, 80),
    who: whoLine(input, now),
    harm: harmFor(care, input),
    ask,
    task: clip(what, 80),
    importance,
    evidence,
    replied: input.weSpokeLast,
    urgencyExpired,
    anomalousAmount: input.anomalousAmount,
    amount: input.amount,
    usualAmount: input.usualAmount,
  };
}

export function verdictToJson(verdict: GroundedVerdict): Record<string, unknown> {
  return {
    evidence: verdict.evidence,
    replied: verdict.replied,
    urgencyExpired: verdict.urgencyExpired,
    anomalousAmount: verdict.anomalousAmount,
    amount: verdict.amount,
    usualAmount: verdict.usualAmount,
    ask: verdict.ask,
    task: verdict.task,
  };
}

export function verdictFromRow(row: {
  care: Care | null;
  why: string | null;
  what_to_do: string | null;
  who: string | null;
  harm: string | null;
  importance: number | null;
  ask: string | null;
  verdict: unknown;
}): GroundedVerdict | null {
  if (!row.care || !row.why) return null;
  const extra =
    row.verdict && typeof row.verdict === "object"
      ? (row.verdict as Record<string, unknown>)
      : {};
  return {
    care: row.care,
    why: row.why,
    what: row.what_to_do ?? "",
    who: row.who ?? "",
    harm: row.harm ?? "",
    ask: (typeof extra.ask === "string" ? extra.ask : null) ?? row.ask ?? "",
    task: typeof extra.task === "string" ? extra.task : row.what_to_do ?? "",
    importance: row.importance ?? 0,
    evidence: Array.isArray(extra.evidence)
      ? (extra.evidence as VerdictEvidence[])
      : [],
    replied: Boolean(extra.replied),
    urgencyExpired: Boolean(extra.urgencyExpired),
    anomalousAmount: Boolean(extra.anomalousAmount),
    amount: typeof extra.amount === "number" ? extra.amount : null,
    usualAmount: typeof extra.usualAmount === "number" ? extra.usualAmount : null,
  };
}
