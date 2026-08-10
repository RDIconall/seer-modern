"use client";

import type { InboxView, DeleteRow } from "@/lib/v2/view/types";
import type { Command } from "@/lib/v2/commands/types";

/**
 * Triage: delete and close-out, nothing else. "Safe to delete" rows come from
 * the server with a signed token; the client renders them and dispatches the
 * delete command — it never decides what is deletable. Records are the close-out
 * pile. Undecided stays visible and is never near a bulk action.
 */
export function Triage({
  view,
  dispatch,
}: {
  view: InboxView;
  dispatch: (command: Command, optimistic?: (v: InboxView) => InboxView) => Promise<unknown>;
}) {
  const deleteRow = (row: DeleteRow) =>
    dispatch(
      { type: "delete", conversationId: row.conversationId, deleteToken: row.deleteToken },
      (v) => ({
        ...v,
        safeToDelete: v.safeToDelete.filter((r) => r.conversationId !== row.conversationId),
      }),
    );

  return (
    <section className="seer-triage" aria-label="Triage">
      <h2>Safe to delete ({view.safeToDelete.length})</h2>
      <table>
        <tbody>
          {view.safeToDelete.map((row) => (
            <tr key={row.conversationId}>
              <td>{row.from}</td>
              <td>{row.subject}</td>
              <td>{row.summary}</td>
              <td>
                <button type="button" onClick={() => deleteRow(row)}>
                  Delete
                </button>
                <a href={row.nativeUrl} target="_blank" rel="noopener noreferrer">
                  Open
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Close out — records ({view.records.length})</h2>
      <ul>
        {view.records.map((row) => (
          <li key={row.conversationId}>
            {row.from} — {row.subject}
          </li>
        ))}
      </ul>

      {view.undecided.length > 0 && (
        <>
          <h2>Needs a look ({view.undecided.length})</h2>
          <ul>
            {view.undecided.map((row) => (
              <li key={row.conversationId}>
                {row.from} — {row.subject}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
