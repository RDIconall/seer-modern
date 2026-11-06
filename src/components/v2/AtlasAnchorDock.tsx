"use client";

import * as React from "react";
import type { AtlasAnchor } from "@/lib/v2/whiteboard/anchor";

const KIND_LABEL: Record<AtlasAnchor["kind"], string> = {
  matter: "Atlas",
  item: "Whiteboard",
  task: "Bot",
};

/**
 * The selected Atlas object, pinned next to the open email so Conall never
 * loses which task the thread belongs to.
 */
export function AtlasAnchorDock({
  anchor,
  placement,
}: {
  anchor: AtlasAnchor;
  placement: "list" | "reader";
}) {
  return (
    <aside
      className={`atlas-anchor atlas-anchor-${placement}`}
      data-atlas-anchor={anchor.kind}
      aria-label={`${KIND_LABEL[anchor.kind]} context for the open email`}
    >
      <span className="atlas-anchor-kicker tabular">{KIND_LABEL[anchor.kind]}</span>
      <strong className="atlas-anchor-title">{anchor.title}</strong>
      <span className="atlas-anchor-meta tabular">
        {anchor.section}
        {anchor.status ? ` · ${anchor.status.replaceAll("_", " ")}` : ""}
        {anchor.owner ? ` · ${anchor.owner}` : ""}
      </span>
      {anchor.nextAction ? (
        <span className="atlas-anchor-next">{anchor.nextAction}</span>
      ) : null}
    </aside>
  );
}
