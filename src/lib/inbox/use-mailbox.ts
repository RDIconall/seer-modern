"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TriageAction } from "@/lib/inbox/classify";
import type {
  MailAction,
  MailboxData,
  ReaderMessage,
  Section,
  TodayData,
  ViewTab,
} from "@/lib/inbox/types";
import type { ComposeDraft } from "@/components/inbox/ComposePanel";
import {
  buildCardDeck,
  ensureFwd,
  ensureRe,
  primaryMailAction,
} from "@/lib/inbox/types";

/**
 * Superhuman-style speed:
 * - stale-while-revalidate: last known data renders instantly from
 *   localStorage, the network refresh happens silently in the background
 * - prefetch: top message bodies are fetched before you tap them
 * - optimistic actions (already): the UI never waits for the server
 */

const CACHE_PREFIX = "seer:v1:";
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

type CacheEnvelope<T> = { accountEmail?: string; savedAt: number; data: T };

function readViewCache<T>(key: string, accountEmail?: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (Date.now() - parsed.savedAt > CACHE_MAX_AGE_MS) return null;
    // Never show another account's cached mail
    if (
      accountEmail &&
      parsed.accountEmail &&
      parsed.accountEmail !== accountEmail
    ) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function writeViewCache<T>(key: string, data: T, accountEmail?: string) {
  if (typeof window === "undefined") return;
  try {
    const envelope: CacheEnvelope<T> = {
      accountEmail,
      savedAt: Date.now(),
      data,
    };
    window.localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(envelope));
  } catch {
    /* storage full — skip */
  }
}

const PREFETCH_COUNT = 8;
const MESSAGE_CACHE_MAX = 30;

/** How long an acted-on message stays scrubbed from fresh list loads. */
const TOMBSTONE_MS = 3 * 60 * 1000;

// Gmail-style URL state: #inbox, #triage, #inbox/<messageId> … so the
// browser back/forward buttons navigate the app instead of leaving it,
// and a reload restores exactly where you were.
const HASH_TABS: ViewTab[] = ["inbox", "sent", "trash", "triage", "cards"];

