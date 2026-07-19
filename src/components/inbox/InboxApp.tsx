"use client";

import DOMPurify from "isomorphic-dompurify";
import {
  Archive,
  Ban,
  ChevronLeft,
  Mail,
  OctagonX,
  RefreshCw,
  Reply,
  Trash2,
} from "lucide-react";
import Image from "next/image";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ACTION_META,
  type TriageAction,
} from "@/lib/inbox/classify";
import { splitSentences } from "@/lib/nlp/sentences";

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

function firstName(name: string) {
  const word = name.trim().split(/\s+/)[0] ?? "";
  return word.replace(/[<>"',]/g, "") || "them";
}

/** Task phrased as a question — the original Seer card headline. */
function headline(action: TriageAction, fromName: string): string {
  switch (action) {
    case "respond":
      return `Reply to ${firstName(fromName)}?`;
    case "act_today":
      return "Act on this today?";
    case "read_and_archive":
      return "Read, then archive?";
    case "read_and_delete":
      return "Skim, then delete?";
    case "delete_now":
      return "Delete without reading?";
    case "unsubscribe": {
      const name = fromName.trim() || "this sender";
      return `Unsubscribe from ${name.length > 28 ? `${name.slice(0, 26)}…` : name}?`;
    }
    case "review_subscription":
      return "Check this charge?";
    case "glance_promo":
      return "Glance, then archive?";
    case "needs_review":
      return "What should Seer do?";
  }
}

/** The key sentence from the email, shown big like the old pull-quote. */
function pullQuote(snippet: string): string | null {
  const sentences = splitSentences(snippet);
  if (sentences.length === 0) return null;
  const question = sentences.find((s) => s.endsWith("?"));
  const pick = question ?? sentences[0];
  const clean = pick.replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, "").trim();
  if (clean.length < 8) return null;
  return clean.length > 90 ? `${clean.slice(0, 87)}…` : clean;
}

/** Actions whose cards get the full hero treatment (pull quote). */
const HERO_ACTIONS: TriageAction[] = ["respond", "act_today", "needs_review"];

const QUICK_ACTIONS: TriageAction[] = [
  "respond",
  "read_and_archive",
  "delete_now",
  "unsubscribe",
  "act_today",
];

const SWIPE_DISMISS_PX = 96;

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

  const snooze = useCallback(
    (id: string) => {
      runAction(id, "archive");
      setToast("Snoozed — archived for now");
      setTimeout(() => setToast(null), 2000);
    },
    [runAction],
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
        <header className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--card)] px-3 py-3">
          <button
            type="button"
            onClick={() => {
              setReaderId(null);
              setReader(null);
            }}
            className="rounded-lg p-2 hover:bg-[var(--bg)]"
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
            className="mx-3 mt-3 rounded-xl px-4 py-3 text-sm"
            style={{
              backgroundColor: `${g.color}16`,
              border: `1px solid ${g.color}55`,
            }}
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
          <footer className="flex gap-2 border-t border-[var(--border)] bg-[var(--card)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <button
              type="button"
              onClick={() => runAction(readerId, "archive")}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--bg)] py-3 text-sm font-semibold"
            >
              <Archive className="h-4 w-4" /> Archive
            </button>
            <button
              type="button"
              onClick={() => runAction(readerId, "read")}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3 text-sm font-semibold text-white"
            >
              <Mail className="h-4 w-4" /> Mark read
            </button>
            <button
              type="button"
              onClick={() => runAction(readerId, "trash")}
              className="flex items-center justify-center rounded-xl bg-[#d63b2f]/15 px-4 py-3 text-[#d63b2f]"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </footer>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-lg pb-24 text-[var(--fg)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--card)] px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Image
              src="/seer-mark.png"
              alt=""
              width={34}
              height={34}
              priority
            />
            <div>
              <h1 className="text-lg font-bold uppercase tracking-[0.18em] text-[var(--muted)]">
                Seer
              </h1>
              <p className="text-xs text-[var(--faint)]">
                {data?.accountEmail ?? "Your inbox"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded-lg p-2 text-[var(--muted)] hover:bg-[var(--bg)] disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCw className={`h-5 w-5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        {data?.fetchedAt ? (
          <p className="mt-1 text-[10px] text-[var(--faint)]">
            Updated {formatTime(data.fetchedAt)}
          </p>
        ) : null}
      </header>

      <main className="px-3 py-4">
        {error ? (
          <p className="rounded-lg border border-[#d63b2f]/40 bg-[#d63b2f]/10 px-3 py-2 text-sm text-[#d63b2f]">
            {error}
          </p>
        ) : null}
        {loading && !data ? (
          <div className="flex flex-col items-center gap-3 py-16">
            <Image
              src="/seer-mark.png"
              alt=""
              width={48}
              height={48}
              className="animate-pulse"
            />
            <p className="text-sm text-[var(--muted)]">Reading your inbox…</p>
          </div>
        ) : null}
        {data && data.count === 0 ? (
          <p className="py-16 text-center text-sm text-[var(--muted)]">
            Nothing to review. Inbox is clear.
          </p>
        ) : null}

        {data && data.needsReview.length > 0 ? (
          <section className="mb-6">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Needs classification ({data.needsReview.length})
            </h2>
            <ul className="space-y-3">
              {data.needsReview.map((item) => (
                <EmailCard
                  key={item.id}
                  item={item}
                  onOpen={() => openReader(item.id)}
                  onArchive={() => runAction(item.id, "archive")}
                  onTrash={() => runAction(item.id, "trash")}
                  onSnooze={() => snooze(item.id)}
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
                          className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
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
                className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide"
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
                className="text-[10px] font-semibold text-[var(--muted)] underline"
              >
                {section.bulkLabel}
              </button>
            </div>
            <ul className="space-y-3">
              {section.items.map((item) => (
                <EmailCard
                  key={item.id}
                  item={item}
                  onOpen={() => openReader(item.id)}
                  onArchive={() => runAction(item.id, "archive")}
                  onTrash={() => runAction(item.id, "trash")}
                  onSnooze={() => snooze(item.id)}
                />
              ))}
            </ul>
          </section>
        ))}

        {data && data.count > 0 ? (
          <p className="pb-2 pt-1 text-center text-xs text-[var(--faint)]">
            Swipe a card away to snooze
          </p>
        ) : null}
      </main>

      {toast ? (
        <div className="fixed bottom-24 left-1/2 z-50 max-w-xs -translate-x-1/2 rounded-lg bg-[#1e242b] px-4 py-2 text-xs text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function EmailCard({
  item,
  onOpen,
  onArchive,
  onTrash,
  onSnooze,
  chips,
}: {
  item: EmailItem;
  onOpen: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onSnooze: () => void;
  chips?: ReactNode;
}) {
  const g = item.guide;
  const hero = HERO_ACTIONS.includes(g.action);
  const quote = hero ? pullQuote(item.snippet) : null;

  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const drag = useRef<{ startX: number; startY: number; active: boolean }>({
    startX: 0,
    startY: 0,
    active: false,
  });
  const dxRef = useRef(0);
  const moved = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag.current = { startX: e.clientX, startY: e.clientY, active: true };
    dxRef.current = 0;
    moved.current = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current.active || leaving) return;
    const deltaX = e.clientX - drag.current.startX;
    const deltaY = e.clientY - drag.current.startY;
    if (!moved.current) {
      if (Math.abs(deltaX) < 10 || Math.abs(deltaX) < Math.abs(deltaY)) return;
      moved.current = true;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* pointer may already be gone */
      }
    }
    dxRef.current = deltaX;
    setDx(deltaX);
  };

  const endDrag = () => {
    if (!drag.current.active) return;
    drag.current.active = false;
    const finalDx = dxRef.current;
    if (Math.abs(finalDx) > SWIPE_DISMISS_PX) {
      setLeaving(true);
      setDx(finalDx > 0 ? 600 : -600);
      setTimeout(onSnooze, 180);
    } else {
      dxRef.current = 0;
      setDx(0);
    }
  };

  const stop = (e: React.MouseEvent, fn: () => void) => {
    e.stopPropagation();
    fn();
  };

  return (
    <li className="overflow-hidden">
      <article
        role="button"
        tabIndex={0}
        onClick={() => {
          if (!moved.current) onOpen();
        }}
        onKeyDown={(e) => e.key === "Enter" && onOpen()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="touch-pan-y select-none rounded-xl bg-[var(--card)] px-4 pb-2 pt-3"
        style={{
          boxShadow: "var(--card-shadow)",
          transform: `translateX(${dx}px) rotate(${dx / 60}deg)`,
          opacity: leaving ? 0 : 1 - Math.min(Math.abs(dx) / 400, 0.4),
          transition: drag.current.active
            ? "none"
            : "transform 180ms ease, opacity 180ms ease",
        }}
      >
        <h3 className="text-xl font-semibold leading-tight text-[var(--faint)]">
          {headline(g.action, item.fromName)}
        </h3>

        <div className="mt-2.5 flex items-center gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white"
            style={{ backgroundColor: g.color }}
          >
            {initial(item.fromName)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[15px] font-semibold">
                {item.subject || item.fromName}
              </span>
              <span className="shrink-0 text-[11px] text-[var(--faint)]">
                {formatTime(item.receivedAt)}
              </span>
            </div>
            <div className="truncate text-[13px] text-[var(--muted)]">
              {item.fromName}
            </div>
          </div>
        </div>

        {quote ? (
          <blockquote className="mt-3 border-t border-[var(--border)] pt-3">
            <p className="text-lg font-bold leading-snug">
              <span className="mr-1 text-[var(--faint)]">&ldquo;</span>
              {quote}
              <span className="ml-1 text-[var(--faint)]">&rdquo;</span>
            </p>
          </blockquote>
        ) : (
          <p className="mt-2 truncate text-[13px] text-[var(--muted)]">
            {item.snippet}
          </p>
        )}

        <p
          className="mt-2 text-xs font-semibold leading-snug"
          style={{ color: g.color }}
        >
          {g.instruction}
          {g.confidence === "MED" ? (
            <span className="ml-1.5 font-normal text-[var(--faint)]">rule</span>
          ) : null}
        </p>
        {chips}

        <div className="mt-2.5 flex items-stretch justify-around border-t border-[var(--border)] pt-1">
          <button
            type="button"
            onClick={(e) => stop(e, onArchive)}
            className="rounded-lg px-6 py-2.5 text-[var(--primary)] hover:bg-[var(--bg)]"
            aria-label="Ignore — archive"
          >
            <Ban className="h-5 w-5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={(e) => stop(e, onTrash)}
            className="rounded-lg px-6 py-2.5 text-[var(--primary)] hover:bg-[var(--bg)]"
            aria-label="Delete"
          >
            <Trash2 className="h-5 w-5" strokeWidth={1.75} />
          </button>
          {g.action === "unsubscribe" ? (
            <button
              type="button"
              onClick={(e) => stop(e, onTrash)}
              className="rounded-lg px-6 py-2.5 text-[var(--primary)] hover:bg-[var(--bg)]"
              aria-label="Unsubscribe and delete"
            >
              <OctagonX className="h-5 w-5" strokeWidth={1.75} />
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => stop(e, onOpen)}
              className="rounded-lg px-6 py-2.5 text-[var(--primary)] hover:bg-[var(--bg)]"
              aria-label="Open and reply"
            >
              <Reply className="h-5 w-5" strokeWidth={1.75} />
            </button>
          )}
        </div>
      </article>
    </li>
  );
}
