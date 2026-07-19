"use client";

import DOMPurify from "isomorphic-dompurify";
import {
  Archive,
  ChevronLeft,
  Inbox,
  ListFilter,
  Mail,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ACTION_META,
  type TriageAction,
} from "@/lib/inbox/classify";

type Guide = {
  action: TriageAction;
  label: string;
  color: string;
  confidence: string;
  reason: string;
  instruction: string;
  detail?: string;
};

type EmailItem = {
  id: string;
  threadId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
  guide: Guide;
};

type Section = {
  action: TriageAction;
  label: string;
  color: string;
  bulkLabel: string;
  items: EmailItem[];
};

type TodayData = {
  accountEmail: string;
  fetchedAt: string;
  inbox?: EmailItem[];
  needsReview: EmailItem[];
  sections: Section[];
  count: number;
};

type ViewTab = "inbox" | "triage";
type MailAction = "archive" | "trash" | "read";

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function initial(name: string) {
  return (name.trim()[0] ?? "?").toUpperCase();
}

const QUICK_ACTIONS: TriageAction[] = [
  "respond",
  "read_and_archive",
  "delete_now",
  "unsubscribe",
  "act_today",
];

function primaryAction(action: TriageAction): MailAction {
  if (
    action === "delete_now" ||
    action === "unsubscribe" ||
    action === "read_and_delete"
  ) {
    return "trash";
  }
  if (action === "respond" || action === "act_today") return "read";
  return "archive";
}

function flattenInbox(data: TodayData): EmailItem[] {
  if (data.inbox?.length) {
    return [...data.inbox].sort(
      (a, b) =>
        new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
    );
  }
  const map = new Map<string, EmailItem>();
  for (const item of data.needsReview) map.set(item.id, item);
  for (const section of data.sections) {
    for (const item of section.items) map.set(item.id, item);
  }
  return [...map.values()].sort(
    (a, b) =>
      new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
  );
}

