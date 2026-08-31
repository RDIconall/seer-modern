/**
 * Per-mailbox working style: how this person clears mail, what they mark as
 * important, and how readily a thread should become an Atlas matter.
 *
 * Inference is a hypothesis. Confirmed style is law for Focus vs provider
 * Inbox. Training events can ask to revisit; they never silently overwrite.
 */

export type ClearHabit = "archive" | "delete" | "leave";
export type ImportanceCue = "flag" | "unread" | "star" | "none";
export type MatterBar = "high" | "medium" | "low";
export type IrrelevanceReason =
  | "taken_care_of"
  | "ended"
  | "never_was"
  | "not_for_me";

export type MailboxSnapshot = {
  providerInboxTotal: number;
  storedInbox: number;
  unreadInbox: number;
  starredOrFlagged: number;
  trashCount: number;
  sentCount: number;
  recentUserArchives: number;
  recentUserDeletes: number;
  openMatters: number;
};

export type StyleInference = {
  clearHabit: ClearHabit;
  importanceCues: ImportanceCue[];
  matterBar: MatterBar;
  confidence: number;
  reasons: string[];
};

export type MailboxStyleFields = {
  clearHabit: ClearHabit;
  importanceCues: ImportanceCue[];
  matterBar: MatterBar;
};

export type RelevanceOutcome = {
  home: "matter" | "record" | "delete";
  /** Provider mutation; null means stay in the Inbox folder. */
  provider: "archive" | "trash" | null;
  focusHidden: boolean;
  closeMatter: boolean;
};

const CLEAR_HABITS: ClearHabit[] = ["archive", "delete", "leave"];
const CUES: ImportanceCue[] = ["flag", "unread", "star", "none"];
const BARS: MatterBar[] = ["high", "medium", "low"];
const REASONS: IrrelevanceReason[] = [
  "taken_care_of",
  "ended",
  "never_was",
  "not_for_me",
];

export function isClearHabit(value: string): value is ClearHabit {
  return (CLEAR_HABITS as string[]).includes(value);
}

export function isMatterBar(value: string): value is MatterBar {
  return (BARS as string[]).includes(value);
}

export function isIrrelevanceReason(value: string): value is IrrelevanceReason {
  return (REASONS as string[]).includes(value);
}

export function normalizeCues(raw: string[]): ImportanceCue[] {
  const next = raw.filter((cue): cue is ImportanceCue =>
    (CUES as string[]).includes(cue),
  );
  const withoutNone = next.filter((cue) => cue !== "none");
  if (withoutNone.length > 0) return [...new Set(withoutNone)];
  return ["none"];
}

export function inferStyle(snapshot: MailboxSnapshot): StyleInference {
  const inbox = Math.max(snapshot.providerInboxTotal, snapshot.storedInbox);
  const reasons: string[] = [];
  let clearHabit: ClearHabit = "archive";
  let confidence = 0.45;

  const clears = snapshot.recentUserArchives + snapshot.recentUserDeletes;
  if (inbox >= 2000) {
    clearHabit = "leave";
    confidence = Math.min(0.92, 0.58 + Math.log10(Math.max(inbox, 10)) / 12);
    reasons.push(
      `Inbox holds about ${inbox.toLocaleString()} conversations, so mail is kept there rather than archived.`,
    );
  } else if (
    snapshot.recentUserDeletes >= 8 &&
    snapshot.recentUserDeletes > snapshot.recentUserArchives * 2
  ) {
    clearHabit = "delete";
    confidence = 0.72;
    reasons.push("You delete more than you archive when clearing.");
  } else if (inbox <= 400 && clears >= 3) {
    clearHabit = "archive";
    confidence = 0.78;
    reasons.push("Inbox stays small because you clear mail.");
  } else if (inbox <= 400) {
    clearHabit = "archive";
    confidence = 0.52;
    reasons.push(
      "Inbox is small; treating cleared mail as archive unless you say otherwise.",
    );
  } else if (clears < 5) {
    clearHabit = "leave";
    confidence = 0.56;
    reasons.push(
      "A large live Inbox with little clearing looks like leave-in-place.",
    );
  }

  const cues: ImportanceCue[] = [];
  const unreadRatio =
    snapshot.storedInbox > 0 ? snapshot.unreadInbox / snapshot.storedInbox : 0;
  if (snapshot.starredOrFlagged >= 5) {
    cues.push("flag");
    reasons.push("Several threads are flagged or starred.");
  }
  if (unreadRatio >= 0.25 && snapshot.unreadInbox >= 10) {
    cues.push("unread");
    reasons.push("Unread volume looks like a keep-for-later mark.");
  }
  const importanceCues = normalizeCues(cues);

  let matterBar: MatterBar = "medium";
  if (inbox >= 2000 && snapshot.openMatters < 20) {
    matterBar = "high";
    reasons.push(
      "Few live matters against a large Inbox — only real work should land on Atlas.",
    );
  } else if (
    snapshot.openMatters > 40 ||
    (inbox > 0 && snapshot.openMatters / inbox > 0.08)
  ) {
    matterBar = "low";
    reasons.push("Many threads are already live work.");
  }

  return { clearHabit, importanceCues, matterBar, confidence, reasons };
}

