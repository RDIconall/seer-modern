import type { BotTaskStatus } from "./types";
import { DEFAULT_BOT_SLUG } from "./types";

export type SeedTaskRow = {
  externalKey: string;
  title: string;
  dateAsked: string;
  botName: string;
  botSlug: string;
  hisWords: string;
  currentState: string;
  nextAction: string;
  status: BotTaskStatus;
  priority: number;
};

export function slugifyBotName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return DEFAULT_BOT_SLUG;
  const slug = trimmed
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || DEFAULT_BOT_SLUG;
}

/**
 * Map the bot's current-state sentence onto Atlas statuses. The CSV is twenty
 * seven *open* tasks — "dropped" in a note is still work unless Conall closed
 * it in Atlas — so we never infer `done` or `dropped` from this text.
 */
export function inferOpenTaskStatus(currentState: string): BotTaskStatus {
  const text = currentState.toLowerCase();
  if (
    /\bblocked\b/.test(text) ||
    /lacks .+ access/.test(text) ||
    /google blocks bot sign-in/.test(text) ||
    /can't identify/.test(text) ||
    /couldn'?t get into/.test(text)
  ) {
    return "blocked";
  }
  if (
    /stuck at sign-in/.test(text) ||
    /needs a sign-in/.test(text) ||
    /needs conall/.test(text) ||
    /waiting on/.test(text) ||
    /values not received/.test(text) ||
    /asked for the kaptan/.test(text) ||
    /once ok'?d/.test(text)
  ) {
    return "waiting_on_user";
  }
  if (
    /\brunning\b/.test(text) ||
    /\bdrafted\b/.test(text) ||
    /already filed/.test(text) ||
    /merges\/handoffs done/.test(text) ||
    /request sent/.test(text) ||
    /risk check live/.test(text) ||
    /twice-daily check/.test(text) ||
    /partial:/.test(text) ||
    /done except/.test(text)
  ) {
    return "in_progress";
  }
  return "open";
}

/** RFC 4180-ish CSV: commas inside quotes, doubled quotes as escape. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  return rows;
}

export function tasksFromCsv(text: string): SeedTaskRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const idx = (name: string) => {
    const at = header.indexOf(name);
    if (at < 0) throw new Error(`bot_tasks.csv missing column ${name}`);
    return at;
  };
  const col = {
    id: idx("id"),
    task: idx("task"),
    date: idx("date_asked"),
    bot: idx("bot"),
    words: idx("his_words"),
    state: idx("current_state"),
    next: idx("next_action"),
  };
  return rows.slice(1).map((cells, index) => {
    const botName = (cells[col.bot] ?? "").trim();
    const currentState = cells[col.state] ?? "";
    return {
      externalKey: (cells[col.id] ?? "").trim(),
      title: (cells[col.task] ?? "").trim(),
      dateAsked: (cells[col.date] ?? "").trim(),
      botName,
      botSlug: slugifyBotName(botName),
      hisWords: cells[col.words] ?? "",
      currentState,
      nextAction: cells[col.next] ?? "",
      status: inferOpenTaskStatus(currentState),
      priority: index + 1,
    };
  });
}
