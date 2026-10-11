import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Jev usage counters: how often each ADD-only Jev use is called, how often
 * it actually adds its signal, and how often it is skipped or fails. The MCP
 * server and `memd stats` are separate processes, so the counts are persisted
 * as an append-only JSONL next to the DB.
 *
 * A line is {ts, use, event} and nothing else: no query, no content, no
 * scores. Recording is fail-open (a write error is swallowed) and never
 * changes what the caller returns.
 *
 * Events, per use:
 *  - call: a request was sent (Jev enabled, not skipped)
 *  - fired: the use added its signal (judged_miss / a conflict warning / the note)
 *  - skipped_sensitive: not sent because the state touched a sensitive topic
 *  - error: sent, but timed out, failed, or came back unusable
 */
export const JEV_USES = ["miss-judge", "save-conflict", "disagree-note"] as const;
export type JevUse = (typeof JEV_USES)[number];
export const JEV_EVENTS = ["call", "fired", "skipped_sensitive", "error"] as const;
export type JevEvent = (typeof JEV_EVENTS)[number];

/** Past this size the log rotates to .1 (one generation kept), so it stays small. */
export const JEV_USAGE_MAX_BYTES = 1_048_576;

export function jevUsagePath(root?: string): string {
  return path.join(root ?? path.dirname(config.dbPath), "jev-usage.jsonl");
}

export function recordJevUsage(use: JevUse, event: JevEvent, root?: string): void {
  try {
    const file = jevUsagePath(root);
    try {
      if (fs.statSync(file).size >= JEV_USAGE_MAX_BYTES) fs.renameSync(file, file + ".1");
    } catch {
      // no file yet
    }
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), use, event }) + "\n");
  } catch {
    // fail-open: counting must never break a search or a save
  }
}

export type JevUsageCounts = Record<JevUse, Record<JevEvent, number>>;

/** Totals across the current log and its one rotated generation, plus the oldest ts seen. */
export function readJevUsage(root?: string): { counts: JevUsageCounts; since?: string } {
  const counts = Object.fromEntries(JEV_USES.map((u) => [u, Object.fromEntries(JEV_EVENTS.map((e) => [e, 0]))])) as JevUsageCounts;
  let since: string | undefined;
  const file = jevUsagePath(root);
  for (const f of [file + ".1", file]) {
    let raw: string;
    try {
      raw = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let r: { ts?: unknown; use?: unknown; event?: unknown };
      try {
        r = JSON.parse(line);
      } catch {
        continue; // a torn last line from a crash
      }
      if (!JEV_USES.includes(r.use as JevUse) || !JEV_EVENTS.includes(r.event as JevEvent)) continue;
      counts[r.use as JevUse][r.event as JevEvent]++;
      if (typeof r.ts === "string" && (!since || r.ts < since)) since = r.ts;
    }
  }
  return { counts, since };
}

/** One line per use for `memd stats`. */
export function jevUsageLines(root?: string): string[] {
  const { counts, since } = readJevUsage(root);
  const any = JEV_USES.some((u) => JEV_EVENTS.some((e) => counts[u][e] > 0));
  if (!any) return ["jev usage: none recorded"];
  return [
    `jev usage since ${since!.slice(0, 10)} (calls / fired / skipped-sensitive / errors):`,
    ...JEV_USES.map((u) => {
      const c = counts[u];
      return `  ${u}: ${c.call} / ${c.fired} / ${c.skipped_sensitive} / ${c.error}`;
    }),
  ];
}
