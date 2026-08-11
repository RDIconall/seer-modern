"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type { MailboxFolder, MailboxRow, MailboxView } from "@/lib/v3/mailbox/types";

const CACHE_VERSION = 1;
const mailboxCache = new Map<MailboxFolder, MailboxView>();
const bodyCache = new Map<string, unknown>();

function cacheKey(folder: MailboxFolder): string {
  return `seer.v3.mailbox.${CACHE_VERSION}.${folder}`;
}

function readCache(folder: MailboxFolder): MailboxView | null {
  const memory = mailboxCache.get(folder);
  if (memory) return memory;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(folder));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MailboxView;
    if (parsed.folder !== folder || !Array.isArray(parsed.rows)) return null;
    mailboxCache.set(folder, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(view: MailboxView): void {
  mailboxCache.set(view.folder, view);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(cacheKey(view.folder), JSON.stringify(view));
  } catch {
    // A full or disabled browser cache must never block the mailbox.
  }
}

function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export type MailboxHookOptions = {
  initialView?: MailboxView;
  disabled?: boolean;
};

export type MailboxState = {
  view: MailboxView | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  reload: () => Promise<void>;
  prefetchBody: (conversationId: string) => void;
  dispatch: (command: Command) => Promise<CommandResult>;
};

/**
 * Folder data is deliberately cache-first. A previous view paints immediately,
 * then the corpus is revalidated in the background; no UI path waits for a
 * provider or the brain before showing a row.
 */
export function useMailbox(
  folder: MailboxFolder,
  options: MailboxHookOptions = {},
): MailboxState {
  const initial = useMemo(
    () => options.initialView ?? readCache(folder),
    [folder, options.initialView],
  );
  const [view, setView] = useState<MailboxView | null>(initial);
  const [loading, setLoading] = useState(!initial);
  const [refreshing, setRefreshing] = useState(Boolean(initial));
  const [error, setError] = useState<string | null>(null);
  const viewRef = useRef<MailboxView | null>(initial);

  useEffect(() => {
    if (initial) {
      viewRef.current = initial;
      setView(initial);
      setLoading(false);
      setRefreshing(Boolean(!options.disabled && initial));
    }
  }, [initial, options.disabled]);

  const reload = useCallback(async () => {
    if (options.disabled) return;
    setRefreshing(true);
    setLoading(true);
    try {
      const response = await fetch(
        `/api/v3/mailbox?folder=${encodeURIComponent(folder)}&limit=50`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`mailbox ${response.status}`);
      const json = (await response.json()) as { view: MailboxView };
      writeCache(json.view);
      viewRef.current = json.view;
      setView(json.view);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to load mailbox");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [folder, options.disabled]);

  useEffect(() => {
    void reload();
    if (options.disabled) return;
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [options.disabled, reload]);

  const prefetchBody = useCallback((conversationId: string) => {
    if (bodyCache.has(conversationId)) return;
    bodyCache.set(conversationId, true);
    const run = () => {
      void fetch(`/api/v3/conversations/${encodeURIComponent(conversationId)}`, {
        cache: "force-cache",
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("body prefetch failed");
          bodyCache.set(conversationId, await response.json());
        })
        .catch(() => {
          bodyCache.delete(conversationId);
        });
    };
    const idle = (
      window as Window & {
        requestIdleCallback?: (
          callback: () => void,
          options?: { timeout?: number },
        ) => number;
      }
    ).requestIdleCallback;
    if (idle) {
      idle(run, { timeout: 700 });
    } else {
      globalThis.setTimeout(run, 0);
    }
  }, []);

  const dispatch = useCallback(
    async (command: Command): Promise<CommandResult> => {
      const previous = viewRef.current;
      if (
        previous &&
        (command.type === "archive" || command.type === "restore" || command.type === "markUnread")
      ) {
        const optimistic: MailboxView = {
          ...previous,
          rows:
            command.type === "markUnread"
              ? previous.rows.map((row) =>
                  row.conversationId === command.conversationId
                    ? { ...row, isUnread: true }
                    : row,
                )
              : previous.rows.filter((row) => row.conversationId !== command.conversationId),
          total:
            command.type === "markUnread"
              ? previous.total
              : Math.max(0, previous.total - 1),
        };
        viewRef.current = optimistic;
        setView(optimistic);
      }
      try {
        const response = await fetch("/api/v2/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command, idempotencyKey: idempotencyKey() }),
        });
        const json = (await response.json()) as { result?: CommandResult };
        const result = json.result;
        if (!response.ok || !result?.ok) {
          throw new Error(result?.error ?? `command ${response.status}`);
        }
        await reload();
        return result;
      } catch (cause) {
        if (previous) {
          viewRef.current = previous;
          setView(previous);
        }
        throw cause;
      }
    },
    [reload],
  );

  return { view, loading, refreshing, error, reload, prefetchBody, dispatch };
}

export function rowLabel(row: MailboxRow): string {
  return `${row.senderDisplayName || "Unknown sender"} — ${row.subject || "(no subject)"}`;
}
