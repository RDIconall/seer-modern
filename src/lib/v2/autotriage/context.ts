import type { AccountId } from "../db/types";
import {
  loadAlwaysKeepSenders,
  loadCorrespondents,
  loadOpenThreadIds,
  loadRepliedConversations,
  loadSenderOverrides,
} from "./repository";
import { loadBundledRules, withAlwaysKeep } from "./rules";
import type { ClassifyContext, CompiledRules } from "./types";

export type AutoTriageContext = ClassifyContext & {
  rules: CompiledRules;
  openThreads: ReadonlySet<string>;
  senderOverrides: Record<string, "delete" | "archive">;
};

export async function loadAutoTriageContext(
  accountId: AccountId,
): Promise<AutoTriageContext> {
  const [correspondents, repliedConversations, openThreads, alwaysKeep, senderOverrides] =
    await Promise.all([
      loadCorrespondents(accountId),
      loadRepliedConversations(accountId),
      loadOpenThreadIds(accountId),
      loadAlwaysKeepSenders(accountId),
      loadSenderOverrides(accountId),
    ]);
  return {
    correspondents,
    repliedConversations,
    openThreads,
    senderOverrides,
    rules: withAlwaysKeep(loadBundledRules(), alwaysKeep),
  };
}
