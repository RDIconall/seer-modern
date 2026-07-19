import type { ClassifyDebug, TriageAction } from "@/lib/inbox/classify";

/** Snippet-level export for offline classifier tuning — no HTML bodies. */
export type ClassifierSample = {
  id: string;
  fromEmail: string;
  fromDomain: string;
  fromName: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
  predicted: {
    action: TriageAction;
    confidence: string;
    reason: string;
    ruleId: string;
  };
  debug: ClassifyDebug;
  /** Fill in after export to train/eval expected action */
  expectedAction?: TriageAction | null;
};

export type ClassifierExport = {
  version: 1;
  exportedAt: string;
  accountEmail: string;
  provider: string;
  note: string;
  history: {
    builtAt: string;
    contactCount: number;
    engagedCount: number;
  };
  taughtSenders: { email: string; action: TriageAction }[];
  samples: ClassifierSample[];
};

export function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}
