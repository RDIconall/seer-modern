import { promises as fs } from "fs";
import path from "path";
import type { TriageAction } from "@/lib/inbox/classify";

const DATA_DIR =
  process.env.SEER_DATA_DIR ||
  path.join(process.cwd(), ".data");

const OVERRIDES_FILE = "sender-overrides.json";

type OverrideMap = Record<string, TriageAction>;

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readOverrides(): Promise<OverrideMap> {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, OVERRIDES_FILE), "utf8");
    return JSON.parse(raw) as OverrideMap;
  } catch {
    return {};
  }
}

async function writeOverrides(map: OverrideMap) {
  await ensureDir();
  await fs.writeFile(
    path.join(DATA_DIR, OVERRIDES_FILE),
    JSON.stringify(map, null, 2),
    "utf8",
  );
}

export async function getSenderOverride(
  fromEmail: string,
): Promise<TriageAction | null> {
  const map = await readOverrides();
  return map[fromEmail.toLowerCase()] ?? null;
}

export async function setSenderOverride(
  fromEmail: string,
  action: TriageAction,
) {
  const map = await readOverrides();
  map[fromEmail.toLowerCase()] = action;
  await writeOverrides(map);
}

export async function listSenderOverrides(): Promise<
  { email: string; action: TriageAction }[]
> {
  const map = await readOverrides();
  return Object.entries(map).map(([email, action]) => ({ email, action }));
}
