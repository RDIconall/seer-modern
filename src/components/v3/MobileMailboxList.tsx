"use client";

import * as React from "react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Archive, LayoutGrid, Sparkles, Trash2, X } from "lucide-react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type { MailboxRow, MailboxView } from "@/lib/v3/mailbox/types";
import { triagePiles } from "@/lib/v3/mailbox/triage-verb";
import { groupState } from "@/components/v2/triage-select";
import { MobileMailRow } from "./MobileMailRow";
import {
  EMPTY_SELECTION,
  reduceSelection,
  type Selection,
  type SelectionAction,
} from "./list-selection";
import type { MatterSuggestion } from "@/lib/v2/intelligence/user-matter";

const mobileTime = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
};

/**
 * Triage sends a conversation to Atlas, to the archive, or to the bin. Making
 * it a matter is a correction to Seer's reading, and a correction is law: the
 * conversation appears on the whiteboard and stops being asked about.
 */
const matterCommand = (
  row: MailboxRow,
  options: {
    matterId?: string;
    matterTitle?: string;
    createMatter?: boolean;
  } = {},
): Command => ({
  type: "triageConversation",
  conversationId: row.conversationId,
  destination: "matter",
  ...options,
});

const triageArchiveCommand = (row: MailboxRow): Command => ({
  type: "triageConversation",
  conversationId: row.conversationId,
  destination: "archive",
});

const triageDeleteCommand = (row: MailboxRow): Command => ({
  type: "triageConversation",
  conversationId: row.conversationId,
  destination: "delete",
});

const archiveCommand = (row: MailboxRow): Command => ({
  type: "archive",
  conversationId: row.conversationId,
});

/** The user is looking straight at this row, so their delete is their own call. */
const deleteCommand = (row: MailboxRow): Command => ({
  type: "delete",
  conversationId: row.conversationId,
  byUser: true,
});

