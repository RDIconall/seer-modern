"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchFresh } from "@/lib/v3/net/fetch";
import { ACCOUNT_CHANGED_EVENT } from "./useMailbox";
import { SearchRequestGuard } from "./search-request";

export type SearchResult = {
  providerConversationId: string;
  subject: string;
  snippet: string;
  lastMessageAt: string;
  synced: boolean;
  transient: boolean;
  conversationId?: string;
  decisionSummary: string | null;
  matterTitle: string | null;
  priority: number | null;
  dueDate: string | null;
};

export async function fetchSearch(
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const response = await fetchFresh(`/api/v3/search?q=${encodeURIComponent(query)}`, {
    signal,
  });
  const json = (await response.json()) as {
    view?: { rows: SearchResult[] };
    error?: string;
  };
  if (!response.ok || !json.view) {
    throw new Error(json.error ?? `search ${response.status}`);
  }
  return json.view.rows;
}

export function SearchBox({
  initialQuery = "",
  onSearch,
  onClear,
  requestGuard,
}: {
  initialQuery?: string;
  onSearch: (query: string, rows: SearchResult[]) => void;
  onClear: () => void;
  requestGuard?: SearchRequestGuard;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localGuard = useRef(new SearchRequestGuard());
  const guard = requestGuard ?? localGuard.current;

  useEffect(() => setQuery(initialQuery), [initialQuery]);

  useEffect(() => {
    const onAccountChanged = () => {
      guard.invalidateForAccountChange();
      setBusy(false);
      setError(null);
    };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
  }, [guard]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = query.trim();
    if (!value || busy) return;
    const token = guard.start();
    setBusy(true);
    setError(null);
    try {
      const rows = await fetchSearch(value, token.signal);
      if (!guard.isCurrent(token)) return;
      onSearch(value, rows);
    } catch (cause) {
      if (!guard.isCurrent(token)) return;
      setError(cause instanceof Error ? cause.message : "search failed");
      onSearch(value, []);
    } finally {
      if (guard.isCurrent(token)) setBusy(false);
    }
  }

  return (
    <div className="mail-search">
      <form onSubmit={submit} role="search">
        <Search className="mail-search-icon" aria-hidden />
        <label htmlFor="mail-search-input" className="sr-only">
          Search mail
        </label>
        <input
          id="mail-search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search mail"
          autoComplete="off"
          className="mail-focus-ring"
        />
        {query && (
          <button
            type="button"
            className="mail-search-clear mail-focus-ring"
            aria-label="Clear search"
            onClick={() => {
              guard.cancel();
              setQuery("");
              onClear();
            }}
          >
            <X aria-hidden />
          </button>
        )}
        <button type="submit" className="mail-search-submit mail-focus-ring" disabled={busy}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      {error && <p className="mail-search-error" role="alert">{error}</p>}
    </div>
  );
}
