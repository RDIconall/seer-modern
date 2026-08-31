"use client";

import { useCallback, useEffect, useState } from "react";
import type { Command } from "@/lib/v2/commands/types";
import type {
  ClearHabit,
  ImportanceCue,
  MatterBar,
  StyleInference,
} from "@/lib/v2/intelligence/mailbox-style";
import { fetchFresh } from "@/lib/v3/net/fetch";

type StyleResponse = {
  clearHabit: ClearHabit;
  importanceCues: ImportanceCue[];
  matterBar: MatterBar;
  confirmed: boolean;
  inferred: StyleInference;
  driftPrompt: string | null;
  snapshot: { providerInboxTotal: number; storedInbox: number };
  error?: string;
};

export function MailboxStyleSetup({
  onCommand,
  onDone,
  onTrain,
  force,
}: {
  onCommand: (command: Command) => Promise<unknown>;
  onDone: () => void;
  onTrain: () => void;
  force?: boolean;
}) {
  const [data, setData] = useState<StyleResponse | null>(null);
  const [step, setStep] = useState<"map" | "confirm">("map");
  const [clearHabit, setClearHabit] = useState<ClearHabit>("archive");
  const [importance, setImportance] = useState<ImportanceCue>("none");
  const [matterBar, setMatterBar] = useState<MatterBar>("medium");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetchFresh("/api/v2/mailbox-style");
    const json = (await response.json()) as StyleResponse;
    if (!response.ok) throw new Error(json.error ?? "Unable to load mailbox style");
    setData(json);
    setClearHabit(json.confirmed ? json.clearHabit : json.inferred.clearHabit);
    setImportance(
      (json.confirmed ? json.importanceCues : json.inferred.importanceCues)[0] ??
        "none",
    );
    setMatterBar(json.confirmed ? json.matterBar : json.inferred.matterBar);
  }, []);

  useEffect(() => {
    void load().catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Unable to load");
    });
  }, [load]);

  if (data && data.confirmed && !force && !data.driftPrompt) return null;
  if (!data && !error) return null;

  async function confirm(andTrain: boolean) {
    setBusy(true);
    setError(null);
    try {
      await onCommand({
        type: "confirmMailboxStyle",
        clearHabit,
        importanceCues: [importance],
        matterBar,
      });
      if (andTrain) onTrain();
      else onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const inferred = data?.inferred;

  return (
    <div className="style-setup" role="dialog" aria-labelledby="style-setup-title">
      <div className="style-setup-card">
        {step === "map" ? (
          <>
            <h2 id="style-setup-title">How Seer is organised</h2>
            <ol className="style-setup-map">
              <li>
                <strong>Inbox</strong> is the real Outlook or Gmail folder, newest
                first — including everything you never archived.
              </li>
              <li>
                <strong>Triage</strong> is decisions: clear noise, keep records.
              </li>
              <li>
                <strong>Cards</strong> ask one question: is this still relevant?
              </li>
              <li>
                <strong>Atlas</strong> is only live work, not your whole Inbox.
              </li>
            </ol>
            <button
              type="button"
              className="style-setup-primary"
              onClick={() => setStep("confirm")}
            >
              Next — what we think you do
            </button>
          </>
        ) : (
          <>
            <h2 id="style-setup-title">Check what we inferred</h2>
            {inferred?.reasons?.[0] && (
              <p className="style-setup-reason">{inferred.reasons[0]}</p>
            )}
            <label className="style-setup-field">
              When you are done with a thread
              <select
                value={clearHabit}
                onChange={(event) =>
                  setClearHabit(event.target.value as ClearHabit)
                }
              >
                <option value="archive">Archive it out of Inbox</option>
                <option value="delete">Delete it</option>
                <option value="leave">Leave it in Inbox (hide from Focus)</option>
              </select>
            </label>
            <label className="style-setup-field">
              How you mark what matters
              <select
                value={importance}
                onChange={(event) =>
                  setImportance(event.target.value as ImportanceCue)
                }
              >
                <option value="none">I don&apos;t mark</option>
                <option value="unread">Leave it unread</option>
                <option value="flag">Flag it</option>
                <option value="star">Star it</option>
              </select>
            </label>
            <label className="style-setup-field">
              What belongs on Atlas
              <select
                value={matterBar}
                onChange={(event) =>
                  setMatterBar(event.target.value as MatterBar)
                }
              >
                <option value="high">Only real ongoing work</option>
                <option value="medium">Typical open work</option>
                <option value="low">Many threads can stay live</option>
              </select>
            </label>
            {error && <p className="style-setup-error">{error}</p>}
            <div className="style-setup-actions">
              <button
                type="button"
                className="style-setup-primary"
                disabled={busy}
                onClick={() => void confirm(true)}
              >
                Save and train on Cards
              </button>
              <button
                type="button"
                className="style-setup-secondary"
                disabled={busy}
                onClick={() => void confirm(false)}
              >
                Save and skip training
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function MailboxStyleSettings() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<StyleResponse | null>(null);

  const load = useCallback(async () => {
    const response = await fetchFresh("/api/v2/mailbox-style");
    const json = (await response.json()) as StyleResponse;
    if (response.ok) setData(json);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(command: Command) {
    const response = await fetch("/api/v2/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const json = (await response.json()) as { result?: { ok?: boolean; error?: string } };
    if (!response.ok || !json.result?.ok) {
      throw new Error(json.result?.error ?? "Could not save");
    }
  }

  return (
    <section className="mail-settings-section" aria-labelledby="mailbox-style-heading">
      <h2 id="mailbox-style-heading">How you use mail</h2>
      {data?.driftPrompt && (
        <p className="style-setup-reason">{data.driftPrompt}</p>
      )}
      {data?.confirmed ? (
        <p>
          {data.clearHabit === "leave"
            ? "Leave mail in Inbox; Focus hides what you clear."
            : data.clearHabit === "delete"
              ? "Delete mail you are done with."
              : "Archive mail you are done with."}{" "}
          Atlas bar: {data.matterBar}.
        </p>
      ) : (
        <p>Not confirmed yet — Seer is using an inferred guess.</p>
      )}
      <div className="style-setup-actions">
        <button type="button" className="mail-settings-button" onClick={() => setOpen(true)}>
          Train again
        </button>
        {data?.driftPrompt && (
          <button
            type="button"
            className="mail-settings-button"
            onClick={() => void post({ type: "dismissStyleDrift" }).then(load)}
          >
            Keep this style
          </button>
        )}
      </div>
      {open && (
        <MailboxStyleSetup
          force
          onCommand={post}
          onDone={() => {
            setOpen(false);
            void load();
          }}
          onTrain={() => {
            setOpen(false);
            window.location.hash = "#section=cards";
          }}
        />
      )}
    </section>
  );
}
