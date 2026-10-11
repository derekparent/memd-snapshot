import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { redactQuery } from "./redact.js";
import { recordJevUsage } from "./jevusage.js";
import { askJev, JevOptions } from "./jev.js";

export { redactQuery };
import { contentWords } from "./search.js";
import { saveFact, SaveResult } from "./facts.js";
import type { DB } from "./db.js";

/**
 * Auto-capture of likely retrieval misses. The UNNOTICED failure class: a
 * project filter matched nothing, the caller read an empty result as "the
 * store has nothing on this", and nobody ever filed a report. Session-wrap
 * feedback (feedback.ts) only catches misses a session noticed; this catches
 * the shape of the ones it did not, from the search calls themselves.
 *
 * CODE TRIPWIRES FIRST. The tripwires are local and always on. An optional
 * judge (`MissJudge`, wired to Jev by the server only when Jev is enabled) may
 * ADD a "judged_miss" verdict to a record after it is written; it never removes
 * one and never delays the search.
 *
 * Contract with the search path: recording must add no latency and must never
 * throw into it. The server defers `recordSearch` past the response and it
 * swallows every error; a broken miss log costs the log, never a search.
 *
 * The MCP server is one process per Claude session, so "same session" for the
 * re-query tripwire is simply "same tracker instance".
 */

export type MissReason = "zero" | "thin" | "requery" | "judged_miss";

export interface SearchCall {
  query: string;
  project?: string;
  sources?: string[];
  origin?: string;
  /** Caller's requested limit, if any — "thin" is judged against it. */
  limit?: number;
  /** Hits as `source:id`, in rank order. */
  hits: string[];
  /** Top hits' text, for the judge only — never written to the log. */
  texts?: string[];
  /** Epoch ms; defaults to now. */
  at?: number;
}

export interface MissRecord {
  id: string;
  ts: string;
  pid: number;
  /** Redacted before it ever reaches disk. */
  query: string;
  project?: string;
  sources?: string[];
  origin?: string;
  result_count: number;
  /** Top hits as `source:id` — never hit text. */
  hits: string[];
  reasons: MissReason[];
  /** For "requery": the earlier query this one retried (redacted), and the gap. */
  prev_query?: string;
  gap_s?: number;
  /** "requery" by rewording: the shared content words that tied the two queries. */
  shared?: string[];
  /** "requery" by the same words under a changed project/sources/origin filter. */
  filters_changed?: boolean;
  /** The judge's verdict whenever one came back (whether or not it flagged). */
  jev?: { noul: number; model: string };
}

/**
 * A judge answers "do these results contain what the query asks?" as P(yes).
 * It may only ADD: a low score adds "judged_miss" to a record or creates one
 * the tripwires missed; a high score never removes or downgrades a tripwire.
 * undefined = no signal (fail open).
 */
export type MissJudge = (call: SearchCall) => Promise<{ noul: number; model: string } | undefined>;

/** Measured: misses ≤0.06, the one partial 0.28, answers ≥0.95. */
export const JUDGE_MISS_BELOW = 0.35;
/** A burst of searches must not become a burst of outbound calls: beyond this, skip the judge. */
export const JUDGE_MAX_IN_FLIGHT = 4;
const JUDGE_TOP = 5;
const JUDGE_CHARS = 600;

/**
 * The Noul from the Jev evaluation, over the top hits' text, truncated to
 * keep state small (accuracy drops as state fills with irrelevant text).
 * "or results is empty" in the false criterion is what made empty lists score
 * right — keep it.
 */
export function jevMissJudge(opts: JevOptions = {}): MissJudge {
  return async (call) => {
    const results = (call.texts ?? []).slice(0, JUDGE_TOP).map((t) => t.slice(0, JUDGE_CHARS));
    const r = await askJev(
      { query: call.query, results },
      {
        answers: {
          type: "noul",
          instructions: "Do `results` contain the information that `query` is asking for?",
          criteria: { true: "At least one result states the requested information", false: "No result states the requested information, or results is empty" },
        },
      },
      { use: "miss-judge", ...opts }
    );
    const noul = r?.answers?.answers?.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul)) return undefined;
    // Same rule the tracker applies (observeJudged); counted here, where the use is known.
    if (noul < JUDGE_MISS_BELOW) recordJevUsage("miss-judge", "fired", opts.usageRoot);
    return { noul, model: r!.model };
  };
}

