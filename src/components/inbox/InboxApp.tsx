"use client";

import DOMPurify from "isomorphic-dompurify";
import {
  Archive,
  ChevronLeft,
  Mail,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
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
  needsReview: EmailItem[];
  sections: Section[];
  count: number;
};

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

export function InboxApp() {
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

  const removeFromState = useCallback((id: string) => {
    setData((prev) => {
      if (!prev) return prev;
      const filter = (items: EmailItem[]) =>
        items.filter((i) => i.id !== id);
      return {
        ...prev,
        needsReview: filter(prev.needsReview),
        sections: prev.sections
          .map((s) => ({ ...s, items: filter(s.items) }))
          .filter((s) => s.items.length > 0),
        count: prev.count - 1,
      };
    });
  }, []);

  const runAction = useCallback(
    async (id: string, action: "archive" | "trash" | "read") => {
      removeFromState(id);
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
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Action failed");
        load();
      }
    },
    [load, removeFromState],
  );

  const bulkSection = useCallback(
    async (section: Section, action: "archive" | "trash" | "read") => {
      const ids = section.items.map((i) => i.id);
      setData((prev) => {
        if (!prev) return prev;
        const idSet = new Set(ids);
        return {
          ...prev,
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
        };
      });
      try {
        await fetch("/api/action/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: ids.map((id) => ({ id, action })),
          }),
        });
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

  const primaryAction = (action: TriageAction): "archive" | "trash" | "read" => {
    if (action === "delete_now" || action === "unsubscribe") return "trash";
    if (action === "respond" || action === "act_today") return "read";
    return "archive";
  };

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
            onClick={() => {
              setReaderId(null);
              setReader(null);
            }}
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
              onClick={() => runAction(readerId, "archive")}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--card)] py-3 text-sm font-medium"
            >
              <Archive className="h-4 w-4" /> Archive
            </button>
            <button
              type="button"
              onClick={() => runAction(readerId, "read")}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#1a73e8] py-3 text-sm font-medium text-white"
            >
              <Mail className="h-4 w-4" /> Mark read
            </button>
            <button
              type="button"
              onClick={() => runAction(readerId, "trash")}
              className="flex items-center justify-center rounded-xl bg-red-600/15 px-4 py-3 text-red-500"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </footer>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-lg bg-[var(--bg)] pb-24 text-[var(--fg)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)] px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Inbox Pilot</h1>
            <p className="text-xs text-[var(--muted)]">
              {data?.accountEmail ?? "Your inbox"}
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
        {data?.fetchedAt ? (
          <p className="mt-1 text-[10px] text-[var(--muted)]">
            Updated {formatTime(data.fetchedAt)}
          </p>
        ) : null}
      </header>

      <main className="px-3 py-4">
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
        {data && data.count === 0 ? (
          <p className="py-16 text-center text-sm text-[var(--muted)]">
            Nothing to review. Inbox is clear.
          </p>
        ) : null}

        {data && data.needsReview.length > 0 ? (
          <section className="mb-6">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              Needs classification ({data.needsReview.length})
            </h2>
            <ul className="space-y-2">
              {data.needsReview.map((item) => (
                <EmailRow
                  key={item.id}
                  item={item}
                  onOpen={() => openReader(item.id)}
                  onPrimary={() =>
                    runAction(item.id, primaryAction(item.guide.action))
                  }
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

        {data?.sections.map((section) => (
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
                  onOpen={() => openReader(item.id)}
                  onPrimary={() =>
                    runAction(item.id, primaryAction(item.guide.action))
                  }
                />
              ))}
            </ul>
          </section>
        ))}
      </main>

      {toast ? (
        <div className="fixed bottom-24 left-1/2 z-50 max-w-xs -translate-x-1/2 rounded-lg bg-red-900 px-4 py-2 text-xs text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function EmailRow({
  item,
  onOpen,
  onPrimary,
  chips,
}: {
  item: EmailItem;
  onOpen: () => void;
  onPrimary: () => void;
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
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
            style={{ backgroundColor: g.color }}
          >
            {initial(item.fromName)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[15px] font-semibold">
                {item.fromName}
              </span>
              <span className="shrink-0 text-[11px] text-[var(--muted)]">
                {formatTime(item.receivedAt)}
              </span>
            </div>
            <div className="truncate text-sm">{item.subject}</div>
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
            {g.confidence === "MED" ? (
              <span className="mt-1 inline-block text-[10px] text-[var(--muted)]">
                rule
              </span>
            ) : null}
            {chips}
          </div>
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPrimary();
            }}
            className="rounded-lg px-3 py-1 text-xs font-medium text-white"
            style={{ backgroundColor: g.color }}
          >
            Done
          </button>
        </div>
      </article>
    </li>
  );
}