export function MobileMailboxList({
  view,
  triage = false,
  currentConversationId,
  onOpen,
  onCommands,
  onCards,
}: {
  view: MailboxView;
  triage?: boolean;
  currentConversationId?: string | null;
  onOpen: (row: MailboxRow) => void;
  onCommands: (commands: Command[]) => Promise<CommandResult[]>;
  onCards?: () => void;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [matterRow, setMatterRow] = useState<MailboxRow | null>(null);
  const [matterChoices, setMatterChoices] = useState<MatterSuggestion[]>([]);
  const [matterChoicesLoading, setMatterChoicesLoading] = useState(false);
  const [newMatterTitle, setNewMatterTitle] = useState("");

  const act = async (row: MailboxRow, command: Command) => {
    setHidden((current) => new Set(current).add(row.conversationId));
    try {
      const [result] = await onCommands([command]);
      if (!result?.ok) {
        throw new Error(result?.error ?? "action was not queued");
      }
    } catch {
      setHidden((current) => {
        const next = new Set(current);
        next.delete(row.conversationId);
        return next;
      });
    }
  };

  const rows = view.rows.filter((row) => !hidden.has(row.conversationId));
  const groups = useMemo(
    () =>
      triage
        ? triagePiles(rows, new Set()).map((pile) => ({
            key: pile.verb,
            label: pile.label,
            hint: pile.hint,
            rows: pile.days.flatMap((day) => day.rows),
          }))
        : [{ key: view.folder, label: "", hint: "", rows }],
    [rows, triage, view.folder],
  );

  // Selection follows the order the rows are READ in, not the order they
  // arrived in: a shift range across a pile boundary has to mean what the eye
  // saw, so the ids are the flattened piles rather than `view.rows`.
  const orderedRows = useMemo(
    () => groups.flatMap((group) => group.rows),
    [groups],
  );
  const allIds = useMemo(
    () => orderedRows.map((row) => row.conversationId),
    [orderedRows],
  );
  const allIdsRef = useRef(allIds);
  allIdsRef.current = allIds;
  const [selection, dispatchSelection] = useReducer(
    (state: Selection, action: SelectionAction) =>
      reduceSelection(state, action, allIdsRef.current),
    EMPTY_SELECTION,
  );

  // A tick on a row that has since been placed must not survive to act on
  // something else later.
  useEffect(() => {
    dispatchSelection({ kind: "prune" });
  }, [allIds]);

  const selected = selection.ids as Set<string>;
  const selectedCount = selected.size;
  const selecting = selectedCount > 0;

  // Escape drops the selection, as it does in every mail client. Being stuck
  // in selection mode with no way out but un-ticking rows one by one is what
  // makes bulk actions feel dangerous.
  useEffect(() => {
    if (!selecting) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatchSelection({ kind: "clear" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selecting]);

  const sweep = async (
    groupRows: MailboxRow[],
    command: (row: MailboxRow) => Command,
  ) => {
    setHidden((current) => {
      const next = new Set(current);
      for (const row of groupRows) next.add(row.conversationId);
      return next;
    });
    const results = await onCommands(groupRows.map(command));
    const failedIds = groupRows
      .filter((_, index) => !results[index]?.ok)
      .map((row) => row.conversationId);
    if (failedIds.length > 0) {
      setHidden((current) => {
        const next = new Set(current);
        for (const id of failedIds) next.delete(id);
        return next;
      });
    }
  };

  /** Send everything ticked to one destination, then drop the selection. */
  const placeSelected = async (command: (row: MailboxRow) => Command) => {
    const picked = orderedRows.filter((row) => selected.has(row.conversationId));
    if (picked.length === 0) return;
    dispatchSelection({ kind: "clear" });
    await sweep(picked, command);
  };

  const openMatterPicker = async (row: MailboxRow) => {
    setMatterRow(row);
    setNewMatterTitle(row.subject.replace(/^(?:re|fw|fwd):\s*/i, "").trim());
    setMatterChoices([]);
    setMatterChoicesLoading(true);
    try {
      const response = await fetch(
        `/api/v3/matter-suggestions?conversationId=${encodeURIComponent(
          row.conversationId,
        )}`,
      );
      const json = (await response.json()) as {
        matters?: MatterSuggestion[];
      };
      if (response.ok) setMatterChoices(json.matters ?? []);
    } catch {
      // Creating a new matter and Seer's auto-placement still work offline.
      setMatterChoices([]);
    } finally {
      setMatterChoicesLoading(false);
    }
  };

  const placeOnMatter = (
    row: MailboxRow,
    options?: {
      matterId?: string;
      matterTitle?: string;
      createMatter?: boolean;
    },
  ) => {
    setMatterRow(null);
    void act(row, matterCommand(row, options));
  };

  const renderRow = (row: MailboxRow, index: number) => (
    <MobileMailRow
      key={row.conversationId}
      selectable
      selected={selected.has(row.conversationId)}
      selecting={selecting}
      onToggleSelect={(shift) =>
        dispatchSelection({ kind: "row", index, shift })
      }
      model={{
        id: row.conversationId,
        from: row.senderDisplayName,
        subject: row.subject,
        preview:
          (triage ? row.decisionSummary : null) ||
          row.snippet ||
          "No preview available",
        when: mobileTime(row.timestamp),
        isUnread: row.isUnread,
        attachmentCount: row.attachments.length,
      }}
      current={row.conversationId === currentConversationId}
      onOpen={() => onOpen(row)}
      onArchive={() =>
        void act(
          row,
          triage ? triageArchiveCommand(row) : archiveCommand(row),
        )
      }
      onDelete={() =>
        void act(row, triage ? triageDeleteCommand(row) : deleteCommand(row))
      }
      onAtlas={
        triage ? () => void act(row, matterCommand(row)) : undefined
      }
      onLongPress={triage ? () => void openMatterPicker(row) : undefined}
      actions={
        triage
          ? [
              { label: "Atlas", run: () => void act(row, matterCommand(row)) },
              {
                label: "Archive",
                run: () => void act(row, triageArchiveCommand(row)),
              },
              {
                label: "Delete",
                run: () => void act(row, triageDeleteCommand(row)),
              },
            ]
          : undefined
      }
    />
  );

  return (
    <section
      className="mobile-mail-list compact-mail-list"
      aria-label={`${triage ? "Triage" : "Inbox"} messages`}
    >
      <header className="compact-mail-header">
        <div>
          <h1>{triage ? "Triage" : "Inbox"}</h1>
          <span className="tabular">
            {triage
              ? `${rows.length} to place${
                  view.processing
                    ? ` · Seer reading ${view.processing}`
                    : ""
                } · Atlas, archive or bin`
              : `${view.total} conversations`}
          </span>
        </div>
        {triage && onCards ? (
          <button type="button" onClick={onCards}>
            Cards
          </button>
        ) : null}
      </header>
      {/* The bar belongs to selecting, not to the list: a list that always
          shows bulk actions is a spreadsheet. It names the same destinations
          the row does, so placing ten is the gesture for placing one. */}
      {selecting ? (
        <div
          className="compact-mail-bulk"
          role="toolbar"
          aria-label="Selected conversation actions"
        >
          <span className="tabular" aria-live="polite">
            {selectedCount} selected
          </span>
          {triage ? (
            <button
              type="button"
              onClick={() => void placeSelected((row) => matterCommand(row))}
            >
              <LayoutGrid aria-hidden />
              Atlas
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              void placeSelected(triage ? triageArchiveCommand : archiveCommand)
            }
          >
            <Archive aria-hidden />
            Archive
          </button>
          <button
            type="button"
            onClick={() =>
              void placeSelected(triage ? triageDeleteCommand : deleteCommand)
            }
          >
            <Trash2 aria-hidden />
            Delete
          </button>
          <button
            type="button"
            className="compact-mail-bulk-clear"
            onClick={() => dispatchSelection({ kind: "clear" })}
          >
            <X aria-hidden />
            Clear
          </button>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p className="mail-empty">
          {triage ? "Inbox placed. Nothing left to triage." : "Nothing here yet."}
        </p>
      ) : (
        groups.map((group) => {
          const groupIds = group.rows.map((row) => row.conversationId);
          const state = groupState(selected, groupIds);
          // Where this pile starts in the flattened reading order, so a row
          // knows its own index for a shift range.
          const offset = allIds.indexOf(groupIds[0] ?? "");
          return (
            <div key={group.key} className="compact-mail-group">
              {group.label ? (
                <h2>
                  <input
                    type="checkbox"
                    className="mobile-mail-select mail-focus-ring"
                    checked={state === "all"}
                    ref={(el) => {
                      if (el) el.indeterminate = state === "some";
                    }}
                    aria-label={`Select all in ${group.label}`}
                    onChange={(event) =>
                      dispatchSelection({
                        kind: "group",
                        ids: groupIds,
                        checked: event.target.checked,
                      })
                    }
                  />
                  <span>{group.label}</span>
                  <em className="tabular">{group.rows.length}</em>
                  <small>{group.hint}</small>
                  {group.key === "delete" || group.key === "archive" ? (
                    <button
                      type="button"
                      onClick={() =>
                        void sweep(
                          group.rows,
                          group.key === "delete"
                            ? triageDeleteCommand
                            : triageArchiveCommand,
                        )
                      }
                    >
                      {group.key === "delete" ? "Delete all" : "Archive all"}
                    </button>
                  ) : null}
                </h2>
              ) : null}
              {group.rows.map((row, index) =>
                renderRow(row, offset < 0 ? index : offset + index),
              )}
            </div>
          );
        })
      )}
      {matterRow ? (
        <div
          className="matter-picker-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setMatterRow(null);
          }}
        >
          <section
            className="matter-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="matter-picker-title"
          >
            <header>
              <div>
                <h2 id="matter-picker-title">Put on Atlas</h2>
                <p>{matterRow.subject || "(no subject)"}</p>
              </div>
              <button
                type="button"
                aria-label="Close matter picker"
                onClick={() => setMatterRow(null)}
              >
                <X aria-hidden />
              </button>
            </header>

            <button
              type="button"
              className="matter-picker-ai"
              onClick={() => placeOnMatter(matterRow)}
            >
              <Sparkles aria-hidden />
              <span>
                <strong>Let Seer place it</strong>
                <small>Reuse a related matter, or create the right one.</small>
              </span>
            </button>

            {matterChoicesLoading ? (
              <p className="matter-picker-status">Sweeping Atlas for related work…</p>
            ) : matterChoices.length > 0 ? (
              <div className="matter-picker-list">
                {matterChoices.slice(0, 12).map((matter) => (
                  <button
                    key={matter.matterId}
                    type="button"
                    data-related={matter.related ? "true" : undefined}
                    onClick={() =>
                      placeOnMatter(matterRow, {
                        matterId: matter.matterId,
                      })
                    }
                  >
                    <span>{matter.shortTitle}</span>
                    <small>
                      {matter.related ? "Suggested by Seer" : matter.section ?? "Atlas"}
                    </small>
                  </button>
                ))}
              </div>
            ) : null}

            <form
              className="matter-picker-new"
              onSubmit={(event) => {
                event.preventDefault();
                const title = newMatterTitle.trim();
                if (!title) return;
                placeOnMatter(matterRow, {
                  matterTitle: title,
                  createMatter: true,
                });
              }}
            >
              <label htmlFor="new-matter-title">New matter</label>
              <div>
                <input
                  id="new-matter-title"
                  value={newMatterTitle}
                  maxLength={120}
                  onChange={(event) => setNewMatterTitle(event.target.value)}
                />
                <button type="submit" disabled={!newMatterTitle.trim()}>
                  Create
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}
