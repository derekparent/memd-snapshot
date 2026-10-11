import { askJev, JevOptions, JevQuestion } from "./jev.js";
import type { SearchHit } from "./search.js";
import { recordJevUsage } from "./jevusage.js";

/**
 * Stale-ruling banner. The failure it targets: search returns an old
 * ruling and a newer one that replaced it, ranked by similarity, and the
 * reader takes whichever came first. In evaluation, memd's own ranking put
 * four off-topic facts above the answer and an old ruling next to the newer
 * one that had replaced it.
 *
 * One Jev request over the top passages asks:
 *  - rel_<k>: a Score — how directly does the passage answer the query;
 *  - pair_<a>_<b>: a Choice for every pair — same position, conflicting
 *    positions, or at least one silent. Generic, so nothing is hard-coded per
 *    topic (the evaluation's echo-specific options were not reusable).
 * In CODE (Jev cannot compare dates): the reference is the newest on-topic
 * passage from the CURRENT layer (a fact or doc). An episode's date is when
 * the text was SAID, not when a position was adopted — the evaluation data
 * included a tool_result quoting a stale, already-superseded ruling — so an
 * episode may be flagged as conflicting but never be the reference. Older
 * CURRENT passages, and episodes of any date, that conflict with the
 * reference at adequate confidence are named. When only episodes are
 * on-topic the note is NEUTRAL: it lists who disagrees and names no winner.
 *
 * TRIGGER: the query regex is tuned to match a meaningful share of
 * ruling-shaped mem_search queries without over-triggering. The hits trigger is kind
 * "ruling" only: with ruling|decision|constraint it covered a majority of
 * active facts — most searches would pay a response-path round trip if the
 * trigger were broadened that far.
 *
 * KNOWN MISS (labeled set A): a "some repos vs all repos" nuance can read as
 * same_position, so a stale passage may go unflagged. An under-flag costs
 * nothing beyond today's behaviour.
 *
 * Bounding rule: a NOTE only. Hits are never reordered or dropped; any
 * failure, timeout or missing answer means no note. This sits on the response
 * path, so it runs only when the trigger fires, with a short hard timeout.
 */

export const BANNER_TOP = 6;
export const BANNER_TIMEOUT_MS = 2000;
/** Score scale 0..2 (three levels). Measured on-topic 1.6–2.0, off-topic ≤ 0.83. */
export const ON_TOPIC_MIN = 1.3;
export const CONFLICT_CONFIDENCE_MIN = 0.6;
const PASSAGE_CHARS = 500;


const RULING_QUERY =
  /\b(rul(e|es|ed|ing|ings)|posture|polic(y|ies)|decid(e|ed|es)|decision|allowed|permitted|still|current(ly)?|supersede[sd]?)\b/i;

/** Only questions that could have a stale answer pay the Jev round-trip. */
export function bannerTriggered(query: string, hits: SearchHit[]): boolean {
  return RULING_QUERY.test(query) || hits.slice(0, BANNER_TOP).some((h) => h.source === "fact" && h.kind === "ruling");
}

function label(h: SearchHit): string {
  const where = h.source === "fact" ? `fact #${h.id}` : h.source === "doc" ? `doc ${h.path ?? "#" + h.id}` : `episode #${h.id}`;
  return `${h.ts.slice(0, 10)}, ${h.project}, ${where}`;
}

export async function staleRulingNote(query: string, hits: SearchHit[], opts: JevOptions = {}): Promise<string | undefined> {
  const note = await decideNote(query, hits, opts);
  if (note) recordJevUsage("disagree-note", "fired", opts.usageRoot);
  return note;
}

