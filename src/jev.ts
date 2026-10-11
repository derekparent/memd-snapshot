import { redactQuery } from "./redact.js";
import { JevUse, recordJevUsage } from "./jevusage.js";

/**
 * TypeSafe "Jev" client: an optional judgment call on search results, opt-in,
 * with a second scrub on the way out and an off switch that fails off.
 *
 * THE BOUNDING RULE for every caller: Jev may ADD a flag, a log line or a
 * warning. It may never remove one, and it never gates anything. Hence this
 * client never throws and returns undefined on ANY failure — timeout, 429,
 * 5xx, bad JSON, no key, switched off — and undefined means "no signal",
 * never "clean".
 *
 * OUTBOUND SCRUB: every string anywhere in `state` or the questions passes
 * redactQuery() (redact() plus the strict prose pass) HERE, at the one place
 * a request body is built, so no caller can forget. Excerpts were already
 * redacted at ingest; this is the second scrub.
 */

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
/** Pinned, not `jev-latest`: an alias move silently changes answers and thresholds. */
export const JEV_MODEL = "jev-1.13.0";
export const JEV_TIMEOUT_MS = 3000;

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export interface JevAnswer {
  noul?: number;
  score?: number;
  choice?: string;
  confidence?: number;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  model: string;
  ms: number;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
}>;

export interface JevOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Which use is asking; set, the call is counted in jev-usage.jsonl (src/jevusage.ts). */
  use?: JevUse;
  /** Directory for jev-usage.jsonl (tests); default: next to the DB. */
  usageRoot?: string;
}

/**
 * Opt-in, and the switch fails toward OFF: it guards a data-egress path, so it
 * is off unless MEMD_JEV=on (or 1/true/yes) AND a key is present — a key that
 * merely happens to be in the environment must not open it. Anyone who writes
 * MEMD_JEV=off (or false/no/disabled/0) gets exactly that, and a value we do
 * not recognise is treated as off too, not as on.
 */
const JEV_ON = new Set(["1", "true", "on", "yes"]);
const JEV_OFF = new Set(["0", "false", "off", "no", "disabled"]);

export function jevStatus(env: Record<string, string | undefined> = process.env): { enabled: boolean; reason: string } {
  const raw = env.MEMD_JEV;
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return { enabled: false, reason: "disabled (opt-in: set MEMD_JEV=on and TYPESAFE_API_KEY)" };
  if (JEV_OFF.has(v)) return { enabled: false, reason: `disabled (MEMD_JEV=${raw})` };
  if (!JEV_ON.has(v)) return { enabled: false, reason: `disabled (unrecognised MEMD_JEV value ${JSON.stringify(raw)})` };
  if (!env.TYPESAFE_API_KEY) return { enabled: false, reason: "disabled (no TYPESAFE_API_KEY in this process's env)" };
  return { enabled: true, reason: `enabled (${JEV_MODEL})` };
}

/**
 * Sensitive-topic list. Redaction removes secret VALUES; it does not stop a
 * medical or tax excerpt from leaving as search context. If any string in
 * `state` touches one of these, the request is not sent — "no signal", same as
 * a timeout. Prefix matches on purpose (passwords, credentials, banking):
 * over-skipping only costs recall. Override with MEMD_JEV_SENSITIVE_TERMS
 * (comma-separated regex fragments); an empty override is ignored, so the list
 * can be changed but never switched off.
 */
export const DEFAULT_SENSITIVE_TERMS = ["tax", "w-?2", "1099", "ssn", "password", "credential", "secret", "\\.env", "bank", "routing", "medical", "hipaa"];
const envTerms = (process.env.MEMD_JEV_SENSITIVE_TERMS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
export const SENSITIVE_TERMS = envTerms.length ? envTerms : DEFAULT_SENSITIVE_TERMS;
const SENSITIVE_RE = new RegExp(`(?<![A-Za-z0-9])(?:${SENSITIVE_TERMS.join("|")})`, "i");

let skippedSensitive = 0;
/** Requests not sent because state touched a sensitive topic, this process. */
export function jevSkippedSensitive(): number {
  return skippedSensitive;
}

function touchesSensitive(v: unknown): boolean {
  if (typeof v === "string") return SENSITIVE_RE.test(v);
  if (Array.isArray(v)) return v.some(touchesSensitive);
  if (v && typeof v === "object") return Object.values(v).some(touchesSensitive);
  return false;
}

/** Deep-scrub every string value. Keys are ours (ids, field names), values are not. */
export function scrub<T>(v: T): T {
  if (typeof v === "string") return redactQuery(v) as T;
  if (Array.isArray(v)) return v.map(scrub) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrub(x);
    return out as T;
  }
  return v;
}

export async function askJev(state: unknown, questions: Record<string, JevQuestion>, opts: JevOptions = {}): Promise<JevResult | undefined> {
  const env = opts.env ?? process.env;
  if (!jevStatus(env).enabled) return undefined;
  // Checked on the raw state, before scrubbing: never log or send the text.
  const count = (event: "call" | "skipped_sensitive" | "error") => {
    if (opts.use) recordJevUsage(opts.use, event, opts.usageRoot);
  };
  if (touchesSensitive(state)) {
    skippedSensitive++;
    count("skipped_sensitive");
    return undefined;
  }
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  count("call");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? JEV_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await doFetch(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json", "User-Agent": "memd/0.1" },
      body: JSON.stringify({ state: scrub(state), model: JEV_MODEL, questions: scrub(questions) }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      count("error");
      return undefined;
    }
    const body = await res.json();
    if (!body || typeof body.answers !== "object") {
      count("error");
      return undefined;
    }
    return { answers: body.answers, model: typeof body.model === "string" ? body.model : JEV_MODEL, ms: Date.now() - t0 };
  } catch {
    count("error");
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