export function relevanceOutcome(
  style: MailboxStyleFields,
  relevant: boolean,
  reason?: IrrelevanceReason | null,
): RelevanceOutcome {
  if (relevant) {
    return {
      home: "matter",
      provider: null,
      focusHidden: false,
      closeMatter: false,
    };
  }
  const why = reason ?? "never_was";
  if (why === "never_was") {
    if (style.clearHabit === "leave") {
      return {
        home: "delete",
        provider: null,
        focusHidden: true,
        closeMatter: false,
      };
    }
    if (style.clearHabit === "delete") {
      return {
        home: "delete",
        provider: "trash",
        focusHidden: true,
        closeMatter: false,
      };
    }
    return {
      home: "delete",
      provider: "archive",
      focusHidden: true,
      closeMatter: false,
    };
  }
  const archiveAway = style.clearHabit !== "leave";
  return {
    home: "record",
    provider: archiveAway ? "archive" : null,
    focusHidden: true,
    closeMatter: why === "ended",
  };
}

export type DriftSignal = {
  kind: "relevance" | "triage";
  clearToward?: ClearHabit;
  matterToward?: "promote" | "demote";
};

/**
 * Last N events vs confirmed style. Returns a prompt or null. Never mutates.
 */
export function detectDrift(
  style: MailboxStyleFields & { confirmed: boolean },
  events: DriftSignal[],
): string | null {
  if (!style.confirmed || events.length < 8) return null;
  const recent = events.slice(0, 12);
  const leaveVotes = recent.filter((e) => e.clearToward === "leave").length;
  const clearVotes = recent.filter(
    (e) => e.clearToward === "archive" || e.clearToward === "delete",
  ).length;
  if (style.clearHabit === "leave" && clearVotes / recent.length >= 0.7) {
    return "You have been archiving or deleting a lot of mail we were leaving in Inbox. Switch to clearing the real Inbox?";
  }
  if (style.clearHabit !== "leave" && leaveVotes / recent.length >= 0.7) {
    return "You have been leaving mail in Inbox that we offered to clear. Keep everything in the folder and only hide it from Focus?";
  }
  const demote = recent.filter((e) => e.matterToward === "demote").length;
  const promote = recent.filter((e) => e.matterToward === "promote").length;
  if (style.matterBar === "low" && demote / recent.length >= 0.7) {
    return "You have been saying threads are not live work. Raise the bar for Atlas matters?";
  }
  if (style.matterBar === "high" && promote / recent.length >= 0.7) {
    return "You have been keeping more threads as live work. Make Atlas less strict?";
  }
  return null;
}

export function styleGuidance(style: MailboxStyleFields): string {
  const cues =
    style.importanceCues.includes("none") || style.importanceCues.length === 0
      ? "they do not mark importance in the provider"
      : `they mark importance with ${style.importanceCues.join(", ")}`;
  const clear =
    style.clearHabit === "leave"
      ? "they leave mail in the Inbox folder; clearing hides it from Focus only"
      : style.clearHabit === "delete"
        ? "they delete mail they are done with"
        : "they archive mail they are done with";
  const bar =
    style.matterBar === "high"
      ? "only real ongoing work is an Atlas matter"
      : style.matterBar === "low"
        ? "many threads may stay live matters"
        : "typical: open work is a matter, noise is not";
  return `${clear}; ${cues}; ${bar}.`;
}

export function driftSignalForRelevance(
  relevant: boolean,
  reason: IrrelevanceReason | null,
  provider: "archive" | "trash" | null,
): DriftSignal {
  return {
    kind: "relevance",
    clearToward: provider ? (provider === "trash" ? "delete" : "archive") : "leave",
    matterToward: relevant ? "promote" : "demote",
  };
}