async function decideNote(query: string, hits: SearchHit[], opts: JevOptions): Promise<string | undefined> {
  if (!bannerTriggered(query, hits)) return undefined;
  const top = hits.slice(0, BANNER_TOP);
  if (top.length < 2) return undefined;

  const passages: Record<string, string> = {};
  const questions: Record<string, JevQuestion> = {};
  top.forEach((h, i) => {
    passages[`p${i}`] = h.text.slice(0, PASSAGE_CHARS);
    questions[`rel_p${i}`] = {
      type: "score",
      instructions: `How directly does \`passages.p${i}\` answer \`query\`?`,
      criteria: [
        "Does not address the question in query",
        "Touches the topic of query but does not state an answer to it",
        "Directly states an answer to the question in query",
      ],
    };
  });
  for (let a = 0; a < top.length; a++) {
    for (let b = a + 1; b < top.length; b++) {
      questions[`pair_p${a}_p${b}`] = {
        type: "choice",
        instructions: `Regarding the question in \`query\`, how do \`passages.p${a}\` and \`passages.p${b}\` relate?`,
        criteria: {
          same_position: "Both state the same answer to the question in query",
          conflicting: "They state different answers to the question in query that cannot both hold at the same time",
          one_silent: "At least one of them does not state an answer to the question in query",
        },
      };
    }
  }

  const r = await askJev({ query, passages }, questions, { timeoutMs: BANNER_TIMEOUT_MS, use: "disagree-note", ...opts });
  if (!r) return undefined;

  const onTopic = top
    .map((h, i) => ({ h, i, rel: r.answers[`rel_p${i}`]?.score }))
    .filter((x) => typeof x.rel === "number" && x.rel >= ON_TOPIC_MIN);
  const conflicts = (a: { i: number }, b: { i: number }) => {
    const pair = r.answers[`pair_p${Math.min(a.i, b.i)}_p${Math.max(a.i, b.i)}`];
    return pair?.choice === "conflicting" && (pair.confidence ?? 0) >= CONFLICT_CONFIDENCE_MIN;
  };
  const current = onTopic.filter((x) => x.h.source !== "episode");

  if (!current.length) {
    // Episodes only: their dates cannot say which position is newer. Name no winner.
    const involved = onTopic.filter((x) => onTopic.some((y) => y !== x && conflicts(x, y)));
    if (!involved.length) return undefined;
    return (
      `NOTE: these results DISAGREE on this, and every disagreeing passage is a transcript excerpt (${involved.map((x) => label(x.h)).join("; ")}). ` +
      `Transcript dates are when something was said, not when it was decided — resolve against CURRENT state before relying on any of them. [judged by ${r.model}; hits are not reordered]`
    );
  }

  // Dates compared in code; ISO strings sort chronologically. Two FACTS
  // saved in the same millisecond tie on ts: the higher id was written later,
  // so it is the newer. Nothing else breaks a tie: doc chunks of one file
  // share its mtime and are equally current, and ids are not comparable
  // across tables (the order below only fixes which passage is quoted).
  const newer = (a: SearchHit, b: SearchHit) =>
    a.ts !== b.ts ? a.ts > b.ts : a.source === "fact" && b.source === "fact" && a.id > b.id;
  const order = (h: SearchHit) => [h.ts, h.source, String(h.id).padStart(12, "0")].join("\u0000");
  const newest = current.reduce((a, b) => (order(b.h) > order(a.h) ? b : a));
  const stale = onTopic.filter((x) => {
    if (x === newest) return false;
    // An older CURRENT passage, or an episode of ANY date (its date is when it was said).
    if (x.h.source !== "episode" && !newer(newest.h, x.h)) return false;
    return conflicts(x, newest);
  });
  if (!stale.length) return undefined;

  const quote = newest.h.text.replace(/\s+/g, " ").slice(0, 200);
  return (
    `NOTE: these results DISAGREE on this. The newest on-topic CURRENT passage (${label(newest.h)}) begins: "${quote}${newest.h.text.length > 200 ? "…" : ""}". ` +
    `${stale.length} other passage${stale.length > 1 ? "s" : ""} state${stale.length > 1 ? "" : "s"} a conflicting position (${stale.map((s) => label(s.h)).join("; ")}) — ` +
    `treat ${stale.length > 1 ? "them" : "it"} as possibly superseded and verify against CURRENT state before relying on either. [judged by ${r.model}; hits are not reordered]`
  );
}
