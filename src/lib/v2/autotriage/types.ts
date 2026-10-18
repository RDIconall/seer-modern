export type AutoTriageAction =
  | "delete"
  | "archive"
  | "keep"
  | "review"
  | "save-doc"
  | "unknown";

export type AutoTriageMode = "off" | "dry_run" | "live";

export type AutoTriageDecider = "rule" | "ai" | "user";

export type ClassifyMessage = {
  addr: string;
  subject: string;
  conversationId?: string | null;
  flagged?: boolean;
  categories?: string[];
  receivedAt?: string | null;
  preview?: string | null;
};

export type ClassifyContext = {
  correspondents: ReadonlySet<string>;
  repliedConversations: ReadonlySet<string>;
  senderOverrides?: Readonly<Record<string, "delete" | "archive">>;
};

export type ClassifyResult = {
  action: AutoTriageAction;
  proposed: AutoTriageAction;
  rule: string;
  reason: string;
  protected: string | null;
  corresponded: boolean;
};

export type SubjectRule = {
  match: string;
  action: string;
  why?: string;
  sender?: string;
  scope?: string;
  defer_hours?: number;
};

export type KeepException = {
  domain: string;
  subject_contains_any: string[];
  action?: string;
};

export type RulesSpec = {
  spec_version: number;
  always_keep: string[];
  allowlist_domains: string[];
  replied_to_domains: string[];
  freemail_domains?: string[];
  never_file_by_domain?: string[];
  keep_in_inbox_exceptions: KeepException[];
  address_rules: Record<string, string>;
  subject_rules: SubjectRule[];
  domain_rules: Record<string, string>;
  automated_local_part_regex: string;
  actionable_subject_regex: string;
  actionable_domains: string[];
  promo_guard: string;
  signed_doc_regex: string;
  esign_domains: string[];
  receipt_guard_regex: string;
};

export type CompiledRules = {
  spec: RulesSpec;
  alwaysKeep: Set<string>;
  allowlistDomains: Set<string>;
  repliedDomains: Set<string>;
  freemail: Set<string>;
  addressRules: Record<string, string>;
  domainRules: Record<string, string>;
  automatedLocal: RegExp;
  actionableSubject: RegExp;
  actionableDomains: Set<string>;
  promoGuard: RegExp;
  signedDoc: RegExp;
  esignDomains: Set<string>;
  receiptGuard: RegExp;
  subjectRules: Array<{ rx: RegExp; rule: SubjectRule }>;
  keepExceptions: Array<{ domain: string; keys: string[] }>;
};

export type AiCategory =
  | "newsletter"
  | "marketing"
  | "cold_sales"
  | "webinar"
  | "app_notification"
  | "verification_code"
  | "receipt"
  | "calendar"
  | "human"
  | "actionable"
  | "other";

export type AiTriageResult = {
  category: AiCategory;
  confidence: number;
  reason: string;
};

export type AutoTriageAiCaller = (input: {
  sender: string;
  subject: string;
  snippet?: string | null;
}) => Promise<AiTriageResult | null>;

export type AutoTriageLogRow = {
  id: string;
  accountId: string;
  conversationId: string | null;
  providerMessageId: string;
  senderEmail: string | null;
  subject: string | null;
  action: AutoTriageAction;
  proposed: string | null;
  rule: string | null;
  reason: string | null;
  decider: AutoTriageDecider;
  aiConfidence: number | null;
  mode: AutoTriageMode;
  outboxId: string | null;
  proposalId: string | null;
  undoneAt: string | null;
  undoOutboxId: string | null;
  createdAt: string;
};

export type AutoTriageAuditGroup = {
  sender: string;
  count: number;
  deleteCount: number;
  archiveCount: number;
  keepCount: number;
  reviewCount: number;
  subjects: string[];
  rule: string | null;
  decider: AutoTriageDecider | "mixed";
  latestLogId: string;
  undone: boolean;
};

export type AutoTriageSettings = {
  accountId: string;
  mode: AutoTriageMode;
  aiEnabled: boolean;
  aiAutoThreshold: number;
  updatedAt: string;
};
