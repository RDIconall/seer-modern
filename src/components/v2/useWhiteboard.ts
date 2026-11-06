"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type { WhiteboardItem, WhiteboardView } from "@/lib/v2/whiteboard/types";
import { seedWhiteboardView } from "@/lib/v2/whiteboard/seed";
import { fetchFresh } from "@/lib/v3/net/fetch";
import { describeHttpFailure, readJsonBody } from "@/lib/v3/net/json";
import { ACCOUNT_CHANGED_EVENT } from "@/components/v3/useMailbox";

const POLL_MS = 20_000;

export function useWhiteboard(options: {
  enabled: boolean;
  initial?: WhiteboardView | null;
}) {
  const [view, setView] = useState<WhiteboardView | null>(
    options.initial ?? seedWhiteboardView(),
  );
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const request = generation.current;
    try {
      const res = await fetchFresh("/api/v2/whiteboard");
      const json = await readJsonBody<{ view?: WhiteboardView; error?: string }>(
        res,
      );
      if (!res.ok || !json?.view) {
        throw new Error(json?.error ?? describeHttpFailure(res.status));
      }
      if (request !== generation.current) return;
      setView(json.view);
      setError(null);
    } catch (cause) {
      if (request !== generation.current) return;
      setError(cause instanceof Error ? cause.message : "failed to load whiteboard");
      setView((current) => current ?? seedWhiteboardView());
    }
  }, []);

  useEffect(() => {
    if (!options.enabled) return;
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const onAccount = () => {
      generation.current += 1;
      setView(seedWhiteboardView());
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
        setView((current) => applyLocalCommand(current, command));
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

function applyLocalCommand(
  view: WhiteboardView | null,
  command: Command,
): WhiteboardView | null {
  if (!view) return view;
  if (command.type === "updateWhiteboardItem") {
    return {
      ...view,
      sections: view.sections.map((section) => ({
        ...section,
        items: section.items.map((item) =>
          item.id === command.itemId
            ? {
                ...item,
                title: command.title ?? item.title,
                status: command.status ?? item.status,
                body: command.body === undefined ? item.body : command.body,
              }
            : item,
        ),
      })),
    };
  }
  if (command.type === "createWhiteboardItem") {
    const created: WhiteboardItem = {
      id: `local-${Date.now()}`,
      accountId: "local",
      sectionId:
        view.sections.find((section) => section.slug === command.sectionSlug)?.id ??
        "",
      sectionSlug: command.sectionSlug,
      externalKey: null,
      title: command.title,
      body: command.body ?? null,
      status: command.status ?? "open",
      priority: command.priority ?? 100,
      dueAt: command.dueAt ?? null,
      ownerLabel: command.ownerLabel ?? null,
      conversationId: command.conversationId ?? null,
      matterId: null,
      botTaskId: null,
      source: "user",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return {
      ...view,
      sections: view.sections.map((section) =>
        section.slug === command.sectionSlug
          ? { ...section, items: [...section.items, created] }
          : section,
      ),
    };
  }
  return view;
}
