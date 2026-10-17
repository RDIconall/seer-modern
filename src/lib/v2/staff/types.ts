import type { AccountId } from "../db/types";

export const BOT_TASK_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "waiting_on_user",
  "done",
  "dropped",
] as const;

export type BotTaskStatus = (typeof BOT_TASK_STATUSES)[number];

export const TRIAGE_ACTIONS = [
  "delete",
  "archive",
  "keep",
  "file",
  "filtered",
] as const;

export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

export const TRIAGE_PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "executed",
  "failed",
] as const;

export type TriageProposalStatus = (typeof TRIAGE_PROPOSAL_STATUSES)[number];

export type StaffActor = "user" | "bot";

export type StaffBot = {
  id: string;
  slug: string;
  displayName: string;
};

export type StaffEvent = {
  id: string;
  taskId: string;
  actor: StaffActor;
  actorName: string;
  kind: string;
  body: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type StaffMessage = {
  id: string;
  botId: string;
  botSlug: string;
  botName: string;
  taskId: string | null;
  author: StaffActor;
  body: string;
  createdAt: string;
};

export type StaffTask = {
  id: string;
  accountId: AccountId;
  botId: string;
  botSlug: string;
  botName: string;
  externalKey: string | null;
  title: string;
  status: BotTaskStatus;
  priority: number;
  dueAt: string | null;
  notes: string | null;
  hisWords: string | null;
  currentState: string | null;
  nextAction: string | null;
  source: StaffActor;
  createdAt: string;
  updatedAt: string;
  events: StaffEvent[];
};

export type StaffProposal = {
  id: string;
  botId: string;
  botSlug: string;
  botName: string;
  conversationId: string | null;
  providerConversationId: string | null;
  senderEmail: string | null;
  subject: string | null;
  action: TriageAction;
  destinationId: string | null;
  destinationName: string | null;
  rationale: string | null;
  status: TriageProposalStatus;
  lastError: string | null;
  outboxId: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export type StaffView = {
  asOf: string;
  bots: StaffBot[];
  tasks: StaffTask[];
  proposals: StaffProposal[];
  generalMessages: StaffMessage[];
  taskMessages: StaffMessage[];
};

export const STATUS_LABEL: Record<BotTaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  waiting_on_user: "Waiting on Conall",
  done: "Done",
  dropped: "Dropped",
};

export const ACTION_LABEL: Record<TriageAction, string> = {
  delete: "Trash",
  archive: "Archive",
  keep: "Keep",
  file: "File",
  filtered: "Filter",
};

export function isBotTaskStatus(value: string): value is BotTaskStatus {
  return (BOT_TASK_STATUSES as readonly string[]).includes(value);
}

export function isTriageAction(value: string): value is TriageAction {
  return (TRIAGE_ACTIONS as readonly string[]).includes(value);
}

export const DEFAULT_BOT_SLUG = "chief-of-staff";