export const MISS_THIN_BELOW = envInt("MEMD_MISS_THIN_BELOW", 3);
export const MISS_REQUERY_WINDOW_S = envInt("MEMD_MISS_REQUERY_WINDOW_S", 120);
export const MISS_LOG_MAX_BYTES = envInt("MEMD_MISS_LOG_MAX_BYTES", 1_048_576);

function envInt(name: string, def: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function missLogPath(root?: string): string {
  return path.join(root ?? path.dirname(config.dbPath), "misses.jsonl");
}

interface Prev {
  words: Set<string>;
  filters: string;
  query: string;
  project?: string;
  at: number;
}

/**
 * Content words of the REDACTED query, markers removed. Words feed the
 * `shared` field that goes to disk, so taking them from raw text wrote the
 * secret back out through a side door; and a marker left in would make any two
 * secret-bearing queries "share" the word "redacted".
 */
function queryWords(query: string): Set<string> {
  return new Set(contentWords(redactQuery(query).replace(/\[REDACTED:[A-Z_]+\]/g, " ")));
}

function projectWordSet(names: string[]): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    const lower = n.toLowerCase().trim();
    if (!lower) continue;
    out.add(lower);
    for (const seg of lower.split(/[-_.]+/)) if (seg) out.add(seg);
  }
  return out;
}

type Requery = { shared: string[] } | { filtersChanged: true };

function filterKey(c: SearchCall): string {
  return JSON.stringify([c.project?.toLowerCase() ?? null, [...(c.sources ?? [])].sort(), c.origin ?? null]);
}

export interface TrackerOptions {
  /** Directory holding misses.jsonl (tests); default: next to the DB. */
  root?: string;
  maxBytes?: number;
  thinBelow?: number;
  windowS?: number;
  /**
   * Known project names. A repo name shared by two queries says they are in
   * the same repo, not that one retried the other — in a single-repo session
   * that is nearly every consecutive pair. Cached; fetched lazily.
   */
  projects?: () => string[];
}

const PROJECTS_TTL_MS = 10 * 60_000;

export class MissTracker {
  private prev?: Prev;
  readonly file: string;
  private readonly maxBytes: number;
  private readonly thinBelow: number;
  private readonly windowMs: number;
  private readonly fetchProjects?: () => string[];
  private projectWords?: { at: number; words: Set<string> };

  constructor(opts: TrackerOptions = {}) {
    this.file = missLogPath(opts.root);
    this.maxBytes = opts.maxBytes ?? MISS_LOG_MAX_BYTES;
    this.thinBelow = opts.thinBelow ?? MISS_THIN_BELOW;
    this.windowMs = (opts.windowS ?? MISS_REQUERY_WINDOW_S) * 1000;
    this.fetchProjects = opts.projects;
  }

  /** Project names and their -_. segments ("FieldApp-ios" -> FieldApp, ios), lowercased. */
  private repoWords(call: SearchCall): Set<string> {
    const now = Date.now();
    if (this.fetchProjects && (!this.projectWords || now - this.projectWords.at > PROJECTS_TTL_MS)) {
      this.projectWords = { at: now, words: projectWordSet(this.fetchProjects()) };
    }
    const words = new Set(this.projectWords?.words ?? []);
    for (const w of projectWordSet([call.project ?? "", this.prev?.project ?? ""])) words.add(w);
    return words;
  }

  /** Which tripwires this call trips, given the previous call. */
  classify(call: SearchCall): MissReason[] {
    return this.evaluate(call).reasons;
  }

  private evaluate(call: SearchCall): { reasons: MissReason[]; rq?: Requery } {
    const reasons: MissReason[] = [];
    const n = call.hits.length;
    if (n === 0) reasons.push("zero");
    // A caller who asked for 2 and got 2 did not get a thin result.
    else if (n < Math.min(this.thinBelow, call.limit ?? Infinity)) reasons.push("thin");
    const rq = this.requery(call);
    if (rq) reasons.push("requery");
    return { reasons, rq };
  }