function parseHash(): { tab?: ViewTab; id?: string } {
  if (typeof window === "undefined") return {};
  const [t, id] = window.location.hash.replace(/^#/, "").split("/");
  return {
    tab: HASH_TABS.includes(t as ViewTab) ? (t as ViewTab) : undefined,
    id: id || undefined,
  };
}

type ReaderPayload = {
  message: Record<string, unknown> & {
    htmlBody: string;
    textBody: string;
    subject: string;
    fromName: string;
    fromEmail: string;
    toEmail?: string;
    ccEmail?: string;
    threadId: string;
    messageIdHeader?: string;
    receivedAt?: string;
  };
  guide?: ReaderMessage["guide"];
  keyActions?: ReaderMessage["keyActions"];
  calendarEvent?: ReaderMessage["calendarEvent"];
};

export function useMailbox(initialTab: ViewTab = "inbox") {
  const [tab, setTab] = useState<ViewTab>(initialTab);
  const [triage, setTriage] = useState<TodayData | null>(null);
  const [mailbox, setMailbox] = useState<MailboxData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [readerId, setReaderId] = useState<string | null>(null);
  const [reader, setReader] = useState<ReaderMessage | null>(null);
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<{
    email: string;
    name: string;
    label: string;
  } | null>(null);

  const refreshIdentity = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) return;
      if (json.active?.email) {
        setIdentity({
          email: json.active.email,
          name: json.active.name ?? json.active.email,
          label: json.active.label ?? "Account",
        });
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshIdentity();
  }, [refreshIdentity]);

  const accountEmail =
    identity?.email ??
    mailbox?.accountEmail ??
    triage?.accountEmail ??
    "Your mailbox";
  const accountLabel = identity?.label ?? "";

  // Ref so cache reads don't retrigger load() when identity resolves
  const identityEmailRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    identityEmailRef.current = identity?.email;
  }, [identity?.email]);

  // Instant-sync tombstones: Gmail's list API lags a minute behind
  // modify calls, so a background refresh can resurrect mail you just
  // archived. Anything acted on recently is scrubbed from fresh loads.
  const acted = useRef(new Map<string, number>());
  const markActed = useCallback((id: string) => {
    acted.current.set(id, Date.now());
    if (acted.current.size > 500) {
      const cutoff = Date.now() - TOMBSTONE_MS;
      for (const [k, t] of acted.current) {
        if (t < cutoff) acted.current.delete(k);
      }
    }
  }, []);
  const scrub = useCallback(
    <T extends { id: string }>(arr: T[]): T[] =>
      arr.filter((i) => {
        const t = acted.current.get(i.id);
        return t == null || Date.now() - t > TOMBSTONE_MS;
      }),
    [],
  );

  const loadTriage = useCallback(async () => {
    const res = await fetch("/api/today", { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Load failed");
    const scrubbed: TodayData = {
      ...json,
      inbox: json.inbox ? scrub(json.inbox) : json.inbox,
      needsReview: scrub(json.needsReview ?? []),
      sections: (json.sections ?? [])
        .map((s: Section) => ({ ...s, items: scrub(s.items) }))
        .filter((s: Section) => s.items.length > 0),
    };
    setTriage(scrubbed);
  }, [scrub]);

  const loadMailbox = useCallback(
    async (folder: "inbox" | "sent" | "trash", q?: string) => {
      const params = new URLSearchParams({ folder });
      if (q?.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/mailbox?${params}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Load failed");
      // Trash may legitimately contain just-trashed mail — don't scrub it
      setMailbox(
        folder === "trash" ? json : { ...json, items: scrub(json.items ?? []) },
      );
    },
    [scrub],
  );

  // Persist views (including optimistic removals) for instant next paint
  useEffect(() => {
    if (!triage) return;
    writeViewCache("triage", triage, triage.accountEmail);
  }, [triage]);

  useEffect(() => {
    if (!mailbox || query.trim()) return;
    const folder = mailbox.folder;
    if (folder === "inbox" || folder === "sent" || folder === "trash") {
      writeViewCache(`mailbox:${folder}`, mailbox, mailbox.accountEmail);
    }
  }, [mailbox, query]);

  const load = useCallback(async () => {
    setError(null);

    // Stale-while-revalidate: paint the last known view instantly,
    // then refresh silently in the background.
    let hadCache = false;
    if (!query.trim()) {
      if (tab === "triage" || tab === "cards") {
        const cached = readViewCache<TodayData>(
          "triage",
          identityEmailRef.current,
        );
        if (cached) {
          setTriage(cached);
          hadCache = true;
        }
      } else {
        const cached = readViewCache<MailboxData>(
          `mailbox:${tab}`,
          identityEmailRef.current,
        );
        if (cached) {
          setMailbox(cached);
          hadCache = true;
        }
      }
    }
    setLoading(!hadCache);

    try {
      if (tab === "triage" || tab === "cards") await loadTriage();
      else await loadMailbox(tab, query);
    } catch (e) {
      // With a cached view on screen, fail silently rather than blanking it
      if (!hadCache) setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [loadMailbox, loadTriage, query, tab]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const listItems = useMemo(() => {
    if (tab === "triage") return [];
    return mailbox?.items ?? [];
  }, [mailbox, tab]);

  const removeFromLists = useCallback((id: string) => {
    setMailbox((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.filter((i) => i.id !== id),
            count: Math.max(0, prev.count - 1),
          }
        : prev,
    );
    setTriage((prev) => {
      if (!prev) return prev;
      const filter = <T extends { id: string }>(items: T[]) =>
        items.filter((i) => i.id !== id);
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
    async (id: string, action: MailAction, fromEmail?: string) => {
      setBusyId(id);
      markActed(id);
      removeFromLists(id);
      if (readerId === id) closeReader();
      try {
        const res = await fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, action, fromEmail }),
        });
        if (!res.ok) {
          const j = await res.json();
          throw new Error(j.error);
        }
        setToast(
          action === "trash"
            ? "Moved to Trash"
            : action === "archive"
              ? "Archived"
              : "Marked as read",
        );
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Action failed");
        load();
      } finally {
        setBusyId(null);
      }
    },
    [closeReader, load, markActed, readerId, removeFromLists],
  );

  /**
   * Snooze: purely local — the card/row disappears now and comes back
   * on the next refresh (no server call, nothing changes in the mailbox).
   */
  const snooze = useCallback(
    (id: string) => {
      removeFromLists(id);
      if (readerId === id) closeReader();
      setToast("Snoozed — back on next refresh");
    },
    [closeReader, readerId, removeFromLists],
  );

  /**
   * Delegate as a real action: openDelegate(id) pops the "to who?"
   * sheet; confirmDelegate has the AI write the handoff email
   * ("wanted to get your help doing …") as a ready-to-send forward.
   */
  const [delegateFor, setDelegateFor] = useState<{
    id: string;
    subject: string;
  } | null>(null);
  const [delegating, setDelegating] = useState(false);

  const openDelegate = useCallback(
    (id: string, subject?: string) => {
      setDelegateFor({ id, subject: subject ?? "" });
    },
    [],
  );

  const closeDelegate = useCallback(() => setDelegateFor(null), []);

  const confirmDelegate = useCallback(
    async (recipient: { to: string; toName?: string; instruction?: string }) => {
      if (!delegateFor || delegating) return;
      setDelegating(true);
      try {
        const res = await fetch("/api/assist/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: delegateFor.id,
            intent: "delegate",
            ...recipient,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Draft failed");
        setCompose({
          mode: "forward",
          to: json.to || recipient.to,
          cc: "",
          subject: json.subject,
          body: json.body,
          replyToId: json.replyToId,
          archiveOriginal: true,
        });
        setDelegateFor(null);
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Delegate failed");
      } finally {
        setDelegating(false);
      }
    },
    [delegateFor, delegating],
  );

  const bulkSection = useCallback(
    async (section: Section, action: MailAction) => {
      const ids = section.items.map((i) => i.id);
      ids.forEach(markActed);
      setTriage((prev) => {
        if (!prev) return prev;
        const idSet = new Set(ids);
        const filter = <T extends { id: string }>(items: T[]) =>
          items.filter((i) => !idSet.has(i.id));
        return {
          ...prev,
          inbox: prev.inbox ? filter(prev.inbox) : prev.inbox,
          needsReview: filter(prev.needsReview),
          sections: prev.sections
            .map((s) =>
              s.action === section.action
                ? { ...s, items: [] }
                : { ...s, items: s.items.filter((i) => !idSet.has(i.id)) },
            )
            .filter((s) => s.items.length > 0),
          count: Math.max(0, prev.count - ids.length),
        };
      });
      try {
        // The unsubscribe section actually unsubscribes (one-click /
        // mailto), then trashes and teaches the sender — not just trash.
        if (section.action === "unsubscribe") {
          const res = await fetch("/api/unsubscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: section.items.map((i) => ({
                id: i.id,
                fromEmail: i.fromEmail,
              })),
            }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error ?? "Unsubscribe failed");
          setToast(
            json.unsubscribed > 0
              ? `Unsubscribed from ${json.unsubscribed} of ${ids.length} · all trashed & muted`
              : `Trashed ${ids.length} · senders muted`,
          );
          return;
        }

        const res = await fetch("/api/action/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: section.items.map((i) => ({
              id: i.id,
              action,
              fromEmail: i.fromEmail,
            })),
          }),
        });
        if (!res.ok) throw new Error("Bulk failed");
        setToast(`Updated ${ids.length}`);
      } catch {
        setToast("Bulk action failed — refreshing");
        load();
      }
    },
    [load, markActed],
  );

  /** Multi-select: one action over any set of picked emails. */
  const runBulk = useCallback(
    async (
      picked: { id: string; fromEmail?: string }[],
      action: MailAction,
    ) => {
      if (picked.length === 0) return;
      for (const p of picked) {
        markActed(p.id);
        removeFromLists(p.id);
      }
      try {
        const res = await fetch("/api/action/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: picked.map((p) => ({
              id: p.id,
              action,
              fromEmail: p.fromEmail,
            })),
          }),
        });
        if (!res.ok) throw new Error("Bulk failed");
        setToast(
          action === "trash"
            ? `Deleted ${picked.length}`
            : action === "archive"
              ? `Archived ${picked.length}`
              : `Marked ${picked.length} read`,
        );
      } catch {
        setToast("Bulk action failed — refreshing");
        load();
      }
    },
    [load, markActed, removeFromLists],
  );

  /** Unsubscribe a single message for real, then trash + mute sender. */
  const unsubscribe = useCallback(
    async (id: string, fromEmail?: string) => {
      markActed(id);
      removeFromLists(id);
      if (readerId === id) closeReader();
      try {
        const res = await fetch("/api/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, fromEmail }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Unsubscribe failed");
        if (json.links?.length) {
          // No machine-readable path — one tap on the list's own page
          window.open(json.links[0].url, "_blank", "noopener");
          setToast("Opened the unsubscribe page — email trashed & sender muted");
        } else if (json.unsubscribed > 0) {
          setToast("Unsubscribed — email trashed & sender muted");
        } else {
          setToast("No unsubscribe link — trashed & sender muted instead");
        }
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Unsubscribe failed");
        load();
      }
    },
    [closeReader, load, markActed, readerId, removeFromLists],
  );

  /**
   * Correct / train Seer: saves a taught override (top of the
   * precedence chain — beats Gemini, labels, everything, forever) and
   * applies the correction to THIS email right now. Teaching
   * "unsubscribe" actually unsubscribes.
   */
  const teachSender = useCallback(
    async (fromEmail: string, action: TriageAction, messageId?: string) => {
      await fetch("/api/reclassify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromEmail, action }),
      }).catch(() => {});

      if (messageId && action === "unsubscribe") {
        await unsubscribe(messageId, fromEmail);
        return;
      }
      if (messageId) {
        const apply = primaryMailAction(action);
        if (apply === "trash" || apply === "archive") {
          await runAction(messageId, apply, fromEmail);
          setToast(
            `Taught — "${fromEmail.split("@")[1] ?? fromEmail}" is always ${apply === "trash" ? "deleted" : "archived"} now`,
          );
          return;
        }
      }
      setToast(`Taught — that sender is corrected from now on`);
      load();
    },
    [load, runAction, unsubscribe],
  );

  // ---- Superhuman-style prefetch: bodies are ready before you tap ----

  const messageCache = useRef(new Map<string, ReaderPayload>());
  const inflight = useRef(new Set<string>());

  const toReaderMessage = (json: ReaderPayload): ReaderMessage => ({
    htmlBody: json.message.htmlBody,
    textBody: json.message.textBody,
    subject: json.message.subject,
    fromName: json.message.fromName,
    fromEmail: json.message.fromEmail,
    toEmail: json.message.toEmail ?? "",
    ccEmail: json.message.ccEmail ?? "",
    threadId: json.message.threadId,
    messageIdHeader: json.message.messageIdHeader ?? "",
    receivedAt: json.message.receivedAt,
    guide: json.guide,
    keyActions: json.keyActions,
    calendarEvent: json.calendarEvent,
  });

  const fetchMessage = useCallback(
    async (id: string): Promise<ReaderPayload | null> => {
      const cached = messageCache.current.get(id);
      if (cached) return cached;
      if (inflight.current.has(id)) return null;
      inflight.current.add(id);
      try {
        const res = await fetch(`/api/messages/${id}`);
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? "Could not load message");
        }
        const json = (await res.json()) as ReaderPayload;
        messageCache.current.set(id, json);
        // Evict oldest beyond cap (Map preserves insertion order)
        while (messageCache.current.size > MESSAGE_CACHE_MAX) {
          const oldest = messageCache.current.keys().next().value;
          if (oldest == null) break;
          messageCache.current.delete(oldest);
        }
        return json;
      } finally {
        inflight.current.delete(id);
      }
    },
    [],
  );

  // Warm the top of the visible list in the background, staggered
  useEffect(() => {
    const items =
      tab === "triage" || tab === "cards"
        ? buildCardDeck(triage)
        : (mailbox?.items ?? []);
    const top = items
      .slice(0, PREFETCH_COUNT)
      .filter((i) => !messageCache.current.has(i.id));
    if (top.length === 0) return;
    const timers = top.map((item, idx) =>
      setTimeout(() => {
        fetchMessage(item.id).catch(() => {});
      }, 350 + idx * 200),
    );
    return () => timers.forEach(clearTimeout);
  }, [triage, mailbox, tab, fetchMessage]);

  const openReader = useCallback(
    async (id: string) => {
      setReaderId(id);
      const cached = messageCache.current.get(id);
      if (cached) {
        // Instant open — body was prefetched
        setReader(toReaderMessage(cached));
        return;
      }
      setReader(null);
      try {
        let json = await fetchMessage(id);
        if (!json) {
          // A prefetch is already in flight — wait for it to land
          for (let i = 0; i < 40 && !json; i++) {
            await new Promise((r) => setTimeout(r, 150));
            json = messageCache.current.get(id) ?? null;
            if (!json && !inflight.current.has(id)) {
              json = await fetchMessage(id);
              break;
            }
          }
        }
        if (!json) throw new Error("Could not load message");
        setReader(toReaderMessage(json));
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Could not open message");
        setReaderId(null);
      }
    },
    [fetchMessage],
  );

  // ---- Gmail-style history: #inbox, #triage, #inbox/<id> ----
  // Back/forward navigate the app (close reader, previous tab) instead
  // of leaving it, and a reload restores exactly where you were.
  const hashReady = useRef(false);

  useEffect(() => {
    const { tab: hTab, id } = parseHash();
    if (hTab) setTab(hTab);
    if (id) openReader(id);
    hashReady.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hashReady.current || typeof window === "undefined") return;
    const desired = readerId ? `${tab}/${readerId}` : tab;
    if (window.location.hash.replace(/^#/, "") !== desired) {
      window.location.hash = desired;
    }
  }, [tab, readerId]);

  useEffect(() => {
    const onHashChange = () => {
      const { tab: hTab, id } = parseHash();
      if (hTab && hTab !== tab) setTab(hTab);
      if (id && id !== readerId) openReader(id);
      else if (!id && readerId) closeReader();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [tab, readerId, openReader, closeReader]);

  const startCompose = useCallback(() => {
    setCompose({
      mode: "compose",
      to: "",
      cc: "",
      subject: "",
      body: "",
    });
  }, []);

  const [drafting, setDrafting] = useState(false);

  /** One-tap AI reply (or EA handoff): Gemini pre-fills compose. */
  const draftReply = useCallback(
    async (intent?: "yes" | "no" | "later" | "delegate") => {
      if (!readerId || drafting) return;
      setDrafting(true);
      try {
        const res = await fetch("/api/assist/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: readerId, intent }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Draft failed");
        setCompose({
          mode: json.mode === "forward" ? "forward" : "reply",
          to: json.to,
          cc: "",
          subject: json.subject,
          body: json.body,
          replyToId: json.replyToId,
        });
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Draft failed");
      } finally {
        setDrafting(false);
      }
    },
    [readerId, drafting],
  );

  const [rsvping, setRsvping] = useState(false);

  /** One-tap calendar RSVP — answers the event and archives the invite. */
  const rsvp = useCallback(
    async (response: "accepted" | "declined" | "tentative") => {
      const ev = reader?.calendarEvent;
      if (!ev || !readerId || rsvping) return;
      setRsvping(true);
      try {
        const res = await fetch("/api/calendar/rsvp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventId: ev.id,
            response,
            messageId: readerId,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "RSVP failed");
        messageCache.current.delete(readerId);
        markActed(readerId);
        removeFromLists(readerId);
        closeReader();
        setToast(
          response === "accepted"
            ? "Accepted — invite archived"
            : response === "declined"
              ? "Declined — invite archived"
              : "Maybe — invite archived",
        );
      } catch (e) {
        setToast(e instanceof Error ? e.message : "RSVP failed");
      } finally {
        setRsvping(false);
      }
    },
    [reader, readerId, rsvping, markActed, removeFromLists, closeReader],
  );

  const startReply = useCallback(
    (mode: "reply" | "replyAll" | "forward") => {
      if (!reader || !readerId) return;
      if (mode === "forward") {
        setCompose({
          mode: "forward",
          to: "",
          cc: "",
          subject: ensureFwd(reader.subject),
          body: "",
          replyToId: readerId,
        });
        return;
      }
      setCompose({
        mode,
        to: reader.fromEmail,
        cc: mode === "replyAll" ? reader.ccEmail : "",
        subject: ensureRe(reader.subject),
        body: "",
        replyToId: readerId,
      });
    },
    [reader, readerId],
  );

  const selectFolder = useCallback((next: ViewTab) => {
    setTab(next);
    setQuery("");
    setSearch("");
  }, []);

  const submitSearch = useCallback(() => {
    setQuery(search.trim());
    if (tab === "triage" || tab === "cards") setTab("inbox");
  }, [search, tab]);

  return {
    tab,
    setTab,
    selectFolder,
    triage,
    mailbox,
    listItems,
    error,
    loading,
    search,
    setSearch,
    query,
    setQuery,
    submitSearch,
    readerId,
    reader,
    compose,
    setCompose,
    toast,
    setToast,
    busyId,
    accountEmail,
    accountLabel,
    identity,
    refreshIdentity,
    load,
    runAction,
    snooze,
    delegateFor,
    delegating,
    openDelegate,
    closeDelegate,
    confirmDelegate,
    bulkSection,
    runBulk,
    unsubscribe,
    teachSender,
    openReader,
    closeReader,
    startCompose,
    startReply,
    draftReply,
    drafting,
    rsvp,
    rsvping,
  };
}
