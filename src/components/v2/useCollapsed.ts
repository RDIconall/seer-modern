"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Which sections and matters are collapsed, remembered across visits.
 *
 * The previous outline kept this in component state alone, so every reload
 * re-opened the whole board and the shape you had arranged was lost. A
 * whiteboard is something you set up once, so the arrangement belongs in
 * storage, not in a render.
 */
export function useCollapsed(storageKey: string) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  /** False on a first visit, so a caller can choose a sensible default shape. */
  const [hasStored, setHasStored] = useState(false);

  // Read after mount: localStorage does not exist during a server render, and
  // seeding state from it directly would desynchronise the first paint.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        setCollapsed(new Set(JSON.parse(raw) as string[]));
        setHasStored(true);
      }
    } catch {
      // A corrupt or unavailable store must never stop the board rendering.
    }
    setLoaded(true);
  }, [storageKey]);

  const persist = useCallback(
    (next: Set<string>) => {
      setCollapsed(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        // Private mode and full quotas are not worth breaking the UI over.
      }
    },
    [storageKey],
  );

  const toggle = useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        try {
          window.localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [storageKey],
  );

  const collapseAll = useCallback(
    (ids: string[]) => persist(new Set(ids)),
    [persist],
  );
  const expandAll = useCallback(() => persist(new Set()), [persist]);

  return { collapsed, loaded, hasStored, toggle, collapseAll, expandAll };
}
