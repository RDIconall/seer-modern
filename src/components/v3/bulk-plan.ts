import type { Command } from "@/lib/v2/commands/types";
import { NEXT_VERB_LABEL, type NextVerb } from "@/lib/v3/mailbox/next-step";
import type { InboxGroup } from "./inbox-groups";

/**
 * What "Do these next steps" will do, worked out before anything runs.
 *
 * The Inbox lets a person agree with many next steps at once, so the one place
 * that matters is the moment between ticking and doing. This turns the ticked
 * groups into the exact commands, and into the sentence the confirmation
 * dialog shows, from the same list — what the dialog says and what runs cannot
 * drift apart.
 */

/** What happens to a ticked group. A matter is finished by filing its mail away. */
export type PlanEffect = NextVerb | "finish";

export type PlanItem = {
  groupKey: string;
  title: string;
  effect: PlanEffect;
  emails: number;
  /** The wording the person agreed to, for a matter. */
  text: string;
  /** Seer's safety check had held this conversation back from deletion. */
  heldBack: boolean;
};

export type BulkPlan = {
  items: PlanItem[];
  commands: Command[];
  /** Emails affected, per effect. */
  counts: Record<PlanEffect, { groups: number; emails: number }>;
  heldBack: number;
  emails: number;
};

export const EFFECT_LABEL: Record<PlanEffect, string> = {
  delete: "Delete",
  archive: NEXT_VERB_LABEL.archive,
  record: NEXT_VERB_LABEL.record,
  finish: "Done, archive the matter",
};

/** `overrides` holds the verbs the person changed from Seer's proposal. */
export function planBulk(
  groups: InboxGroup[],
  selectedKeys: ReadonlySet<string>,
  overrides: Readonly<Record<string, NextVerb>> = {},
): BulkPlan {
  const items: PlanItem[] = [];
  const commands: Command[] = [];
  const counts: BulkPlan["counts"] = {
    delete: { groups: 0, emails: 0 },
    archive: { groups: 0, emails: 0 },
    record: { groups: 0, emails: 0 },
    finish: { groups: 0, emails: 0 },
  };
  let heldBack = 0;

  for (const group of groups) {
    if (!selectedKeys.has(group.key)) continue;

    const effect: PlanEffect =
      group.kind === "matter"
        ? "finish"
        : (overrides[group.key] ?? group.verb ?? "archive");
    const held =
      effect === "delete" && group.rows.some((row) => row.vetoReasons.length > 0);

    for (const row of group.rows) {
      if (effect === "delete") {
        // Each of these was ticked by the person and confirmed in the dialog,
        // so this is their delete rather than a sweep of Seer's proposal.
        commands.push({
          type: "delete",
          conversationId: row.conversationId,
          byUser: true,
        });
      } else if (effect === "record") {
        commands.push({
          type: "correctConversation",
          conversationId: row.conversationId,
          home: "record",
        });
        commands.push({ type: "archive", conversationId: row.conversationId });
      } else {
        commands.push({ type: "archive", conversationId: row.conversationId });
      }
    }

    counts[effect].groups += 1;
    counts[effect].emails += group.rows.length;
    if (held) heldBack += 1;
    items.push({
      groupKey: group.key,
      title: group.title,
      effect,
      emails: group.rows.length,
      text: group.step.text,
      heldBack: held,
    });
  }

  return {
    items,
    commands,
    counts,
    heldBack,
    emails: items.reduce((sum, item) => sum + item.emails, 0),
  };
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** One line per effect, in the order the dialog reads them. */
export function planSummary(plan: BulkPlan): string[] {
  const lines: string[] = [];
  const { counts } = plan;
  if (counts.delete.groups > 0) {
    lines.push(`Delete ${plural(counts.delete.emails, "email")}`);
  }
  if (counts.finish.groups > 0) {
    lines.push(
      `Finish ${plural(counts.finish.groups, "matter")} and archive ${plural(
        counts.finish.emails,
        "email",
      )}`,
    );
  }
  if (counts.archive.groups > 0) {
    lines.push(`Archive ${plural(counts.archive.emails, "email")}`);
  }
  if (counts.record.groups > 0) {
    lines.push(`Keep ${plural(counts.record.emails, "email")} for the record`);
  }
  return lines;
}
