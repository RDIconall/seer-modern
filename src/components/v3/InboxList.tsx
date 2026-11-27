"use client";

import * as React from "react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FolderPlus, Pencil, X } from "lucide-react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import { groupState } from "@/components/v2/triage-select";
import {
  NEXT_VERB_LABEL,
  type NextVerb,
} from "@/lib/v3/mailbox/next-step";
import type { MailboxRow, MailboxView } from "@/lib/v3/mailbox/types";
import { BulkConfirmDialog } from "./BulkConfirmDialog";
import { planBulk, planSummary } from "./bulk-plan";
import { ageLabel, groupInbox, shortDate, type InboxGroup } from "./inbox-groups";
import {
  EMPTY_SELECTION,
  reduceSelection,
  type Selection,
  type SelectionAction,
} from "./list-selection";
import { Check } from "./ListCheck";
import { MatterPicker } from "./MatterPicker";
import { rowLabel } from "./useMailbox";

const VERBS = Object.keys(NEXT_VERB_LABEL) as NextVerb[];

/**
 * The person edits a matter's next step as a sentence. Enter or leaving the
 * box saves it, Escape abandons it, and clearing it hands the wording back to
 * Seer.
 */
function NextStepEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) onSave(draft);
    else onCancel();
  };

  return (
    <input
      className="inbox-step-input mail-focus-ring"
      autoFocus
      value={draft}
      maxLength={280}
      aria-label="Next step"
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

export function InboxList({
  view,
  refreshing = false,
  currentConversationId,
  onOpen,
  onPrefetch,
  onCommands,
  initialSelectedKeys,
  initialConfirming = false,
}: {
  view: MailboxView;
  refreshing?: boolean;
  currentConversationId?: string | null;
  onOpen: (row: MailboxRow) => void;
  onPrefetch: (conversationId: string) => void;
  onCommands: (commands: Command[]) => Promise<CommandResult[]>;
  /** Seeds the selection so the bulk bar can be rendered without a click. */
  initialSelectedKeys?: string[];
  /** Opens the confirmation on first render, for the preview. */
  initialConfirming?: boolean;
}) {
  const groups = useMemo(() => groupInbox(view.rows), [view.rows]);
  const keys = useMemo(() => groups.map((group) => group.key), [groups]);
  const keysRef = useRef(keys);
  keysRef.current = keys;

  const [selection, dispatchSelection] = useReducer(
    (state: Selection, action: SelectionAction) =>
      reduceSelection(state, action, keysRef.current),
    initialSelectedKeys,
    (seed): Selection =>
      seed && seed.length > 0 ? { ids: new Set(seed), anchor: null } : EMPTY_SELECTION,
  );
  const [verbs, setVerbs] = useState<Record<string, NextVerb>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(initialConfirming);
  const [busy, setBusy] = useState(false);
  const [placing, setPlacing] = useState<MailboxRow | null>(null);

  // A tick on a group that has since been placed must not survive to act on
  // something else later.
  useEffect(() => {
    dispatchSelection({ kind: "prune" });
  }, [keys]);

  // Opening a conversation from outside the list (a search hit, a link, j/k)
  // reveals it, so the row the reader is showing is never hidden.
  useEffect(() => {
    if (!currentConversationId) return;
    const owner = groups.find(
      (group) =>
        group.kind === "matter" &&
        group.rows.some((row) => row.conversationId === currentConversationId),
    );
    if (owner) setExpanded((current) => new Set(current).add(owner.key));
  }, [currentConversationId, groups]);

  const selected = selection.ids as Set<string>;
  const selectedCount = selected.size;
  const selecting = selectedCount > 0;

  useEffect(() => {
    if (!selecting || confirming) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input[type=text], textarea, select")) return;
      if (event.key === "Escape") dispatchSelection({ kind: "clear" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selecting, confirming]);

  const plan = useMemo(() => planBulk(groups, selected, verbs), [groups, selected, verbs]);

  const apply = async () => {
    if (busy || plan.commands.length === 0) return;
    setBusy(true);
    try {
      await onCommands(plan.commands);
    } catch {
      // The toast owns the failure message; the list is re-read either way.
    } finally {
      setBusy(false);
      setConfirming(false);
      dispatchSelection({ kind: "clear" });
      setVerbs({});
    }
  };

  const saveStep = async (group: InboxGroup, text: string) => {
    setEditing(null);
    if (!group.matterId) return;
    const next = text.trim();
    if (next === group.step.text.trim()) return;
    try {
      await onCommands([
        { type: "setMatterNextStep", matterId: group.matterId, text: next || null },
      ]);
    } catch {
      // The toast owns the failure message.
    }
  };

  const place = async (command: Command) => {
    setPlacing(null);
    try {
      await onCommands([command]);
    } catch {
      // The toast owns the failure message.
    }
  };

  const toggleOpen = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const open = (row: MailboxRow) => {
    onPrefetch(row.conversationId);
    onOpen(row);
  };

  const emailCount = view.total;
  const groupCount = view.groups ?? groups.length;
  const summary = planSummary(plan);

  const stepCell = (group: InboxGroup) => {
    if (group.kind === "single") {
      const verb = verbs[group.key] ?? group.verb ?? "archive";
      return (
        <span className="inbox-step inbox-step-verb">
          <select
            className="inbox-verb mail-focus-ring"
            value={verb}
            aria-label={`Next step for ${group.title}`}
            onChange={(event) =>
              setVerbs((current) => ({
                ...current,
                [group.key]: event.target.value as NextVerb,
              }))
            }
          >
            {VERBS.map((option) => (
              <option key={option} value={option}>
                {NEXT_VERB_LABEL[option]}
              </option>
            ))}
          </select>
          <span className="inbox-reason">{group.step.text}</span>
        </span>
      );
    }
    if (editing === group.key) {
      return (
        <span className="inbox-step">
          <NextStepEditor
            initial={group.step.text}
            onSave={(text) => void saveStep(group, text)}
            onCancel={() => setEditing(null)}
          />
        </span>
      );
    }
    return (
      <span className="inbox-step">
        <button
          type="button"
          className="inbox-step-button mail-focus-ring"
          title="Edit next step"
          aria-label={`Edit next step: ${group.step.text}`}
          data-source={group.step.source}
          onClick={() => setEditing(group.key)}
        >
          <span>{group.step.text}</span>
          <Pencil aria-hidden />
        </button>
      </span>
    );
  };

  const rowActions = (row: MailboxRow, label: string) => (
    <span className="inbox-actions">
      <button
        type="button"
        className="mail-action mail-list-action mail-focus-ring"
        aria-label={`Add ${label} to a matter`}
        title="Add to a matter"
        onClick={() => setPlacing(row)}
      >
        <FolderPlus aria-hidden />
      </button>
    </span>
  );

  return (
    <section className="mail-folder-layout inbox-list" aria-label="inbox messages">
      <header className="mail-list-header">
        <div>
          <h1>Inbox</h1>
          <p className="mail-list-ledger tabular">
            {groupCount} {groupCount === 1 ? "item" : "items"} · {emailCount}{" "}
            {emailCount === 1 ? "email" : "emails"} · oldest first
            {view.processing ? ` · Seer reading ${view.processing}` : ""}
            {refreshing ? " · Updating…" : ""}
          </p>
        </div>
      </header>

      <div
        className="mail-bulk-toolbar"
        data-selecting={selecting ? "true" : "false"}
        role="toolbar"
        aria-label="Next step actions"
      >
        {selecting ? (
          <>
            <Check
              state={groupState(selected, keys)}
              onChange={(checked) => dispatchSelection({ kind: "all", checked })}
              label="Select all"
            />
            <span className="mail-bulk-count" aria-live="polite">
              {selectedCount} selected
            </span>
            <span className="mail-bulk-hint">{summary.join(" · ")}</span>
            <button
              type="button"
              className="mail-bulk-clear mail-focus-ring"
              onClick={() => dispatchSelection({ kind: "clear" })}
            >
              <X aria-hidden className="mail-bulk-icon" />
              Clear
            </button>
            <button
              type="button"
              className="inbox-apply mail-focus-ring"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Do these next steps
            </button>
          </>
        ) : (
          <span className="mail-bulk-count">Check the steps you agree with</span>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="mail-empty">Nothing here yet.</p>
      ) : (
        <div className="inbox-body">
          <div className="inbox-head" aria-hidden="true">
            <span className="inbox-head-gap" />
            <div className="inbox-cols">
              <span className="inbox-open-head">
                <span className="inbox-from">From / matter</span>
                <span className="inbox-subject">Subject</span>
              </span>
              <span className="inbox-step">Next step</span>
              <span className="inbox-date">Oldest</span>
            </div>
            <span className="inbox-actions" />
          </div>
          <div className="inbox-card">
            <ul className="mail-list">
              {groups.map((group, index) => {
                const isSelected = selected.has(group.key);
                const isOpen =
                  group.kind === "matter" && expanded.has(group.key);
                const newest = group.rows[0];
                const check = (
                  <Check
                    state={isSelected ? "all" : "none"}
                    onChange={(_checked, shift) =>
                      dispatchSelection({ kind: "row", index, shift })
                    }
                    label={`Select ${group.title}`}
                  />
                );

                return (
                  <React.Fragment key={group.key}>
                    <li
                      className="mail-list-row inbox-row"
                      data-kind={group.kind}
                      data-unread={group.unread ? "true" : "false"}
                      data-selected={isSelected ? "true" : "false"}
                      data-current={
                        group.rows.some((row) => row.conversationId === currentConversationId)
                          ? "true"
                          : undefined
                      }
                    >
                      {check}
                      <span className="inbox-gutter">
                        {group.kind === "matter" ? (
                          <button
                            type="button"
                            className="inbox-chevron mail-focus-ring"
                            aria-label={`${isOpen ? "Hide" : "Show"} emails in ${group.title}`}
                            aria-expanded={isOpen}
                            onClick={() => toggleOpen(group.key)}
                          >
                            {isOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                          </button>
                        ) : null}
                      </span>
                      <div className="inbox-cols">
                        {group.kind === "matter" ? (
                          <button
                            type="button"
                            className="inbox-open mail-focus-ring"
                            aria-expanded={isOpen}
                            onClick={() => toggleOpen(group.key)}
                          >
                            <span className="inbox-from mail-list-sender">{group.title}</span>
                            <span className="inbox-subject">
                              <span className="inbox-count">
                                {group.rows.length} {group.rows.length === 1 ? "email" : "emails"}
                              </span>
                              {group.section ? (
                                <span className="inbox-section">{group.section}</span>
                              ) : null}
                            </span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="inbox-open mail-focus-ring"
                            aria-label={`Open ${rowLabel(newest)}`}
                            onClick={() => open(newest)}
                            onFocus={() => onPrefetch(newest.conversationId)}
                            onMouseEnter={() => onPrefetch(newest.conversationId)}
                          >
                            <span className="inbox-from mail-list-sender">{group.title}</span>
                            <span className="inbox-subject mail-list-subject">
                              {newest.subject || "(no subject)"}
                              {group.section ? (
                                <span className="inbox-section">{group.section}</span>
                              ) : null}
                            </span>
                          </button>
                        )}
                        {stepCell(group)}
                        <span className="inbox-date tabular" suppressHydrationWarning>
                          {ageLabel(group.oldestAt)}
                        </span>
                      </div>
                      {group.kind === "single" ? (
                        rowActions(newest, group.title)
                      ) : (
                        <span className="inbox-actions" />
                      )}
                    </li>
                    {isOpen
                      ? group.rows.map((row) => (
                          <li
                            key={row.conversationId}
                            className="mail-list-row inbox-row inbox-child"
                            data-kind="child"
                            data-unread={row.isUnread ? "true" : "false"}
                            data-selected={isSelected ? "true" : "false"}
                            data-current={
                              row.conversationId === currentConversationId ? "true" : undefined
                            }
                          >
                            <span className="inbox-check-gap" />
                            <span className="inbox-gutter" />
                            <div className="inbox-cols">
                              <button
                                type="button"
                                className="inbox-open mail-focus-ring"
                                aria-label={`Open ${rowLabel(row)}`}
                                onClick={() => open(row)}
                                onFocus={() => onPrefetch(row.conversationId)}
                                onMouseEnter={() => onPrefetch(row.conversationId)}
                              >
                                <span className="inbox-from mail-list-sender">
                                  {row.senderDisplayName || "Unknown sender"}
                                </span>
                                <span className="inbox-subject mail-list-subject">
                                  {row.subject || "(no subject)"}
                                </span>
                              </button>
                              <span className="inbox-step" />
                              <time
                                className="inbox-date tabular"
                                dateTime={row.timestamp}
                                suppressHydrationWarning
                              >
                                {shortDate(row.timestamp)}
                              </time>
                            </div>
                            {rowActions(row, row.subject || "conversation")}
                          </li>
                        ))
                      : null}
                  </React.Fragment>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {confirming && plan.items.length > 0 ? (
        <BulkConfirmDialog
          plan={plan}
          busy={busy}
          onConfirm={() => void apply()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
      {placing ? (
        <MatterPicker row={placing} onPlace={(command) => void place(command)} onClose={() => setPlacing(null)} />
      ) : null}
    </section>
  );
}
