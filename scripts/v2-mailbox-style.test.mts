/**
 * Infer, confirm, and apply per-mailbox working style without treating
 * inference as policy.
 */
import assert from "node:assert/strict";
import {
  detectDrift,
  inferStyle,
  relevanceOutcome,
  styleGuidance,
  type MailboxSnapshot,
} from "../src/lib/v2/intelligence/mailbox-style.ts";

const empty: MailboxSnapshot = {
  providerInboxTotal: 0,
  storedInbox: 0,
  unreadInbox: 0,
  starredOrFlagged: 0,
  trashCount: 0,
  sentCount: 0,
  recentUserArchives: 0,
  recentUserDeletes: 0,
  openMatters: 0,
};

{
  const leave = inferStyle({
    ...empty,
    providerInboxTotal: 73536,
    storedInbox: 3276,
    unreadInbox: 2100,
    openMatters: 2,
  });
  assert.equal(leave.clearHabit, "leave");
  assert.equal(leave.matterBar, "high");
  assert.ok(leave.importanceCues.includes("unread"));
  assert.ok(leave.confidence > 0.6);
}

{
  const archive = inferStyle({
    ...empty,
    providerInboxTotal: 42,
    storedInbox: 40,
    recentUserArchives: 12,
    openMatters: 6,
  });
  assert.equal(archive.clearHabit, "archive");
}

{
  const del = inferStyle({
    ...empty,
    providerInboxTotal: 80,
    storedInbox: 70,
    recentUserDeletes: 20,
    recentUserArchives: 2,
  });
  assert.equal(del.clearHabit, "delete");
}

{
  const leaveStyle = {
    clearHabit: "leave" as const,
    importanceCues: ["unread" as const],
    matterBar: "high" as const,
  };
  const yes = relevanceOutcome(leaveStyle, true);
  assert.equal(yes.home, "matter");
  assert.equal(yes.provider, null);
  assert.equal(yes.focusHidden, false);

  const done = relevanceOutcome(leaveStyle, false, "taken_care_of");
  assert.equal(done.home, "record");
  assert.equal(done.provider, null, "leave-in-Inbox must not archive at the provider");
  assert.equal(done.focusHidden, true);

  const never = relevanceOutcome(leaveStyle, false, "never_was");
  assert.equal(never.provider, null);
  assert.equal(never.home, "delete");

  const ended = relevanceOutcome(
    { ...leaveStyle, clearHabit: "archive" },
    false,
    "ended",
  );
  assert.equal(ended.provider, "archive");
  assert.equal(ended.closeMatter, true);
}

{
  const confirmed = {
    clearHabit: "leave" as const,
    importanceCues: ["unread" as const],
    matterBar: "high" as const,
    confirmed: true,
  };
  assert.equal(detectDrift(confirmed, []), null);
  const clearing = Array.from({ length: 10 }, () => ({
    kind: "triage" as const,
    clearToward: "archive" as const,
    matterToward: "demote" as const,
  }));
  assert.match(detectDrift(confirmed, clearing) ?? "", /archiving or deleting/);
}

{
  const text = styleGuidance({
    clearHabit: "leave",
    importanceCues: ["unread"],
    matterBar: "high",
  });
  assert.match(text, /leave mail in the Inbox/);
  assert.match(text, /unread/);
  assert.match(text, /only real ongoing work/);
}

console.log("v2-mailbox-style: OK");
