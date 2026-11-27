"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_INBOX_SORT,
  sortFromValue,
  sortValue,
  type InboxSort,
} from "./inbox-groups";

const STORAGE_KEY = "seer.inbox.sort.v1";

/** The Inbox sort, remembered on this device. Server render always starts oldest first. */
export function useInboxSort(): [InboxSort, (sort: InboxSort) => void] {
  const [sort, setSortState] = useState<InboxSort>(DEFAULT_INBOX_SORT);

  useEffect(() => {
    try {
      const stored = sortFromValue(window.localStorage.getItem(STORAGE_KEY));
      if (stored) setSortState(stored);
    } catch {
      // Storage can be unavailable (private mode); the default still works.
    }
  }, []);

  const setSort = useCallback((next: InboxSort) => {
    setSortState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, sortValue(next));
    } catch {
      // Not remembering the choice is fine.
    }
  }, []);

  return [sort, setSort];
}
