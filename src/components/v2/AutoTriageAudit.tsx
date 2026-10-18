"use client";

import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type {
  AutoTriageAuditGroup,
  AutoTriageMode,
  AutoTriageSettings,
} from "@/lib/v2/autotriage/types";

export type AutoTriageAuditView = {
  groups: AutoTriageAuditGroup[];
  settings: AutoTriageSettings;
  envMode: AutoTriageMode;
  effectiveMode: AutoTriageMode;
};

function verb(mode: AutoTriageMode, action: "delete" | "archive"): string {
  if (mode !== "live") {
    return action === "delete" ? "would have deleted" : "would have archived";
  }
  return action === "delete" ? "deleted" : "archived";
}

async function dispatch(command: Command): Promise<CommandResult | null> {
  const res = await fetch("/api/v2/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command,
      idempotencyKey:
        globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    }),
  });
  const json = (await res.json()) as { result?: CommandResult };
  return json.result ?? null;
}

export function AutoTriageAudit({
  initial,
}: {
  initial?: AutoTriageAuditView | null;
}) {
  const [view, setView] = useState<AutoTriageAuditView | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v2/autotriage/audit?days=7");
      const json = (await res.json()) as AutoTriageAuditView & { error?: string };
      if (!res.ok) {
        throw new Error(json.error ?? "could not load auto-triage");
      }
      setView(json);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not load auto-triage");
    }
  }, []);

  useEffect(() => {
    if (initial) return;
    void load();
  }, [initial, load]);

  const onMode = async (mode: AutoTriageMode) => {
    await dispatch({ type: "setAutoTriageMode", mode });
    await load();
  };

  const onUndo = async (logId: string) => {
    await dispatch({ type: "undoAutoTriage", logId });
    await load();
  };

  const onKeep = async (sender: string, logId: string) => {
    await dispatch({ type: "alwaysKeepSender", sender, logId });
    await load();
  };

  const mode = view?.effectiveMode ?? "dry_run";

  return (
    <section className="staff-proposals autotriage-audit" aria-label="Cleaned this week">
      <div className="staff-board-head">
        <h2 className="staff-kicker">Cleaned this week</h2>
        <label className="autotriage-mode">
          Mode
          <select
            aria-label="Auto-triage mode"
            value={view?.settings.mode ?? "dry_run"}
            onChange={(event) => void onMode(event.target.value as AutoTriageMode)}
          >
            <option value="off">off</option>
            <option value="dry_run">dry-run</option>
            <option value="live">live</option>
          </select>
          <span className="autotriage-mode-effective">
            effective {mode}
            {view && view.envMode !== "live" && view.settings.mode === "live"
              ? " (env is not live)"
              : ""}
          </span>
        </label>
      </div>
      {error ? <p className="staff-empty">{error}</p> : null}
      {!view || view.groups.length === 0 ? (
        <p className="staff-empty">No auto-triage actions this week.</p>
      ) : (
        <ul className="staff-proposal-list">
          {view.groups.map((group) => (
            <li key={group.sender} className="staff-proposal">
              <div className="staff-proposal-main">
                <strong className="staff-proposal-action">{group.sender}</strong>
                <span className="staff-proposal-mail">
                  {group.deleteCount > 0
                    ? `${verb(mode, "delete")} ${group.deleteCount}`
                    : null}
                  {group.deleteCount > 0 && group.archiveCount > 0 ? " · " : null}
                  {group.archiveCount > 0
                    ? `${verb(mode, "archive")} ${group.archiveCount}`
                    : null}
                  {group.keepCount + group.reviewCount > 0
                    ? ` · kept/review ${group.keepCount + group.reviewCount}`
                    : null}
                  {group.rule ? ` · ${group.rule}` : ""}
                  {` · ${group.decider}`}
                </span>
                {group.subjects[0] ? (
                  <span className="staff-proposal-why">{group.subjects[0]}</span>
                ) : null}
              </div>
              <div className="staff-proposal-acts">
                <button
                  type="button"
                  className="wb-btn"
                  disabled={group.undone}
                  onClick={() => void onUndo(group.latestLogId)}
                >
                  Undo
                </button>
                <button
                  type="button"
                  className="wb-btn wb-btn-primary"
                  onClick={() => void onKeep(group.sender, group.latestLogId)}
                >
                  Always keep this sender
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