export function InboxApp() {
  const [tab, setTab] = useState<ViewTab>("inbox");
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [readerId, setReaderId] = useState<string | null>(null);
  const [reader, setReader] = useState<{
    htmlBody: string;
    textBody: string;
    subject: string;
    fromName: string;
    guide: Guide;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/today", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Load failed");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const inboxItems = useMemo(
    () => (data ? flattenInbox(data) : []),
    [data],
  );

  const removeFromState = useCallback((id: string) => {
    setData((prev) => {
      if (!prev) return prev;
      const filter = (items: EmailItem[]) => items.filter((i) => i.id !== id);
      return {
        ...prev,
        inbox: prev.inbox ? filter(prev.inbox) : prev.inbox,
        needsReview: filter(prev.needsReview),
        sections: prev.sections
          .map((s) => ({ ...s, items: filter(s.items) }))
          .filter((s) => s.items.length > 0),
        count: Math.max(0, prev.count - 1),
      };
    });
  }, []);

  const closeReader = useCallback(() => {
    setReaderId(null);
    setReader(null);
  }, []);

  const runAction = useCallback(
    async (id: string, action: MailAction) => {
      setBusyId(id);
      removeFromState(id);
      if (readerId === id) closeReader();
      try {
        const res = await fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, action }),
        });
        if (!res.ok) {
          const j = await res.json();
          throw new Error(j.error);
        }
        setToast(
          action === "trash"
            ? "Moved to trash"
            : action === "archive"
              ? "Archived"
              : "Marked read",
        );
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Action failed");
        load();
      } finally {
        setBusyId(null);
      }
    },
    [closeReader, load, readerId, removeFromState],
  );

  const bulkSection = useCallback(
    async (section: Section, action: MailAction) => {
      const ids = section.items.map((i) => i.id);
      setData((prev) => {
        if (!prev) return prev;
        const idSet = new Set(ids);
        const filter = (items: EmailItem[]) =>
          items.filter((i) => !idSet.has(i.id));
        return {
          ...prev,
          inbox: prev.inbox ? filter(prev.inbox) : prev.inbox,
          needsReview: filter(prev.needsReview),
          sections: prev.sections
            .map((s) =>
              s.action === section.action
                ? { ...s, items: [] }
                : {
                    ...s,
                    items: s.items.filter((i) => !idSet.has(i.id)),
                  },
            )
            .filter((s) => s.items.length > 0),
          count: Math.max(0, prev.count - ids.length),
        };
      });
      try {
        const res = await fetch("/api/action/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: ids.map((id) => ({ id, action })),
          }),
        });
        if (!res.ok) throw new Error("Bulk failed");
        setToast(
          action === "trash"
            ? `Deleted ${ids.length}`
            : action === "archive"
              ? `Archived ${ids.length}`
              : `Updated ${ids.length}`,
        );
      } catch {
        setToast("Bulk action partially failed — refreshing");
        load();
      }
    },
    [load],
  );

  const teachSender = useCallback(
    async (fromEmail: string, action: TriageAction) => {
      await fetch("/api/reclassify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromEmail, action }),
      });
      load();
    },
    [load],
  );

  const openReader = useCallback(async (id: string) => {
    setReaderId(id);
    setReader(null);
    try {
      const res = await fetch(`/api/messages/${id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setReader({
        htmlBody: json.message.htmlBody,
        textBody: json.message.textBody,
        subject: json.message.subject,
        fromName: json.message.fromName,
        guide: json.guide,
      });
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not open message");
      setReaderId(null);
    }
  }, []);

  if (readerId) {
    const g = reader?.guide;
    const safeHtml = reader?.htmlBody
      ? DOMPurify.sanitize(reader.htmlBody)
      : "";
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-[var(--bg)]">
        <header className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-3">
          <button
            type="button"
            onClick={closeReader}
            className="rounded-lg p-2 hover:bg-[var(--card)]"
            aria-label="Back"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">
              {reader?.fromName ?? "…"}
            </div>
            <div className="truncate text-xs text-[var(--muted)]">
              {reader?.subject}
            </div>
          </div>
        </header>
        {g ? (
          <div
            className="mx-3 mt-3 rounded-xl border px-4 py-3 text-sm"
            style={{ borderColor: g.color, backgroundColor: `${g.color}18` }}
          >
            <div className="font-semibold" style={{ color: g.color }}>
              {g.label}
            </div>
            <div className="mt-1 text-[var(--fg)]">{g.instruction}</div>
            {g.detail ? (
              <div className="mt-2 text-xs text-[var(--muted)]">{g.detail}</div>
            ) : null}
          </div>
        ) : null}
        <div className="flex-1 overflow-auto px-3 py-4">
          {!reader ? (
            <p className="text-sm text-[var(--muted)]">Loading…</p>
          ) : safeHtml ? (
            <div
              className="prose prose-sm max-w-none text-[var(--fg)] dark:prose-invert"
              dangerouslySetInnerHTML={{ __html: safeHtml }}
            />
          ) : (
            <pre className="whitespace-pre-wrap text-sm text-[var(--fg)]">
              {reader.textBody || reader.subject}
            </pre>
          )}
        </div>
        {reader && g ? (
          <footer className="flex gap-2 border-t border-[var(--border)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <button
              type="button"
              disabled={busyId === readerId}
              onClick={() => runAction(readerId, "archive")}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--card)] py-3 text-sm font-medium disabled:opacity-50"
            >
              <Archive className="h-4 w-4" /> Archive
            </button>
            <button
              type="button"
              disabled={busyId === readerId}
              onClick={() => runAction(readerId, "read")}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#1a73e8] py-3 text-sm font-medium text-white disabled:opacity-50"
            >
              <Mail className="h-4 w-4" /> Mark read
            </button>
            <button
              type="button"
              disabled={busyId === readerId}
              onClick={() => runAction(readerId, "trash")}
              className="flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
              aria-label="Delete"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </button>
          </footer>
        ) : null}
        {toast ? (
          <div className="fixed bottom-24 left-1/2 z-50 max-w-xs -translate-x-1/2 rounded-lg bg-zinc-900 px-4 py-2 text-xs text-white shadow-lg">
            {toast}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col bg-[var(--bg)] pb-24 text-[var(--fg)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)] px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Inbox Pilot</h1>
            <p className="text-xs text-[var(--muted)]">
              {data?.accountEmail ?? "Your inbox"}
              {data ? ` · ${data.count} messages` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded-lg p-2 hover:bg-[var(--card)] disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCw className={`h-5 w-5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div
          className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-[var(--card)] p-1"
          role="tablist"
          aria-label="Mailbox views"
        >
          <TabButton
            active={tab === "inbox"}
            onClick={() => setTab("inbox")}
            icon={<Inbox className="h-3.5 w-3.5" />}
            label="Inbox"
          />
          <TabButton
            active={tab === "triage"}
            onClick={() => setTab("triage")}
            icon={<ListFilter className="h-3.5 w-3.5" />}
            label="Triage"
          />
        </div>
        {data?.fetchedAt ? (
          <p className="mt-2 text-[10px] text-[var(--muted)]">
            Updated {formatTime(data.fetchedAt)}
          </p>
        ) : null}
      </header>

      <main className="flex-1 px-3 py-4">
        {error ? (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        ) : null}
        {loading && !data ? (
          <p className="py-8 text-center text-sm text-[var(--muted)]">
            Loading inbox…
          </p>
        ) : null}

        {tab === "inbox" && data ? (
          inboxItems.length === 0 ? (
            <p className="py-16 text-center text-sm text-[var(--muted)]">
              Inbox is empty.
            </p>
          ) : (
            <ul className="space-y-2">
              {inboxItems.map((item) => (
                <EmailRow
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  onOpen={() => openReader(item.id)}
                  onArchive={() => runAction(item.id, "archive")}
                  onDelete={() => runAction(item.id, "trash")}
                />
              ))}
            </ul>
          )
        ) : null}

        {tab === "triage" && data && data.count === 0 ? (
          <p className="py-16 text-center text-sm text-[var(--muted)]">
            Nothing to review. Inbox is clear.
          </p>
        ) : null}

        {tab === "triage" && data && data.needsReview.length > 0 ? (
          <section className="mb-6">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              Needs classification ({data.needsReview.length})
            </h2>
            <ul className="space-y-2">
              {data.needsReview.map((item) => (
                <EmailRow
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  onOpen={() => openReader(item.id)}
                  onArchive={() => runAction(item.id, "archive")}
                  onDelete={() => runAction(item.id, "trash")}
                  chips={
                    <div className="mt-2 flex flex-wrap gap-1">
                      {QUICK_ACTIONS.map((a) => (
                        <button
                          key={a}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            teachSender(item.fromEmail, a);
                          }}
                          className="rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                          style={{ backgroundColor: ACTION_META[a].color }}
                        >
                          {ACTION_META[a].short}
                        </button>
                      ))}
                    </div>
                  }
                />
              ))}
            </ul>
          </section>
        ) : null}

        {tab === "triage"
          ? data?.sections.map((section) => (
              <section key={section.action} className="mb-6">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2
                    className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide"
                    style={{ color: section.color }}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: section.color }}
                    />
                    {section.label} ({section.items.length})
                  </h2>
                  <button
                    type="button"
                    onClick={() =>
                      bulkSection(section, primaryAction(section.action))
                    }
                    className="text-[10px] font-medium text-[var(--muted)] underline"
                  >
                    {section.bulkLabel}
                  </button>
                </div>
                <ul className="space-y-2">
                  {section.items.map((item) => (
                    <EmailRow
                      key={item.id}
                      item={item}
                      busy={busyId === item.id}
                      onOpen={() => openReader(item.id)}
                      onArchive={() => runAction(item.id, "archive")}
                      onDelete={() => runAction(item.id, "trash")}
                    />
                  ))}
                </ul>
              </section>
            ))
          : null}
      </main>

      {toast ? (
        <div className="fixed bottom-24 left-1/2 z-50 max-w-xs -translate-x-1/2 rounded-lg bg-zinc-900 px-4 py-2 text-xs text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition-colors ${
        active
          ? "bg-[var(--bg)] text-[var(--fg)] shadow-sm"
          : "text-[var(--muted)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function EmailRow({
  item,
  onOpen,
  onArchive,
  onDelete,
  busy,
  chips,
}: {
  item: EmailItem;
  onOpen: () => void;
  onArchive: () => void;
  onDelete: () => void;
  busy?: boolean;
  chips?: ReactNode;
}) {
  const g = item.guide;
  return (
    <li>
      <article
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => e.key === "Enter" && onOpen()}
        className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-3 active:scale-[0.99]"
      >
        <div className="flex gap-3">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white ${
              item.isUnread ? "ring-2 ring-[#1a73e8] ring-offset-2 ring-offset-[var(--card)]" : ""
            }`}
            style={{ backgroundColor: g.color }}
          >
            {initial(item.fromName)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span
                className={`truncate text-[15px] ${
                  item.isUnread ? "font-bold" : "font-semibold"
                }`}
              >
                {item.fromName}
              </span>
              <span className="shrink-0 text-[11px] text-[var(--muted)]">
                {formatTime(item.receivedAt)}
              </span>
            </div>
            <div
              className={`truncate text-sm ${
                item.isUnread ? "font-medium" : ""
              }`}
            >
              {item.subject}
            </div>
            <div className="truncate text-[13px] text-[var(--muted)]">
              {item.snippet}
            </div>
            <div
              className="mt-2 rounded-lg px-2 py-1.5 text-xs font-medium leading-snug"
              style={{
                color: g.color,
                backgroundColor: `${g.color}14`,
              }}
            >
              {g.instruction}
            </div>
            {chips}
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onArchive();
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            <Archive className="h-3.5 w-3.5" />
            Archive
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      </article>
    </li>
  );
}
