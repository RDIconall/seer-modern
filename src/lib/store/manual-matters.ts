import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * MATTERS THE USER AUTHORED — titles they chose, matters they created.
 * The model never overwrites these: a rebuild reapplies renames as ground
 * truth and appends manual matters to whatever it found on its own.
 */

export type ManualMatter = {
  id: string;
  title: string;
  orgUnit?: string;
  goal?: string;
  nextAction?: string;
  emailIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type MatterEdits = {
  /** matterId → the title the user gave it */
  renames: Record<string, { title: string; at: string }>;
  manual: ManualMatter[];
};

const EMPTY: MatterEdits = { renames: {}, manual: [] };

function keyFor(accountEmail: string) {
  return `matter-edits:${accountKey(accountEmail)}`;
}

export async function loadMatterEdits(
  accountEmail: string,
): Promise<MatterEdits> {
  const stored = await kvGet<MatterEdits>(keyFor(accountEmail));
  return stored ? { renames: stored.renames ?? {}, manual: stored.manual ?? [] } : EMPTY;
}

async function save(accountEmail: string, edits: MatterEdits) {
  await kvSet(keyFor(accountEmail), edits);
}

export async function renameMatter(
  accountEmail: string,
  matterId: string,
  title: string,
): Promise<MatterEdits> {
  const edits = await loadMatterEdits(accountEmail);
  const manual = edits.manual.find((m) => m.id === matterId);
  if (manual) {
    manual.title = title;
    manual.updatedAt = new Date().toISOString();
  } else {
    edits.renames[matterId] = { title, at: new Date().toISOString() };
  }
  await save(accountEmail, edits);
  return edits;
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "matter"
  );
}

export async function createMatter(
  accountEmail: string,
  input: {
    title: string;
    emailIds?: string[];
    orgUnit?: string;
    goal?: string;
    nextAction?: string;
  },
): Promise<{ edits: MatterEdits; matter: ManualMatter }> {
  const edits = await loadMatterEdits(accountEmail);
  const now = new Date().toISOString();
  const base = `mine-${slug(input.title)}`;
  let id = base;
  for (let n = 2; edits.manual.some((m) => m.id === id); n++) id = `${base}-${n}`;
  const matter: ManualMatter = {
    id,
    title: input.title.slice(0, 120),
    orgUnit: input.orgUnit,
    goal: input.goal?.slice(0, 200),
    nextAction: input.nextAction?.slice(0, 200),
    emailIds: [...new Set(input.emailIds ?? [])],
    createdAt: now,
    updatedAt: now,
  };
  edits.manual.push(matter);
  await save(accountEmail, edits);
  return { edits, matter };
}

export async function addToMatter(
  accountEmail: string,
  matterId: string,
  emailIds: string[],
): Promise<MatterEdits> {
  const edits = await loadMatterEdits(accountEmail);
  const m = edits.manual.find((x) => x.id === matterId);
  if (m) {
    m.emailIds = [...new Set([...m.emailIds, ...emailIds])];
    m.updatedAt = new Date().toISOString();
    await save(accountEmail, edits);
  }
  return edits;
}

export async function deleteMatter(
  accountEmail: string,
  matterId: string,
): Promise<MatterEdits> {
  const edits = await loadMatterEdits(accountEmail);
  edits.manual = edits.manual.filter((m) => m.id !== matterId);
  delete edits.renames[matterId];
  await save(accountEmail, edits);
  return edits;
}
