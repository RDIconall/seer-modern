"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxView } from "@/lib/v2/view/types";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import { fetchFresh } from "@/lib/v3/net/fetch";
import { ACCOUNT_CHANGED_EVENT } from "@/components/v3/useMailbox";

/**
 * The one data hook for the v2 app. It fetches the server projection, refreshes
 * on focus, and dispatches commands with a generated idempotency key. Commands
 * return the fresh view, so the client never re-derives placement; an optimistic
 * snapshot is restored if the command fails.
 */
export function useInboxView(
  initialView?: InboxView,
  disabled = false,
) {
  const [view, setView] = useState<InboxView | null>(initialView ?? null);
  const [error, setError] = useState<string | null>(null);
  const snapshot = useRef<InboxView | null>(null);
  const accountGeneration = useRef(0);

  const load = useCallback(async () => {
    const requestGeneration = accountGeneration.current;
    try {
      const res = await fetchFresh("/api/v2/inbox");
      // A failed response may not be JSON at all; falling back to the status is
      // better than replacing the real problem with a parse error.
      const json = (await res.json().catch(() => null)) as
        | { view: InboxView; error?: string }
        | null;
      if (!res.ok || !json?.view) {
        throw new Error(json?.error ?? `inbox ${res.status}`);
      }
      if (requestGeneration !== accountGeneration.current) return;
      setView(json.view);
      setError(null);
    } catch (e) {
      if (requestGeneration !== accountGeneration.current) return;
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }, []);

  useEffect(() => {
    if (disabled) return;
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const onAccountChanged = () => {
      accountGeneration.current += 1;
      snapshot.current = null;
      setView(null);
      setError(null);
      void load();
    };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
    };
  }, [disabled, load]);

  const dispatch = useCallback(
    async (command: Command, optimistic?: (v: InboxView) => InboxView) => {
      snapshot.current = view;
      if (view && optimistic) setView(optimistic(view));
      try {
        const res = await fetch("/api/v2/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            command,
            idempotencyKey:
              globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
            // The whiteboard repaints from the response rather than reloading.
            withView: true,
          }),
        });
        const json = (await res.json()) as { result: CommandResult; view?: InboxView };
        if (!res.ok || !json.result.ok) {
          throw new Error(json.result?.error ?? `command ${res.status}`);
        }
        if (json.view) setView(json.view);
        return json.result;
      } catch (e) {
        // Roll back to the pre-command snapshot.
        if (snapshot.current) setView(snapshot.current);
        setError(e instanceof Error ? e.message : "command failed");
        return null;
      }
    },
    [view],
  );

  return { view, error, reload: load, dispatch };
}
