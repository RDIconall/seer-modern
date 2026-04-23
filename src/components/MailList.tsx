"use client";

import { useEffect, useState } from "react";

type Item = {
  id?: string;
  subject: string;
  from: string;
  receivedAt: string;
  snippet?: string;
};

export function MailList({ snippets }: { snippets?: boolean }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = snippets ? "?snippets=1" : "";
    (async () => {
      try {
        const res = await fetch(`/api/mail${q}`);
        const data = await res.json();
        if (!res.ok) {
          if (!cancelled) setError(data.error ?? "Could not load mail");
          return;
        }
        if (!cancelled) setItems(data.items ?? []);
      } catch {
        if (!cancelled) setError("Network error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snippets]);

  if (error) {
    return (
      <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
        {error}
      </p>
    );
  }
  if (items === null) {
    return <p className="text-sm text-zinc-400">Loading recent messages…</p>;
  }
  if (items.length === 0) {
    return <p className="text-sm text-zinc-400">No messages returned.</p>;
  }
  return (
    <ul className="space-y-3 text-left">
      {items.map((m, i) => (
        <li
          key={m.id ?? i}
          className="rounded-lg border border-zinc-700/80 bg-zinc-900/50 px-4 py-3"
        >
          <div className="font-medium text-zinc-100">{m.subject}</div>
          <div className="mt-1 text-xs text-zinc-400">{m.from}</div>
          {m.snippet ? (
            <div className="mt-2 line-clamp-3 text-xs text-zinc-500">{m.snippet}</div>
          ) : null}
          {m.receivedAt ? (
            <div className="mt-1 text-xs text-zinc-500">
              {new Date(m.receivedAt).toLocaleString()}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
