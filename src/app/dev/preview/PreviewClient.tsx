"use client";

import { useState } from "react";
import { Atlas } from "@/components/v2/Atlas";
import { Triage } from "@/components/v2/Triage";
import type { InboxView } from "@/lib/v2/view/types";
import { sampleView } from "./sample";

/** Dev harness: both v2 surfaces against a fixed, representative view. */
export function PreviewClient() {
  const [view, setView] = useState<InboxView>(sampleView);
  const [tab, setTab] = useState<"atlas" | "triage">("atlas");

  // Commands are not wired here; the optimistic update alone shows the effect.
  const dispatch = async (
    _command: unknown,
    optimistic?: (v: InboxView) => InboxView,
  ) => {
    if (optimistic) setView((current) => optimistic(current));
    return null;
  };

  return (
    <div className="seer-app">
      <header className="seer-topbar">
        <nav role="tablist" aria-label="Views">
          <button
            role="tab"
            aria-selected={tab === "atlas"}
            onClick={() => setTab("atlas")}
          >
            Atlas
          </button>
          <button
            role="tab"
            aria-selected={tab === "triage"}
            onClick={() => setTab("triage")}
          >
            Triage
          </button>
        </nav>
        <span className="seer-coverage">
          {view.coverage.read} of {view.coverage.providerTotal} read
        </span>
      </header>
      <main>
        {tab === "atlas" ? (
          <Atlas view={view} />
        ) : (
          <Triage view={view} dispatch={dispatch} />
        )}
      </main>
    </div>
  );
}