  /**
   * A retry of the previous search: inside the window, and EITHER reworded
   * (different content words that still share one — unrelated back-to-back
   * searches are normal and must not flood the log) OR the same words with a
   * changed filter (an "unscoped retry" — the caller did not trust what
   * the scoped search returned).
   */
  private requery(call: SearchCall): Requery | undefined {
    const p = this.prev;
    const at = call.at ?? Date.now();
    if (!p || at - p.at > this.windowMs || at < p.at) return undefined;
    const words = queryWords(call.query);
    const same = words.size === p.words.size && [...words].every((w) => p.words.has(w));
    if (same) return filterKey(call) !== p.filters ? { filtersChanged: true } : undefined;
    const repo = this.repoWords(call);
    const shared = [...words].filter((w) => p.words.has(w) && !repo.has(w));
    return shared.length ? { shared } : undefined;
  }

  /** Classify, append a record if any tripwire fired, remember the call. */
  observe(call: SearchCall): MissRecord | undefined {
    const step = this.step(call);
    return step.reasons.length ? this.write(call, step) : undefined;
  }

  /**
   * observe() plus a judge. Tripwire state advances SYNCHRONOUSLY, before any
   * await, so the next search's requery check never waits on (or races) the
   * judge. One record per call: tripwire reasons plus "judged_miss" if the
   * judge scored below JUDGE_MISS_BELOW. A failed judge leaves exactly the
   * record observe() would have written.
   */
  async observeJudged(call: SearchCall, judge?: MissJudge): Promise<MissRecord | undefined> {
    const step = this.step(call);
    // The tripwire record is written NOW, exactly as without a judge — never
    // held hostage to a network call that can take 3 s or die with the process.
    const rec = step.reasons.length ? this.write(call, step) : undefined;
    if (!judge || this.inFlight >= JUDGE_MAX_IN_FLIGHT) return rec;
    let verdict: { noul: number; model: string } | undefined;
    this.inFlight++;
    try {
      verdict = await judge(call);
    } catch {
      verdict = undefined;
    } finally {
      this.inFlight--;
    }
    if (!verdict) return rec;
    const judged = verdict.noul < JUDGE_MISS_BELOW;
    const jev = { noul: Math.round(verdict.noul * 1000) / 1000, model: verdict.model };
    if (rec) {
      // Annotate by appending a second line under the same id; readMisses merges.
      this.appendLine({ id: rec.id, judge: true, jev, ...(judged ? { reasons: ["judged_miss" as MissReason] } : {}) });
      return { ...rec, jev, reasons: judged ? [...rec.reasons, "judged_miss"] : rec.reasons };
    }
    return judged ? this.write(call, { ...step, reasons: ["judged_miss"] }, verdict) : undefined;
  }

  private inFlight = 0;

  private step(call: SearchCall): { at: number; reasons: MissReason[]; rq?: Requery; prev?: Prev } {
    const at = call.at ?? Date.now();
    const { reasons, rq } = this.evaluate(call);
    const prev = this.prev;
    this.prev = { words: queryWords(call.query), filters: filterKey(call), query: call.query, project: call.project, at };
    return { at, reasons, rq, prev };
  }

  private write(
    call: SearchCall,
    { at, reasons, rq, prev }: { at: number; reasons: MissReason[]; rq?: Requery; prev?: Prev },
    verdict?: { noul: number; model: string }
  ): MissRecord {
    const rec: MissRecord = {
      id: randomBytes(4).toString("hex"),
      ts: new Date(at).toISOString(),
      pid: process.pid,
      query: redactQuery(call.query),
      project: call.project,
      sources: call.sources,
      origin: call.origin,
      result_count: call.hits.length,
      hits: call.hits.slice(0, 10),
      reasons,
    };
    if (rq && prev) {
      rec.prev_query = redactQuery(prev.query);
      rec.gap_s = Math.round((at - prev.at) / 1000);
      if ("shared" in rq) rec.shared = rq.shared;
      else rec.filters_changed = true;
    }
    if (verdict) rec.jev = { noul: Math.round(verdict.noul * 1000) / 1000, model: verdict.model };
    this.append(rec);
    return rec;
  }

