"use client";

import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";

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

export function SearchBox({
  initialQuery = "",
  onSearch,
  onClear,
}: {
  initialQuery?: string;
  onSearch: (query: string, rows: SearchResult[]) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setQuery(initialQuery), [initialQuery]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = query.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v3/search?q=${encodeURIComponent(value)}`, {
        cache: "no-store",
      });
      const json = (await response.json()) as {
        view?: { rows: SearchResult[] };
        error?: string;
      };
      if (!response.ok || !json.view) throw new Error(json.error ?? `search ${response.status}`);
      onSearch(value, json.view.rows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "search failed");
      onSearch(value, []);
    } finally {
      setBusy(false);
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
