"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { ensureFwd, ensureRe } from "@/lib/inbox/types";

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

  const loadTriage = useCallback(async () => {
    const res = await fetch("/api/today", { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Load failed");
    setTriage(json);
  }, []);

  const loadMailbox = useCallback(
    async (folder: "inbox" | "sent" | "trash", q?: string) => {
      const params = new URLSearchParams({ folder });
      if (q?.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/mailbox?${params}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Load failed");
      setMailbox(json);
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === "triage" || tab === "cards") await loadTriage();
      else await loadMailbox(tab, query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
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
    [closeReader, load, readerId, removeFromLists],
  );

  const bulkSection = useCallback(
    async (section: Section, action: MailAction) => {
      const ids = section.items.map((i) => i.id);
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
        fromEmail: json.message.fromEmail,
        toEmail: json.message.toEmail ?? "",
        ccEmail: json.message.ccEmail ?? "",
        threadId: json.message.threadId,
        messageIdHeader: json.message.messageIdHeader ?? "",
        receivedAt: json.message.receivedAt,
        guide: json.guide,
      });
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not open message");
      setReaderId(null);
    }
  }, []);

  const startCompose = useCallback(() => {
    setCompose({
      mode: "compose",
      to: "",
      cc: "",
      subject: "",
      body: "",
    });
  }, []);

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
    bulkSection,
    teachSender,
    openReader,
    closeReader,
    startCompose,
    startReply,
  };
}