  /** Bounded: one rotated generation, so the log never exceeds ~2× maxBytes. */
  private append(rec: MissRecord): void {
    this.appendLine(rec);
  }

  private appendLine(line: MissRecord | JudgeLine): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      /* no log yet */
    }
    if (size >= this.maxBytes) fs.renameSync(this.file, this.file + ".1");
    fs.appendFileSync(this.file, JSON.stringify(line) + "\n");
  }
}

/**
 * The only entry point the search path calls. Deferred past the response and
 * error-proof: a miss log that cannot be written is a lost log line, never a
 * failed or slowed search.
 */
export function recordSearch(tracker: MissTracker, call: SearchCall, judge?: MissJudge): void {
  setImmediate(() => {
    tracker.observeJudged(call, judge).catch(() => {
      /* fail open — see contract above */
    });
  });
}

/** A judge verdict appended after its record; merged into it by id on read. */
interface JudgeLine {
  id: string;
  judge: true;
  jev: { noul: number; model: string };
  reasons?: MissReason[];
}

/**
 * Recorded misses, newest first (current file, then the rotated one), with
 * judge lines merged into their records by id. A judge line whose record
 * rotated away is dropped — it carries no query to show.
 */
export function readMisses(opts: { root?: string; limit?: number } = {}): MissRecord[] {
  const file = missLogPath(opts.root);
  const out: MissRecord[] = [];
  const judged = new Map<string, JudgeLine[]>();
  for (const f of [file, file + ".1"]) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.judge) judged.set(row.id, [...(judged.get(row.id) ?? []), row]);
        else out.push(row);
      } catch {
        /* torn trailing line from a concurrent writer — skip it */
      }
    }
  }
  for (const rec of out) {
    for (const j of judged.get(rec.id) ?? []) {
      rec.jev = j.jev;
      for (const r of j.reasons ?? []) if (!rec.reasons.includes(r)) rec.reasons.push(r);
    }
  }
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export function findMiss(id: string, root?: string): MissRecord | undefined {
  return readMisses({ root }).find((r) => r.id === id);
}

/**
 * The explicit step from a captured miss to a kind:'feedback' fact. Explicit
 * on purpose: the log is a noisy tripwire stream, and auto-promoting every
 * line would be the recall flood the feedback-facts ruling warned about. The
 * content leads with "memd retrieval miss" so the fact is findable by the
 * queries allowed to see it (wantsFeedback).
 */
export function missFactContent(rec: MissRecord, note?: string): string {
  const scope = [rec.project && `project=${rec.project}`, rec.sources && `sources=${rec.sources.join(",")}`, rec.origin && `origin=${rec.origin}`]
    .filter(Boolean)
    .join(" ");
  let s = `memd retrieval miss (auto-captured ${rec.ts}, ${rec.reasons.join("+")}): query ${JSON.stringify(rec.query)}${scope ? ` [${scope}]` : ""} returned ${rec.result_count} hit(s)`;
  if (rec.prev_query !== undefined) s += `, ${rec.gap_s}s after ${JSON.stringify(rec.prev_query)}`;
  s += ".";
  if (note) s += ` Note: ${note}`;
  return s;
}

/**
 * `memd misses promote`. Tagged project "memd", NOT the missed call's filter:
 * that filter is often the typo the miss is about, and it is already quoted in
 * the content. Promoting the same miss with the same note twice is a no-op
 * (exact-duplicate guard).
 */
export function promoteMiss(db: DB, id: string, opts: { root?: string; note?: string } = {}): SaveResult {
  const rec = findMiss(id, opts.root);
  if (!rec) throw new Error(`no captured miss with id ${id} (memd misses lists them)`);
  return saveFact(db, { content: missFactContent(rec, opts.note), project: "memd", kind: "feedback" });
}
