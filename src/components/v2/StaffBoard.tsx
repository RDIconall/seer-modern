"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import type { StaffTask, StaffView } from "@/lib/v2/staff/types";
import { ACTION_LABEL, DEFAULT_BOT_SLUG, STATUS_LABEL } from "@/lib/v2/staff/types";
import type { BotTaskStatus } from "@/lib/v2/staff/types";

function daysAgo(iso: string | null, now: number): number {
  if (!iso) return 0;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((now - at) / 86_400_000));
}

const ACTIVE = new Set<BotTaskStatus>([
  "open",
  "in_progress",
  "blocked",
  "waiting_on_user",
]);

type BotFilter = "active" | "waiting_on_user" | "blocked" | "done";

const FILTERS: { id: BotFilter; label: string }[] = [
  { id: "active", label: "Open" },
  { id: "waiting_on_user", label: "Waiting" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
];

function matchesFilter(task: StaffTask, filter: BotFilter): boolean {
  if (filter === "active") return ACTIVE.has(task.status);
  if (filter === "done") return task.status === "done" || task.status === "dropped";
  return task.status === filter;
}

export function StaffBoard({
  view,
  selectedTaskId,
  chatOpen,
  collapsedDefault = true,
  onOpenTask,
  onOpenChat,
  onCreateTask,
  onDecideProposal,
}: {
  view: StaffView;
  selectedTaskId?: string | null;
  chatOpen?: boolean;
  /** When true, bot groups start collapsed so 41 rows cannot bury Atlas. */
  collapsedDefault?: boolean;
  onOpenTask?: (taskId: string, conversationId?: string | null) => void;
  onOpenChat?: (botSlug?: string) => void;
  onCreateTask?: (title: string, botSlug: string) => void;
  onDecideProposal?: (proposalId: string, decision: "approved" | "rejected") => void;
}) {
  const now = Date.now();
  const [title, setTitle] = useState("");
  const [botSlug, setBotSlug] = useState(DEFAULT_BOT_SLUG);
  const [filter, setFilter] = useState<BotFilter>("active");
  const [openBots, setOpenBots] = useState<ReadonlySet<string>>(() => new Set());

  const grouped = useMemo(() => {
    const visible = view.tasks.filter((task) => matchesFilter(task, filter));
    const byBot = new Map<string, StaffTask[]>();
    for (const task of visible) {
      const key = task.botName;
      const list = byBot.get(key) ?? [];
      list.push(task);
      byBot.set(key, list);
    }
    const waiting = view.tasks.filter((task) => task.status === "waiting_on_user");
    const active = view.tasks.filter((task) => ACTIVE.has(task.status));
    return { byBot, waiting, active };
  }, [view.tasks, filter]);

  const submit = () => {
    const next = title.trim();
    if (!next) return;
    onCreateTask?.(next, botSlug);
    setTitle("");
  };

  const isOpen = (botName: string, tasks: StaffTask[]) => {
    if (openBots.has(botName)) return true;
    if (openBots.has(`!${botName}`)) return false;
    if (!collapsedDefault) return true;
    if (selectedTaskId && tasks.some((task) => task.id === selectedTaskId)) {
      return true;
    }
    return false;
  };

  const toggleBot = (botName: string, currentlyOpen: boolean) => {
    setOpenBots((prev) => {
      const next = new Set(prev);
      next.delete(botName);
      next.delete(`!${botName}`);
      next.add(currentlyOpen ? `!${botName}` : botName);
      return next;
    });
  };

  return (
    <div className="staff-board" data-staff-board="true">
      <div className="staff-board-head">
        <span className="wb-sname atlas-heading">Bots</span>
        {onOpenChat ? (
          <button
            type="button"
            className="wb-btn wb-btn-primary staff-chat-open"
            aria-pressed={chatOpen ? true : false}
            onClick={() => onOpenChat()}
          >
            Chat with Chief of staff
          </button>
        ) : null}
      </div>
      <p className="staff-board-ledger tabular">
        {grouped.active.length} open
        {grouped.waiting.length > 0 ? ` · ${grouped.waiting.length} waiting on you` : ""}
      </p>

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

      <div className="wb-seg staff-filters" role="group" aria-label="Filter bot tasks">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={filter === entry.id}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {[...grouped.byBot.entries()].map(([botName, tasks]) => {
        const open = isOpen(botName, tasks);
        const waiting = tasks.filter((task) => task.status === "waiting_on_user").length;
        return (
          <section
            key={botName}
            className="wb-sec staff-sec"
            data-staff-bot={botName}
            data-expanded={open ? "true" : "false"}
          >
            <button
              type="button"
              className="wb-shead staff-bot-toggle"
              aria-expanded={open}
              onClick={() => toggleBot(botName, open)}
            >
              <span className="wb-sname atlas-heading">{botName}</span>
              <span className="wb-scount tabular">
                {tasks.length}
                {waiting > 0 ? ` · ${waiting} waiting` : ""}
              </span>
            </button>
            {open
              ? tasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    className={`wb-mhead staff-task${
                      selectedTaskId === task.id ? " wb-m-current" : ""
                    }`}
                    data-atlas-task={task.id}
                    aria-label={`Open delegated task ${task.title}`}
                    onClick={() => onOpenTask?.(task.id, task.conversationId)}
                  >
                    <span className="wb-mt staff-task-title">{task.title}</span>
                    <span className="wb-own tabular">{STATUS_LABEL[task.status]}</span>
                    <span className="wb-age tabular">{daysAgo(task.updatedAt, now)}d</span>
                  </button>
                ))
              : null}
          </section>
        );
      })}

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
