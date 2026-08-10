"use client";

import type { InboxView } from "@/lib/v2/view/types";

/**
 * "Worth your time": the small, deliberately short list of reading Seer surfaced
 * because it matched something the user actually cares about. Rendered from the
 * server projection.
 */
export function WorthReading({ view }: { view: InboxView }) {
  if (view.worthReading.length === 0) return null;
  return (
    <section className="seer-worth-reading" aria-label="Worth your time">
      <h2>Worth your time</h2>
      <ul>
        {view.worthReading.map((y, i) => (
          <li key={i}>
            <span className="seer-reading-headline">{y.headline}</span>
            {y.detail && <span className="seer-reading-detail">{y.detail}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
