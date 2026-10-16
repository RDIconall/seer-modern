"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type { StaffView } from "@/lib/v2/staff/types";
import { fetchFresh } from "@/lib/v3/net/fetch";
import { describeHttpFailure, readJsonBody } from "@/lib/v3/net/json";
import { ACCOUNT_CHANGED_EVENT } from "@/components/v3/useMailbox";

const POLL_MS = 8_000;

export function useStaffView(options: {
  enabled: boolean;
  taskId?: string | null;
  initial?: StaffView | null;
}) {
  const [view, setView] = useState<StaffView | null>(options.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const request = generation.current;
    try {
      const params = options.taskId
        ? `?taskId=${encodeURIComponent(options.taskId)}`
        : "";
      const res = await fetchFresh(`/api/v2/staff${params}`);
      const json = await readJsonBody<{ view?: StaffView; error?: string }>(res);
      if (!res.ok || !json?.view) {
        throw new Error(json?.error ?? describeHttpFailure(res.status));
      }
      if (request !== generation.current) return;
      setView(json.view);
      setError(null);
    } catch (cause) {
      if (request !== generation.current) return;
      setError(cause instanceof Error ? cause.message : "failed to load staff");
    }
  }, [options.taskId]);

  useEffect(() => {
    if (!options.enabled) return;
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const onAccount = () => {
      generation.current += 1;
      setView(null);
      setError(null);
      void load();
    };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onAccount);
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, onAccount);
      window.clearInterval(timer);
    };
  }, [options.enabled, load]);

  const dispatch = useCallback(
    async (command: Command): Promise<CommandResult | null> => {
      if (!options.enabled) {
        return { ok: true, replayed: false };
      }
      try {
        const res = await fetch("/api/v2/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            command,
            idempotencyKey:
              globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
          }),
        });
        const json = await readJsonBody<{
          result?: CommandResult;
          error?: string;
        }>(res);
        const result = json?.result;
        if (!res.ok || !result?.ok) {
          throw new Error(
            result?.error ?? json?.error ?? describeHttpFailure(res.status),
          );
        }
        await load();
        return result;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "command failed");
        return null;
      }
    },
    [load, options.enabled],
  );

  return { view, error, reload: load, dispatch };
}
