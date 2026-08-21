import type { AtlasSection, MatterCard } from "./types";

export type MatterOrder = Record<string, string[]>;

export function applyMatterOrder(
  sections: AtlasSection[],
  order: MatterOrder,
): AtlasSection[] {
  return sections.map((section) => {
    const rank = new Map(
      (order[section.name] ?? []).map((id, index) => [id, index]),
    );
    return {
      ...section,
      matters: section.matters
        .map((matter, index) => ({ matter, index }))
        .sort((a, b) => {
          const ar = rank.get(a.matter.matterId);
          const br = rank.get(b.matter.matterId);
          if (ar !== undefined && br !== undefined) return ar - br;
          if (ar !== undefined) return -1;
          if (br !== undefined) return 1;
          return a.index - b.index;
        })
        .map(({ matter }) => matter),
    };
  });
}

export type MatterDrop = {
  matterId: string;
  targetSection: string;
  beforeMatterId?: string | null;
};

export type MatterDropResult = {
  sections: AtlasSection[];
  sourceSection: string;
  targetSection: string;
  sourceMatterIds: string[];
  targetMatterIds: string[];
};

/** Pure board move used by the optimistic client and tested independently. */
export function reorderMatterSections(
  sections: AtlasSection[],
  drop: MatterDrop,
): MatterDropResult {
  const source = sections.find((section) =>
    section.matters.some((matter) => matter.matterId === drop.matterId),
  );
  const target = sections.find(
    (section) => section.name === drop.targetSection,
  );
  if (!source || !target) {
    return {
      sections,
      sourceSection: source?.name ?? "",
      targetSection: target?.name ?? drop.targetSection,
      sourceMatterIds: source?.matters.map((matter) => matter.matterId) ?? [],
      targetMatterIds: target?.matters.map((matter) => matter.matterId) ?? [],
    };
  }

  let moved: MatterCard | undefined;
  const without = sections.map((section) => ({
    ...section,
    matters: section.matters.filter((matter) => {
      if (matter.matterId !== drop.matterId) return true;
      moved = matter;
      return false;
    }),
  }));
  if (!moved) {
    return {
      sections,
      sourceSection: source.name,
      targetSection: target.name,
      sourceMatterIds: source.matters.map((matter) => matter.matterId),
      targetMatterIds: target.matters.map((matter) => matter.matterId),
    };
  }

  const next = without.map((section) => {
    if (section.name !== target.name) return section;
    const matters = [...section.matters];
    const before = drop.beforeMatterId
      ? matters.findIndex((matter) => matter.matterId === drop.beforeMatterId)
      : -1;
    const inserted = { ...moved!, section: target.name };
    if (before >= 0) matters.splice(before, 0, inserted);
    else matters.push(inserted);
    return { ...section, matters };
  });

  return {
    sections: next,
    sourceSection: source.name,
    targetSection: target.name,
    sourceMatterIds:
      next
        .find((section) => section.name === source.name)
        ?.matters.map((matter) => matter.matterId) ?? [],
    targetMatterIds:
      next
        .find((section) => section.name === target.name)
        ?.matters.map((matter) => matter.matterId) ?? [],
  };
}
