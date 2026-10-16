"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import type { StaffTask, StaffView } from "@/lib/v2/staff/types";
import { ACTION_LABEL, DEFAULT_BOT_SLUG, STATUS_LABEL } from "@/lib/v2/staff/types";

function daysAgo(iso: string | null, now: number): number {
  if (!iso) return 0;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((now - at) / 86_400_000));
}

const ACTIVE = new Set(["open", "in_progress", "blocked", "waiting_on_user"]);

export function StaffBoard({
  view,
  selectedTaskId,
  chatOpen,
  onOpenTask,
  onOpenChat,
  onCreateTask,
  onDecideProposal,
}: {
  view: StaffView;
  selectedTaskId?: string | null;
  chatOpen?: boolean;
  onOpenTask?: (taskId: string) => void;
  onOpenChat?: () => void;
  onCreateTask?: (title: string, botSlug: string) => void;
  onDecideProposal?: (proposalId: string, decision: "approved" | "rejected") => void;
}) {
  const now = Date.now();
  const [title, setTitle] = useState("");
  const [botSlug, setBotSlug] = useState(DEFAULT_BOT_SLUG);
  const grouped = useMemo(() => {
    const active = view.tasks.filter((task) => ACTIVE.has(task.status));
    const settled = view.tasks.filter((task) => !ACTIVE.has(task.status));
    const byBot = new Map<string, StaffTask[]>();
    for (const task of active) {
      const key = task.botName;
      const list = byBot.get(key) ?? [];
      list.push(task);
      byBot.set(key, list);
    }
    return { byBot, settled };
  }, [view.tasks]);

  const submit = () => {
    const next = title.trim();
    if (!next) return;
    onCreateTask?.(next, botSlug);
    setTitle("");
  };

  return (
    <div className="staff-board" data-staff-board="true">
      <div className="staff-board-head">
        <span className="wb-sname atlas-heading">Delegated</span>
        {onOpenChat ? (
          <button
            type="button"
            className="wb-btn wb-btn-primary staff-chat-open"
            aria-pressed={chatOpen ? true : false}
            onClick={onOpenChat}
          >
            Chat with Chief of staff
          </button>
        ) : null}
      </div>

      {view.proposals.length > 0 ? (
        <section className="staff-proposals" aria-label="Triage proposals">
          <h2 className="staff-kicker">Triage proposals</h2>
          <ul className="staff-proposal-list">
            {view.proposals.map((proposal) => (
              <li key={proposal.id} className="staff-proposal">
                <div className="staff-proposal-main">
                  <strong className="staff-proposal-action">
                    {ACTION_LABEL[proposal.action]}
                    {proposal.destinationName ? ` → ${proposal.destinationName}` : ""}
                  </strong>
                  <span className="staff-proposal-mail">
                    {proposal.senderEmail || proposal.botName}
                    {proposal.subject ? ` · ${proposal.subject}` : ""}
                  </span>
                  {proposal.rationale ? (
                    <span className="staff-proposal-why">{proposal.rationale}</span>
                  ) : null}
                </div>
                <div className="staff-proposal-acts">
                  <button
                    type="button"
                    className="wb-btn wb-btn-primary"
                    onClick={() => onDecideProposal?.(proposal.id, "approved")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="wb-btn"
                    onClick={() => onDecideProposal?.(proposal.id, "rejected")}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {[...grouped.byBot.entries()].map(([botName, tasks]) => (
        <section key={botName} className="wb-sec staff-sec" data-staff-bot={botName}>
          <div className="wb-shead">
            <span className="wb-sname atlas-heading">{botName}</span>
            <span className="wb-scount tabular">{tasks.length}</span>
          </div>
          {tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className={`wb-mhead staff-task${
                selectedTaskId === task.id ? " wb-m-current" : ""
              }`}
              data-atlas-task={task.id}
              aria-label={`Open delegated task ${task.title}`}
              onClick={() => onOpenTask?.(task.id)}
            >
              <span className="wb-mt staff-task-title">{task.title}</span>
              <span className="wb-own tabular">{STATUS_LABEL[task.status]}</span>
              <span className="wb-age tabular">{daysAgo(task.updatedAt, now)}d</span>
            </button>
          ))}
        </section>
      ))}

      {grouped.settled.length > 0 ? (
        <p className="staff-settled tabular">
          {grouped.settled.length} done or dropped
        </p>
      ) : null}

      {onCreateTask ? (
        <form
          className="staff-create"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="staff-create-label">
            <span>New task</span>
            <input
              className="staff-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Delegate a task"
            />
          </label>
          <label className="staff-create-label">
            <span>Bot</span>
            <select
              className="staff-input"
              value={botSlug}
              onChange={(event) => setBotSlug(event.target.value)}
            >
              {view.bots.map((bot) => (
                <option key={bot.slug} value={bot.slug}>
                  {bot.displayName}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="wb-btn wb-btn-primary">
            Delegate
          </button>
        </form>
      ) : null}
    </div>
  );
}
