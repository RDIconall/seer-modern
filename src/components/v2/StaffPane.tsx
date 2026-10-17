"use client";

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { Command } from "@/lib/v2/commands/types";
import type {
  BotTaskStatus,
  StaffMessage,
  StaffTask,
  StaffView,
} from "@/lib/v2/staff/types";
import {
  BOT_TASK_STATUSES,
  DEFAULT_BOT_SLUG,
  STATUS_LABEL,
} from "@/lib/v2/staff/types";

function when(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ChatLog({
  messages,
  empty,
}: {
  messages: StaffMessage[];
  empty: string;
}) {
  if (messages.length === 0) {
    return <p className="staff-empty">{empty}</p>;
  }
  return (
    <ol className="staff-chat">
      {messages.map((message) => (
        <li
          key={message.id}
          className="staff-chat-line"
          data-author={message.author}
        >
          <span className="staff-chat-who">
            {message.author === "user" ? "Conall" : message.botName}
            <time className="tabular">{when(message.createdAt)}</time>
          </span>
          <p className="staff-chat-body">{message.body}</p>
        </li>
      ))}
    </ol>
  );
}

export function StaffPane({
  mode,
  view,
  taskId,
  onBack,
  onCommand,
  error,
}: {
  mode: "task" | "chat";
  view: StaffView | null;
  taskId?: string | null;
  onBack: () => void;
  onCommand: (command: Command) => void | Promise<unknown>;
  error?: string | null;
}) {
  const task = useMemo(
    () => view?.tasks.find((row) => row.id === taskId) ?? null,
    [view, taskId],
  );
  const messages =
    mode === "chat"
      ? (view?.generalMessages ?? [])
      : (view?.taskMessages ?? []);
  const [status, setStatus] = useState<BotTaskStatus>(task?.status ?? "open");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [dueAt, setDueAt] = useState(task?.dueAt ? task.dueAt.slice(0, 10) : "");
  const [comment, setComment] = useState("");
  const [chat, setChat] = useState("");

  useEffect(() => {
    setStatus(task?.status ?? "open");
    setNotes(task?.notes ?? "");
    setDueAt(task?.dueAt ? task.dueAt.slice(0, 10) : "");
  }, [task?.id, task?.status, task?.notes, task?.dueAt]);

  const saveTask = (patch: Partial<StaffTask> & { status?: BotTaskStatus }) => {
    if (!task) return;
    void onCommand({
      type: "updateBotTask",
      taskId: task.id,
      status: patch.status ?? status,
      notes: patch.notes ?? notes,
      dueAt: patch.dueAt === undefined ? (dueAt ? `${dueAt}T17:00:00` : null) : patch.dueAt,
      title: patch.title,
      priority: patch.priority,
    });
  };

  const sendChat = () => {
    const body = chat.trim();
    if (!body) return;
    void onCommand({
      type: "postBotMessage",
      body,
      taskId: mode === "task" ? task?.id ?? null : null,
      botSlug: task?.botSlug ?? DEFAULT_BOT_SLUG,
    });
    setChat("");
  };

  return (
    <section
      className="mail-reader mail-reader-full staff-pane"
      aria-label={mode === "chat" ? "Chief of staff" : task?.title ?? "Delegated task"}
    >
      <button type="button" className="mail-reader-back mail-focus-ring" onClick={onBack}>
        <ArrowLeft aria-hidden />
        <span>Back to Atlas</span>
      </button>

      {mode === "chat" ? (
        <>
          <header className="staff-pane-top">
            <h1 className="staff-pane-title">Chief of staff</h1>
            <p className="staff-pane-sub">General thread</p>
          </header>
          <ChatLog
            messages={messages}
            empty="No messages yet. Ask Chief of staff from here."
          />
        </>
      ) : !task ? (
        <p className="staff-empty">Loading this task…</p>
      ) : (
        <>
          <header className="staff-pane-top">
            <h1 className="staff-pane-title">{task.title}</h1>
            <p className="staff-pane-sub">
              Delegated to {task.botName}
              {task.dueAt ? ` · due ${when(task.dueAt)}` : ""}
            </p>
          </header>

          {task.hisWords ? (
            <blockquote className="staff-quote">“{task.hisWords}”</blockquote>
          ) : null}

          {task.currentState ? (
            <p className="staff-state">{task.currentState}</p>
          ) : null}
          {task.nextAction ? (
            <p className="wb-next">{task.nextAction}</p>
          ) : null}

          <div className="staff-fields">
            <label className="staff-create-label">
              <span>Status</span>
              <select
                className="staff-input"
                value={status}
                onChange={(event) => {
                  const next = event.target.value as BotTaskStatus;
                  setStatus(next);
                  saveTask({ status: next });
                }}
              >
                {BOT_TASK_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {STATUS_LABEL[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="staff-create-label">
              <span>Due</span>
              <input
                className="staff-input"
                type="date"
                value={dueAt}
                onChange={(event) => setDueAt(event.target.value)}
                onBlur={() => saveTask({})}
              />
            </label>
          </div>

          <label className="staff-create-label">
            <span>Notes</span>
            <textarea
              className="staff-input staff-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              onBlur={() => saveTask({ notes })}
              rows={4}
            />
          </label>

          <div className="wb-acts">
            <button
              type="button"
              className="wb-btn wb-btn-primary"
              onClick={() => saveTask({ status: "done" })}
            >
              Mark done
            </button>
            <button
              type="button"
              className="wb-btn"
              onClick={() => saveTask({ status: "dropped" })}
            >
              Drop
            </button>
            <button
              type="button"
              className="wb-btn"
              onClick={() =>
                saveTask({
                  priority: Math.max(1, task.priority - 1),
                })
              }
            >
              Higher
            </button>
            <button
              type="button"
              className="wb-btn"
              onClick={() => saveTask({ priority: task.priority + 1 })}
            >
              Lower
            </button>
          </div>

          <h2 className="staff-kicker">History</h2>
          {task.events.length === 0 ? (
            <p className="staff-empty">No history yet.</p>
          ) : (
            <ol className="staff-history">
              {task.events.map((event) => (
                <li key={event.id}>
                  <span className="staff-chat-who">
                    {event.actorName}
                    <time className="tabular">{when(event.createdAt)}</time>
                  </span>
                  <p>
                    {event.kind}
                    {event.body ? ` — ${event.body}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          )}

          <form
            className="staff-comment"
            onSubmit={(event) => {
              event.preventDefault();
              const body = comment.trim();
              if (!body) return;
              void onCommand({ type: "commentBotTask", taskId: task.id, body });
              setComment("");
            }}
          >
            <label className="staff-create-label">
              <span>Comment</span>
              <textarea
                className="staff-input"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                rows={2}
              />
            </label>
            <button type="submit" className="wb-btn">
              Add comment
            </button>
          </form>

          <h2 className="staff-kicker">Chat with {task.botName}</h2>
          <ChatLog
            messages={messages}
            empty="No chat on this task yet."
          />
        </>
      )}

      {error ? <p className="staff-error">{error}</p> : null}

      <form
        className="staff-comment"
        onSubmit={(event) => {
          event.preventDefault();
          sendChat();
        }}
      >
        <label className="staff-create-label">
          <span>Message</span>
          <textarea
            className="staff-input"
            value={chat}
            onChange={(event) => setChat(event.target.value)}
            rows={3}
          />
        </label>
        <button type="submit" className="wb-btn wb-btn-primary">
          Send
        </button>
      </form>
    </section>
  );
}
