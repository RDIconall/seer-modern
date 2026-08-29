"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { fetchFresh } from "@/lib/v3/net/fetch";

type Draft = { name: string; why: string };

type ModelState = {
  functions: string[];
  topics: string[];
  guidance: string;
  proposal: {
    functions: Draft[];
    topics: Draft[];
    guidance: string;
    rationale: string;
  } | null;
  proposedAt: string | null;
  acceptedAt: string | null;
  error?: string;
  counts?: Record<string, number>;
};

function rowsFrom(names: string[], drafts?: Draft[]): Draft[] {
  if (drafts && drafts.length > 0) return drafts.map((d) => ({ ...d }));
  return names.map((name) => ({ name, why: "" }));
}

export function AtlasSettings() {
  const [model, setModel] = useState<ModelState | null>(null);
  const [functions, setFunctions] = useState<Draft[]>([]);
  const [topics, setTopics] = useState<Draft[]>([]);
  const [guidance, setGuidance] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const hydrate = useCallback((next: ModelState, fromProposal = false) => {
    setModel(next);
    if (fromProposal && next.proposal) {
      setFunctions(next.proposal.functions.map((d) => ({ ...d })));
      setTopics(next.proposal.topics.map((d) => ({ ...d })));
      setGuidance(next.proposal.guidance || next.guidance);
      return;
    }
    setFunctions(rowsFrom(next.functions));
    setTopics(rowsFrom(next.topics));
    setGuidance(next.guidance);
  }, []);

  const load = useCallback(async () => {
    const response = await fetchFresh("/api/v2/operating-model");
    const json = (await response.json()) as ModelState;
    if (!response.ok) throw new Error(json.error ?? "Unable to load Atlas");
    hydrate(json);
  }, [hydrate]);

  useEffect(() => {
    void load().catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Unable to load Atlas");
    });
  }, [load]);

  async function propose() {
    setBusy("propose");
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/v2/operating-model", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "propose", note }),
      });
      const json = (await response.json()) as ModelState;
      if (!response.ok) throw new Error(json.error ?? "Propose failed");
      hydrate(json, true);
      setStatus(
        json.proposal?.rationale ||
          "Proposed sections from this mailbox. Edit, then apply.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Propose failed");
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    setBusy("apply");
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/v2/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: {
            type: "applyOperatingModel",
            functions: functions.map((row) => row.name),
            topics: topics.map((row) => row.name),
            guidance,
          },
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const json = (await response.json()) as {
        result?: { ok?: boolean; error?: string };
      };
      if (!response.ok || !json.result?.ok) {
        throw new Error(json.result?.error ?? "Apply failed");
      }
      await load();
      setStatus("Atlas now uses these sections. New mail will file against them.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Apply failed");
    } finally {
      setBusy(null);
    }
  }

  if (!model && !error) {
    return <p className="mail-settings-loading">Loading Atlas…</p>;
  }

  return (
    <section className="mail-settings-section" aria-labelledby="atlas-sections-heading">
      <h2 className="mail-settings-heading" id="atlas-sections-heading">
        Atlas
      </h2>
      <p className="mail-settings-copy">
        Seer reads starred mail, sent, trash, and Salesforce (if connected), then
        proposes the split for this mailbox. Edit the names and tell it how to
        file. Apply replaces the board — it will not overwrite shelves you filed
        by hand.
      </p>

      {error && (
        <p className="mail-settings-alert" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="mail-settings-status" role="status">
          {status}
        </p>
      )}

      <label className="mail-settings-field">
        <span>How to adjust this proposal</span>
        <textarea
          className="mail-settings-textarea"
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="e.g. this is my personal inbox — house, family, money, not a company board"
        />
      </label>

      <div className="mail-settings-actions">
        <button
          className="mail-settings-button"
          type="button"
          disabled={busy !== null}
          onClick={() => void propose()}
        >
          <RefreshCw className="mail-settings-button-icon" aria-hidden="true" />
          {busy === "propose" ? "Reading mailbox…" : "Propose from this mailbox"}
        </button>
      </div>

      <ShelfEditor
        title="Work sections"
        hint="Live concerns Atlas tracks."
        rows={functions}
        onChange={setFunctions}
      />
      <ShelfEditor
        title="Mail that is not work"
        hint="Newsletters, receipts, shipping — Triage, not the board."
        rows={topics}
        onChange={setTopics}
      />

      <label className="mail-settings-field">
        <span>Guidance for Seer</span>
        <textarea
          className="mail-settings-textarea"
          rows={5}
          value={guidance}
          onChange={(event) => setGuidance(event.target.value)}
          placeholder="Family logistics are matters. Store receipts are records. Promo mail is a topic, never a matter."
        />
      </label>

      <div className="mail-settings-actions">
        <button
          className="mail-settings-button"
          type="button"
          disabled={busy !== null || functions.every((row) => !row.name.trim())}
          onClick={() => void apply()}
        >
          {busy === "apply" ? "Applying…" : "Apply to Atlas"}
        </button>
      </div>
    </section>
  );
}

function ShelfEditor({
  title,
  hint,
  rows,
  onChange,
}: {
  title: string;
  hint: string;
  rows: Draft[];
  onChange: (rows: Draft[]) => void;
}) {
  return (
    <div className="mail-settings-shelves">
      <h3 className="mail-settings-subheading">{title}</h3>
      <p className="mail-settings-hint">{hint}</p>
      <ul className="mail-settings-shelf-list">
        {rows.map((row, index) => (
          <li className="mail-settings-shelf" key={`${title}-${index}`}>
            <input
              className="mail-settings-input"
              aria-label={`${title} ${index + 1}`}
              value={row.name}
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...row, name: event.target.value };
                onChange(next);
              }}
            />
            <button
              className="mail-settings-button mail-settings-danger"
              type="button"
              aria-label={`Remove ${row.name || title}`}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <Trash2 className="mail-settings-button-icon" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <button
        className="mail-settings-button"
        type="button"
        onClick={() => onChange([...rows, { name: "", why: "" }])}
      >
        <Plus className="mail-settings-button-icon" aria-hidden="true" />
        Add section
      </button>
    </div>
  );
}
