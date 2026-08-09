export type InboxAccounting = {
  asOf: string;
  total: number;
  mapped: number;
  mappedByCategory: { category: string; count: number }[];
  triage: number;
  pending: number;
};

type MatterLike = {
  id: string;
  orgUnit: string;
  emailIds: string[];
};

type FiledLike = {
  emailId: string;
  threadId: string;
  orgUnit: string;
  messageIds?: string[];
};

function categoryRoot(orgUnit: string, functions: string[]): string {
  const lower = orgUnit.toLowerCase();
  let best = "";
  for (const f of functions) {
    const fl = f.toLowerCase();
    if ((lower === fl || lower.startsWith(`${fl} —`)) && fl.length > best.length) {
      best = f;
    }
  }
  return best || orgUnit;
}

/**
 * One accounting invariant shared by Atlas and Triage:
 *
 *   provider inbox = mapped to matters + in Triage + provider shortfall
 *
 * IDs are deduped defensively. If bad upstream data puts one message in two
 * matters, it is assigned to the first matter's category and counted once.
 * Any Triage ID already mapped to a matter is excluded from Triage.
 */
export function buildInboxAccounting(input: {
  asOf: string;
  providerTotal: number;
  functions: string[];
  matters: MatterLike[];
  pinned: MatterLike[];
  filed: FiledLike[];
  digestIds: string[];
}): InboxAccounting {
  const mappedIds = new Set<string>();
  const counts = new Map<string, number>();
  for (const matter of [...input.pinned, ...input.matters]) {
    const category = categoryRoot(matter.orgUnit, input.functions);
    for (const id of matter.emailIds) {
      if (mappedIds.has(id)) continue;
      mappedIds.add(id);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }

  const triageIds = new Set<string>();
  const addTriage = (id: string) => {
    if (id && !mappedIds.has(id)) triageIds.add(id);
  };
  for (const row of input.filed) {
    const ids = row.messageIds?.length ? row.messageIds : [row.emailId];
    for (const id of ids) addTriage(id);
  }
  for (const id of input.digestIds) addTriage(id);

  const categoryOrder = [
    ...input.functions,
    ...counts.keys(),
  ].filter((category, i, all) => all.indexOf(category) === i);
  const mappedByCategory = categoryOrder
    .filter((category) => (counts.get(category) ?? 0) > 0)
    .map((category) => ({ category, count: counts.get(category) ?? 0 }));

  const mapped = mappedIds.size;
  const triage = triageIds.size;
  return {
    asOf: input.asOf,
    total: input.providerTotal,
    mapped,
    mappedByCategory,
    triage,
    pending: Math.max(0, input.providerTotal - mapped - triage),
  };
}

type AccountingBrief = {
  builtAt: string;
  providerTotal?: { messages: number; threads: number };
  totalInbox?: number;
  functions?: string[];
  matters: MatterLike[];
  pinned?: MatterLike[];
  filed?: FiledLike[];
  headlineIds: { id: string; threadId: string }[];
  accounting?: InboxAccounting;
};

/** Recompute the shared dashboard after an optimistic server-side mutation. */
export function withInboxAccounting<T extends AccountingBrief>(brief: T): T {
  return {
    ...brief,
    accounting: buildInboxAccounting({
      asOf: new Date().toISOString(),
      providerTotal:
        brief.providerTotal?.messages ?? brief.totalInbox ?? 0,
      functions: brief.functions ?? [],
      matters: brief.matters,
      pinned: brief.pinned ?? [],
      filed: brief.filed ?? [],
      digestIds: brief.headlineIds.map((row) => row.id),
    }),
  };
}
