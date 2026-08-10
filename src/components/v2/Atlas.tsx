"use client";

import type { InboxView } from "@/lib/v2/view/types";

/**
 * Atlas: the board of live matters. Each matter shows its conversations and the
 * business meaning Seer lifted out of the inbox and attached to it. Rendered
 * entirely from the server projection.
 */
export function Atlas({ view }: { view: InboxView }) {
  return (
    <section className="seer-atlas" aria-label="Atlas — live matters">
      {view.atlas.length === 0 && <p>No live matters yet.</p>}
      {view.atlas.map((matter) => (
        <article key={matter.matterId} className="seer-matter">
          <h2>{matter.title}</h2>
          {matter.orgUnit && <span className="seer-org">{matter.orgUnit}</span>}
          <ul className="seer-matter-conversations">
            {matter.conversations.map((c) => (
              <li key={c.conversationId}>
                <span className="seer-subject">{c.subject}</span>
                <span className="seer-from">{c.from}</span>
              </li>
            ))}
          </ul>
          {matter.yields.length > 0 && (
            <ul className="seer-matter-yields">
              {matter.yields.map((y, i) => (
                <li key={i}>{y.headline}</li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}
