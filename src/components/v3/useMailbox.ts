"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type { MailboxFolder, MailboxRow, MailboxView } from "@/lib/v3/mailbox/types";
import { prefetchAdjacentIds, viewForFolder } from "./mailbox-state";

const CACHE_VERSION = 2;
const mailboxCache = new Map<string, MailboxView>();
const bodyCache = new Map<string, unknown>();

function cacheKey(accountId: string, folder: MailboxFolder): string {
  return `seer.v3.mailbox.${CACHE_VERSION}.${accountId}.${folder}`;
}

function mapKey(accountId: string, folder: MailboxFolder): string {
  return `${accountId}:${folder}`;
}

function readCache(accountId: string, folder: MailboxFolder): MailboxView | null {
  const memory = mailboxCache.get(mapKey(accountId, folder));
  if (memory) return memory;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(accountId, folder));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MailboxView;
    if (
      parsed.accountId !== accountId ||
      parsed.folder !== folder ||
      !Array.isArray(parsed.rows)
    ) {
      return null;
    }
    mailboxCache.set(mapKey(accountId, folder), parsed);
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(view: MailboxView): void {
  mailboxCache.set(mapKey(view.accountId, view.folder), view);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(cacheKey(view.accountId, view.folder), JSON.stringify(view));
  } catch {
    // A full or disabled browser cache must never block the mailbox.
  }
}

/** Clear every account-scoped mailbox, body, and search-adjacent cache. */
export function clearMailboxCaches(): void {
  mailboxCache.clear();
  bodyCache.clear();
  if (typeof window === "undefined") return;
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key?.startsWith("seer.v3.mailbox.")) window.localStorage.removeItem(key);
    }
  } catch {
    // Cache cleanup must never block an account switch.
  }
}

export const ACCOUNT_CHANGED_EVENT = "seer:account-changed";

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
  const [accountId, setAccountId] = useState<string | null>(
    options.initialView?.accountId ?? null,
  );
  const initial = useMemo(
    () =>
      options.initialView ??
      (accountId ? readCache(accountId, folder) : null),
    [accountId, folder, options.initialView],
  );
  const [view, setView] = useState<MailboxView | null>(initial);
  const [loading, setLoading] = useState(!initial);
  const [refreshing, setRefreshing] = useState(Boolean(initial));
  const [error, setError] = useState<string | null>(null);
  const viewRef = useRef<MailboxView | null>(initial);

  useEffect(() => {
    viewRef.current = initial;
    setView(initial);
    setLoading(!initial);
    setRefreshing(Boolean(!options.disabled && initial));
    setError(null);
  }, [folder, initial, options.disabled]);

  const reload = useCallback(async () => {
    if (options.disabled) return;
    setRefreshing(true);
    setLoading(true);
    try {
      const accountResponse = await fetch("/api/v3/accounts", { cache: "no-store" });
      const accountJson = (await accountResponse.json()) as {
        active?: { id?: string } | null;
      };
      if (!accountResponse.ok || !accountJson.active?.id) {
        throw new Error("no active account");
      }
      const activeAccountId = accountJson.active.id;
      setAccountId(activeAccountId);
      const response = await fetch(
        `/api/v3/mailbox?folder=${encodeURIComponent(folder)}&limit=50`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`mailbox ${response.status}`);
      const json = (await response.json()) as { view: MailboxView };
      if (json.view.folder !== folder || json.view.accountId !== activeAccountId) {
        throw new Error("mailbox response scope mismatch");
      }
      writeCache(json.view);
      viewRef.current = json.view;
      setView(json.view);
      setError(null);
    } catch (cause) {
      viewRef.current = null;
      setView(null);
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

  useEffect(() => {
    if (options.disabled || typeof window === "undefined") return;
    const onAccountChanged = () => {
      clearMailboxCaches();
      setAccountId(null);
      viewRef.current = null;
      setView(null);
      setLoading(true);
      void reload();
    };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
  }, [options.disabled, reload]);

  const prefetchBody = useCallback((conversationId: string) => {
    if (!accountId) return;
    const accountKey = accountId;
    const ids = prefetchAdjacentIds(viewRef.current, conversationId);
    for (const id of ids) {
      const bodyKey = `${accountKey}:${id}`;
      if (bodyCache.has(bodyKey)) continue;
      bodyCache.set(bodyKey, true);
      const run = () => {
        void fetch(
          `/api/v3/conversations/${encodeURIComponent(id)}?account=${encodeURIComponent(accountKey)}`,
          { cache: "force-cache" },
        )
          .then(async (response) => {
            if (!response.ok) throw new Error("body prefetch failed");
            bodyCache.set(bodyKey, await response.json());
          })
          .catch(() => {
            bodyCache.delete(bodyKey);
          });
      };
      if (typeof window === "undefined") continue;
      const idle = (
        window as Window & {
          requestIdleCallback?: (
            callback: () => void,
            options?: { timeout?: number },
          ) => number;
        }
      ).requestIdleCallback;
      if (idle) idle(run, { timeout: 700 });
      else globalThis.setTimeout(run, 0);
    }
  }, [accountId]);

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

  return {
    view: viewForFolder(view, folder),
    loading,
    refreshing,
    error,
    reload,
    prefetchBody,
    dispatch,
  };
}

export function rowLabel(row: MailboxRow): string {
  return `${row.senderDisplayName || "Unknown sender"} — ${row.subject || "(no subject)"}`;
}
