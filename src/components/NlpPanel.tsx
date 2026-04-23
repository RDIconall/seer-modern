"use client";

import { useCallback, useState } from "react";

type Verdict = {
  text: string;
  score: number;
  label: string;
  source: string;
  intel: {
    notices: number;
    schedule: number;
    request: number;
    followUp: number;
  };
};

export function NlpPanel() {
  const [text, setText] = useState(
    "Can you send the deck by 5pm? Thanks in advance.\nDoes Tuesday 3pm work for a quick sync?",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    emailHint: number;
    sentences: Verdict[];
  } | null>(null);

  const runClassify = useCallback(async (body: string) => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/nlp/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Request failed");
        return;
      }
      setResult(data);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  const analyzeSnippets = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const mailRes = await fetch("/api/mail?snippets=1");
      const mailData = await mailRes.json();
      if (!mailRes.ok) {
        setError(mailData.error ?? "Could not load inbox");
        return;
      }
      const items = (mailData.items ?? []) as {
        subject: string;
        snippet?: string;
      }[];
      const blob = items
        .map((m) => [m.subject, m.snippet ?? ""].filter(Boolean).join("\n"))
        .join("\n\n");
      if (!blob.trim()) {
        setError("No snippet text to analyze.");
        return;
      }
      const res = await fetch("/api/nlp/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: blob }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Classification failed");
        return;
      }
      setResult(data);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-zinc-300">Hybrid NLP (Intel + LLM gray zone)</h2>
      <p className="text-xs text-zinc-500">
        Rules mirror legacy keyword intel; OpenAI refines sentences only in the
        score gray band when <code className="text-zinc-400">OPENAI_API_KEY</code>{" "}
        is set.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-teal-600 focus:outline-none"
        placeholder="Paste email body…"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={loading}
          onClick={() => runClassify(text)}
          className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-600 disabled:opacity-50"
        >
          {loading ? "Running…" : "Analyze text"}
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={analyzeSnippets}
          className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
        >
          Classify inbox snippets
        </button>
      </div>
      {error ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="space-y-2 text-left">
          <p className="text-xs text-zinc-500">
            Email-level hint: {(result.emailHint * 100).toFixed(0)}%
          </p>
          <ul className="space-y-2">
            {result.sentences.map((s, i) => (
              <li
                key={i}
                className="rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-sm"
              >
                <span className="font-medium text-teal-400/90">{s.label}</span>
                <span className="text-zinc-500"> · {(s.score * 100).toFixed(0)}%</span>
                <span className="text-zinc-600"> · {s.source}</span>
                <div className="mt-1 text-zinc-300">{s.text}</div>
                <div className="mt-1 text-xs text-zinc-600">
                  intel n={s.intel.notices} sch={s.intel.schedule} req=
                  {s.intel.request}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
