import specJson from "./rules.v1.json";
import type {
  ClassifyContext,
  ClassifyMessage,
  ClassifyResult,
  CompiledRules,
  KeepException,
  RulesSpec,
  SubjectRule,
  AutoTriageAction,
} from "./types";

const SPEC = specJson as RulesSpec;

export function domainOf(addr: string): string {
  const host = (addr.split("@").pop() ?? "").toLowerCase();
  const parts = host.split(".").filter(Boolean);
  if (
    parts.length > 2 &&
    (parts[parts.length - 2] === "co" || parts[parts.length - 2] === "com") &&
    parts[parts.length - 1].length === 2
  ) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

export function isAutomated(addr: string, automatedLocal: RegExp): boolean {
  const local = (addr.split("@")[0] ?? "").toLowerCase();
  return automatedLocal.test(local) || local.length > 40 || local.includes("=");
}

export function normalizeAction(act: string | null | undefined): AutoTriageAction {
  const a = (act ?? "").toLowerCase();
  if (a.startsWith("delete")) return "delete";
  if (a.startsWith("archive") || a === "filtered") return "archive";
  if (a.startsWith("keep") || a.startsWith("inbox")) return "keep";
  if (a.startsWith("review")) return "review";
  if (a.startsWith("save")) return "save-doc";
  if (a.startsWith("unknown")) return "unknown";
  return "unknown";
}

function compileRegex(source: string, extraFlags = ""): RegExp {
  let pattern = source;
  let flags = extraFlags;
  if (pattern.startsWith("(?i)")) {
    pattern = pattern.slice(4);
    if (!flags.includes("i")) flags += "i";
  }
  return new RegExp(pattern, flags);
}

export function compileRules(spec: RulesSpec, extraAlwaysKeep: string[] = []): CompiledRules {
  const neverFile = spec.never_file_by_domain ?? spec.freemail_domains ?? [];
  const alwaysKeep = new Set(
    [...spec.always_keep, ...extraAlwaysKeep].map((x) => x.toLowerCase()),
  );
  const allowlistDomains = new Set(spec.allowlist_domains.map((d) => d.toLowerCase()));
  const freemail = new Set(neverFile.map((d) => d.toLowerCase()));
  const repliedDomains = new Set(
    spec.replied_to_domains
      .map((d) => d.toLowerCase())
      .filter((d) => !freemail.has(d)),
  );
  const addressRules: Record<string, string> = {};
  for (const [addr, action] of Object.entries(spec.address_rules)) {
    addressRules[addr.toLowerCase()] = action;
  }
  const domainRules: Record<string, string> = {};
  for (const [domain, action] of Object.entries(spec.domain_rules)) {
    domainRules[domain.toLowerCase()] = action;
  }
  return {
    spec,
    alwaysKeep,
    allowlistDomains,
    repliedDomains,
    freemail,
    addressRules,
    domainRules,
    automatedLocal: compileRegex(spec.automated_local_part_regex, "i"),
    actionableSubject: compileRegex(spec.actionable_subject_regex),
    actionableDomains: new Set(spec.actionable_domains.map((d) => d.toLowerCase())),
    promoGuard: compileRegex(spec.promo_guard),
    signedDoc: compileRegex(spec.signed_doc_regex),
    esignDomains: new Set(spec.esign_domains.map((d) => d.toLowerCase())),
    receiptGuard: compileRegex(spec.receipt_guard_regex),
    subjectRules: spec.subject_rules.map((rule: SubjectRule) => ({
      rx: compileRegex(rule.match),
      rule,
    })),
    keepExceptions: spec.keep_in_inbox_exceptions.map((row: KeepException) => ({
      domain: row.domain.toLowerCase(),
      keys: row.subject_contains_any.map((k) => k.toLowerCase()),
    })),
  };
}

export function loadBundledRules(extraAlwaysKeep: string[] = []): CompiledRules {
  return compileRules(SPEC, extraAlwaysKeep);
}

export function withAlwaysKeep(
  rules: CompiledRules,
  extraAlwaysKeep: string[],
): CompiledRules {
  if (extraAlwaysKeep.length === 0) return rules;
  const alwaysKeep = new Set(rules.alwaysKeep);
  for (const addr of extraAlwaysKeep) alwaysKeep.add(addr.toLowerCase());
  return { ...rules, alwaysKeep };
}

const CALENDAR_PREFIX = /^(accepted|declined|tentative|canceled|cancelled)/i;

export function classify(
  msg: ClassifyMessage,
  ctx: ClassifyContext,
  rules: CompiledRules,
  opts?: { now?: Date },
): ClassifyResult {
  const addr = (msg.addr || "").toLowerCase();
  const domain = domainOf(addr);
  const subject = msg.subject || "";
  const subjectLower = subject.toLowerCase();
  const auto = isAutomated(addr, rules.automatedLocal);
  const corresponded =
    (ctx.correspondents.has(addr) && !auto) ||
    Boolean(msg.conversationId && ctx.repliedConversations.has(msg.conversationId));
  const humanAllow =
    !auto &&
    (rules.allowlistDomains.has(domain) || rules.repliedDomains.has(domain));

  const finish = (action: AutoTriageAction, rule: string, reason: string): ClassifyResult => {
    let next = action;
    let nextReason = reason;
    if (next === "delete" && rules.receiptGuard.test(subject)) {
      next = "archive";
      nextReason += " [receipt/money guard: archive, never delete]";
    }
    let prot: string | null = null;
    if (next === "delete" || next === "archive") {
      if (corresponded) prot = "corresponded";
      else if (humanAllow) prot = "human_at_allowlisted_domain";
      else if (rules.freemail.has(domain) && !auto) prot = "freemail_human";
    }
    if (prot) {
      return {
        action: "review",
        proposed: next,
        rule,
        reason: `${nextReason} [protected: ${prot}; sent to Seer instead]`,
        protected: prot,
        corresponded,
      };
    }
    return {
      action: next,
      proposed: next,
      rule,
      reason: nextReason,
      protected: null,
      corresponded,
    };
  };

  if (rules.alwaysKeep.has(addr)) {
    return finish("keep", "P0:always_keep", "sender on always-keep list");
  }
  if (msg.flagged) {
    return finish("keep", "P0:flagged", "message is flagged");
  }
  if ((msg.categories ?? []).some((c) => (c || "").toLowerCase().includes("respond"))) {
    return finish("keep", "P0:respond_category", "Superhuman Respond category");
  }
  const override = ctx.senderOverrides?.[addr];
  if (override === "delete" || override === "archive") {
    return finish(override, `P0:sender_rule:${override}`, `learned sender rule (${override})`);
  }

  for (const exception of rules.keepExceptions) {
    if (domain === exception.domain && exception.keys.some((k) => subjectLower.includes(k))) {
      return finish(
        "keep",
        `1:keep_exception:${exception.domain}`,
        "actionable automated mail (keep exception)",
      );
    }
  }

  const actionableHit =
    rules.actionableDomains.has(domain) ||
    (rules.actionableSubject.test(subject) &&
      !rules.signedDoc.test(subject) &&
      !CALENDAR_PREFIX.test(subject));
  if (actionableHit && !rules.promoGuard.test(subject)) {
    return finish(
      "keep",
      "1:actionable",
      "actionable automated mail (signature/renewal/deadline/security/DMV/RFQ)",
    );
  }

  if (rules.esignDomains.has(domain) && rules.signedDoc.test(subject)) {
    return finish(
      "save-doc",
      "2:signed_doc",
      "signed agreement: leave in Inbox, save PDF to Drive first",
    );
  }

  const addressAction = rules.addressRules[addr];
  if (addressAction) {
    return finish(
      normalizeAction(addressAction),
      `3:address:${addr}`,
      `address rule (${addressAction})`,
    );
  }

  const now = opts?.now ?? new Date();
  for (const { rx, rule } of rules.subjectRules) {
    if (rule.sender && rule.sender.toLowerCase() !== addr) continue;
    if (
      rule.scope === "non-allowlisted senders" &&
      (rules.allowlistDomains.has(domain) || rules.repliedDomains.has(domain))
    ) {
      continue;
    }
    if (typeof rule.defer_hours === "number" && rule.defer_hours > 0) {
      const received = msg.receivedAt ? Date.parse(msg.receivedAt) : Number.NaN;
      if (!Number.isFinite(received)) continue;
      const ageHours = (now.getTime() - received) / 3_600_000;
      if (ageHours < rule.defer_hours) continue;
    }
    if (rx.test(subject)) {
      return finish(
        normalizeAction(rule.action),
        `4:subject:${rule.match}`,
        rule.why || `subject rule (${rule.action})`,
      );
    }
  }

  const domainAction = rules.domainRules[domain];
  if (domainAction) {
    return finish(
      normalizeAction(domainAction),
      `5:domain:${domain}`,
      `domain rule (${domainAction})`,
    );
  }

  if (rules.allowlistDomains.has(domain) || rules.repliedDomains.has(domain)) {
    return finish("keep", "6:allowlisted_domain", "allowlisted / replied-to domain");
  }
  if (corresponded) {
    return finish("keep", "6:corresponded", "he has corresponded with this sender");
  }
  return finish("unknown", "7:unmatched", "new/unmatched sender: AI reviewer decides");
}
