"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type {
  MailboxFolder,
  MailboxRow,
  MailboxSort,
  MailboxView,
} from "@/lib/v3/mailbox/types";
import { fetchDefault, fetchFresh } from "@/lib/v3/net/fetch";
import { describeHttpFailure, readJsonBody } from "@/lib/v3/net/json";
import {
  appendPage,
  applyMailboxCommands,
  prefetchAdjacentIds,
  viewForFolder,
} from "./mailbox-state";

const CACHE_VERSION = 5;
const mailboxCache = new Map<string, MailboxView>();
const bodyCache = new Map<string, unknown>();

/**
 * A folder is a scroll, so one page of it is a page. Triage is a work queue,
 * and one page of a work queue is a lie about how much work there is: the pile
 * headings count the rows that arrived, so clearing them only pulls the next
 * page in and the same pile comes back at the same size. Triage is therefore
 * read to the END, a page at a time, through the keyset cursor the mailbox
 * already returns.
 */
const FOLDER_PAGE = 50;
const TRIAGE_PAGE = 200;
/** A ceiling, so a runaway cursor cannot walk a mailbox forever. */
const MAX_TRIAGE_PAGES = 8;

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

/**
 * The reason an action failed is more useful than the fact that it did, so the
 * body is read tolerantly: a bodiless 500 or a sign-in redirect must produce
 * "Seer's server failed (500)", not a JSON parser's complaint about it.
 */
async function postCommand(command: Command): Promise<CommandResult> {
  const response = await fetch("/api/v2/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, idempotencyKey: idempotencyKey() }),
  });
  const json = await readJsonBody<{ result?: CommandResult; error?: string }>(
    response,
  );
  const result = json?.result;
  if (!response.ok || !result?.ok) {
    throw new Error(
      result?.error ?? json?.error ?? describeHttpFailure(response.status),
    );
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
  /**
   * What a fetch produced, tagged with the scope it was produced for.
   *
   * This used to be four pieces of state re-assigned by an effect whenever the
   * seed view changed. That effect assigns on every run, so a scope that
   * alternates — and the section does alternate for a beat while the URL hash
   * is applied — put the client in an update loop React ends with "Maximum
   * update depth exceeded", which the error boundary turned into a blank page.
   *
   * Nothing is mirrored now. A result belongs to one scope, and a result from
   * another scope simply is not this list's result, so switching folders shows
   * the seed again without a single assignment.
   */
  type Loaded = {
    scope: string;
    view: MailboxView | null;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
  };

  const scope = `${accountId ?? ""}:${folder}:${sort}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const viewRef = useRef<MailboxView | null>(initial);

  const current: Loaded =
    loaded && loaded.scope === scope
      ? loaded
      : {
          scope,
          view: initial,
          loading: !initial,
          refreshing: Boolean(!options.disabled && initial),
          error: null,
        };
  const { view, loading, refreshing, error } = current;
  viewRef.current = view;

  /** Record a result only against the scope it was fetched for. */
  const settle = useCallback(
    (next: Omit<Loaded, "scope">, forScope: string) =>
      setLoaded((previous) =>
        previous && previous.scope === forScope && previous.view === next.view &&
        previous.loading === next.loading &&
        previous.refreshing === next.refreshing &&
        previous.error === next.error
          ? previous
          : { scope: forScope, ...next },
      ),
    [],
  );

  const reload = useCallback(async () => {
    if (options.disabled) return;
    // The scope this fetch belongs to. A folder switch mid-flight must not let
    // the older response land on the newer list.
    const forScope = `${accountId ?? ""}:${folder}:${sort}`;
    try {
      const accountResponse = await fetchFresh("/api/v3/accounts");
      const accountJson = (await accountResponse.json()) as {
        active?: { id?: string } | null;
      };
      if (!accountResponse.ok || !accountJson.active?.id) {
        throw new Error("no active account");
      }
      const activeAccountId = accountJson.active.id;
      setAccountId(activeAccountId);
      const scope = `${activeAccountId}:${folder}:${sort}`;
      const pageSize = sort === "triage" ? TRIAGE_PAGE : FOLDER_PAGE;
      let merged: MailboxView | null = null;
      let before: string | null = null;

      for (let page = 0; page < MAX_TRIAGE_PAGES; page += 1) {
        const response = await fetchFresh(
          `/api/v3/mailbox?folder=${encodeURIComponent(folder)}` +
            `&sort=${encodeURIComponent(sort)}&limit=${pageSize}` +
            (before ? `&before=${encodeURIComponent(before)}` : ""),
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
        merged = merged ? appendPage(merged, json.view) : json.view;
        // The first page paints straight away; the tail of the queue arrives
        // behind it rather than holding the whole screen back.
        if (page === 0) {
          viewRef.current = merged;
          settle(
            {
              view: merged,
              loading: false,
              refreshing: Boolean(json.view.nextCursor) && sort === "triage",
              error: null,
            },
            scope,
          );
        }
        before = json.view.nextCursor;
        if (sort !== "triage" || !before) break;
      }

      if (!merged) throw new Error("mailbox returned no page");
      writeCache(merged);
      viewRef.current = merged;
      settle(
        { view: merged, loading: false, refreshing: false, error: null },
        scope,
      );
    } catch (cause) {
      viewRef.current = null;
      settle(
        {
          view: null,
          loading: false,
          refreshing: false,
          error: cause instanceof Error ? cause.message : "failed to load mailbox",
        },
        forScope,
      );
    }
  }, [accountId, folder, options.disabled, settle, sort]);

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
      setLoaded(null);
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
        void fetchDefault(
          `/api/v3/conversations/${encodeURIComponent(id)}?account=${encodeURIComponent(accountKey)}`,
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
          settle(
            { view: optimistic, loading: false, refreshing: true, error: null },
            `${accountId ?? ""}:${folder}:${sort}`,
          );
        }
      }

      const results: CommandResult[] = [];
      for (const command of commands) {
        try {
          results.push(await postCommand(command));
        } catch (cause) {
          // Preserve one result per command. Returning only successes made a
          // partial batch impossible to reconcile with the rows the user saw:
          // the UI knew that "one failed" but not which one to restore.
          results.push({
            ok: false,
            replayed: false,
            error:
              cause instanceof Error ? cause.message : "action was not queued",
          });
        }
      }

      // A mutation is queued, not sent, and the queue is otherwise only drained
      // on the five-minute cron: mail the user cleared could sit in Outlook for
      // half an hour. Kick the queue once per batch and do not wait on it — the
      // rows are already gone from the list either way, and the cron still
      // covers a request that never lands.
      if (results.some((result) => result.outboxId)) {
        void fetch("/api/v3/outbox/drain", { method: "POST", keepalive: true }).catch(
          () => {},
        );
      }

      await reload();
      return results;
    },
    [accountId, folder, reload, settle, sort],
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
