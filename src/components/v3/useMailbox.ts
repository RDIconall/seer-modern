"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type {
  MailboxFolder,
  MailboxRow,
  MailboxSort,
  MailboxView,
} from "@/lib/v3/mailbox/types";
import {
  applyMailboxCommands,
  prefetchAdjacentIds,
  viewForFolder,
} from "./mailbox-state";

const CACHE_VERSION = 3;
const mailboxCache = new Map<string, MailboxView>();
const bodyCache = new Map<string, unknown>();

function cacheKey(
  accountId: string,
  folder: MailboxFolder,
  sort: MailboxSort,
): string {
  return `seer.v3.mailbox.${CACHE_VERSION}.${accountId}.${folder}.${sort}`;
}

function mapKey(
  accountId: string,
  folder: MailboxFolder,
  sort: MailboxSort,
): string {
  return `${accountId}:${folder}:${sort}`;
}

function readCache(
  accountId: string,
  folder: MailboxFolder,
  sort: MailboxSort,
): MailboxView | null {
  const memory = mailboxCache.get(mapKey(accountId, folder, sort));
  if (memory) return memory;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(accountId, folder, sort));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MailboxView;
    if (
      parsed.accountId !== accountId ||
      parsed.folder !== folder ||
      parsed.sort !== sort ||
      !Array.isArray(parsed.rows)
    ) {
      return null;
    }
    mailboxCache.set(mapKey(accountId, folder, sort), parsed);
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(view: MailboxView): void {
  mailboxCache.set(mapKey(view.accountId, view.folder, view.sort), view);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      cacheKey(view.accountId, view.folder, view.sort),
      JSON.stringify(view),
    );
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
  sort?: MailboxSort;
};

export type MailboxState = {
  view: MailboxView | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  reload: () => Promise<void>;
  prefetchBody: (conversationId: string) => void;
  dispatch: (command: Command) => Promise<CommandResult>;
  dispatchMany: (commands: Command[]) => Promise<CommandResult[]>;
};

async function postCommand(command: Command): Promise<CommandResult> {
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
  return result;
}

/**
 * Folder data is deliberately cache-first. A previous view paints immediately,
 * then the corpus is revalidated in the background; no UI path waits for a
 * provider or the brain before showing a row.
 */
export function useMailbox(
  folder: MailboxFolder,
  options: MailboxHookOptions = {},
): MailboxState {
  const sort: MailboxSort = options.sort ?? "date";
  const [accountId, setAccountId] = useState<string | null>(
    options.initialView?.accountId ?? null,
  );
  const initial = useMemo(
    () =>
      options.initialView ??
      (accountId ? readCache(accountId, folder, sort) : null),
    [accountId, folder, options.initialView, sort],
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
  }, [folder, initial, options.disabled, sort]);

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
        `/api/v3/mailbox?folder=${encodeURIComponent(folder)}&sort=${encodeURIComponent(sort)}&limit=50`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`mailbox ${response.status}`);
      const json = (await response.json()) as { view: MailboxView };
      if (
        json.view.folder !== folder ||
        json.view.sort !== sort ||
        json.view.accountId !== activeAccountId
      ) {
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
  }, [folder, options.disabled, sort]);

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

  /**
   * A batch is sent one command at a time — the command bus is per-conversation
   * and each needs its own idempotency key — but the list is patched once up
   * front and re-read once at the end. Reloading between every row would make a
   * fifty-row bulk action fifty round trips of visible stalling.
   */
  const dispatchMany = useCallback(
    async (commands: Command[]): Promise<CommandResult[]> => {
      if (commands.length === 0) return [];
      const previous = viewRef.current;
      if (previous) {
        const optimistic = applyMailboxCommands(previous, commands);
        if (optimistic !== previous) {
          viewRef.current = optimistic;
          setView(optimistic);
        }
      }

      const results: CommandResult[] = [];
      let firstFailure: unknown = null;
      for (const command of commands) {
        try {
          results.push(await postCommand(command));
        } catch (cause) {
          // One rejected row must not abandon the rest of the batch.
          firstFailure ??= cause;
        }
      }

      await reload();
      if (results.length === 0 && firstFailure) throw firstFailure;
      return results;
    },
    [reload],
  );

  const dispatch = useCallback(
    async (command: Command): Promise<CommandResult> => {
      const [result] = await dispatchMany([command]);
      return result;
    },
    [dispatchMany],
  );

  return {
    view: viewForFolder(view, folder, sort),
    loading,
    refreshing,
    error,
    reload,
    prefetchBody,
    dispatch,
    dispatchMany,
  };
}

export function rowLabel(row: MailboxRow): string {
  return `${row.senderDisplayName || "Unknown sender"} — ${row.subject || "(no subject)"}`;
}
