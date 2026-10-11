import type { DB } from "./db.js";
import type { SearchHit } from "./search.js";

/**
 * Stale-echo marker. A HISTORY hit that quotes a superseded fact reads as a
 * live position, with nothing on the hit saying so. This only ADDS a marker.
 * It never reorders or removes a hit.
 *
 * A hit is marked when, for a chain head that is itself in the same response:
 *  - the episode predates the supersede of one of that head's predecessors, and
 *  - it repeats a CONTIGUOUS stretch of at least ECHO_MIN_SPAN words of that
 *    predecessor, made only of runs (ECHO_WORDS consecutive words) that the
 *    head does NOT also contain (wording the head kept is current). Counting
 *    runs over-credits one path or address: five overlapping runs are a single
 *    10-word span. So the rule is the longest contiguous span, and 17 words is
 *    the threshold that held up on hand-labelled samples,
 *  - and it shares NO run with the head that the predecessor lacks: an episode
 *    quoting the current wording is reporting the change, not the stale view.
 */
export const ECHO_WORDS = 6;
export const ECHO_MIN_SPAN = 17;

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function shingles(text: string, n = ECHO_WORDS): Set<string> {
  const w = norm(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

/** Longest contiguous stretch of `words` covered by runs that are in `runs`. */
export function longestSpan(words: string[], runs: Set<string>): number {
  const covered = new Array<boolean>(words.length).fill(false);
  for (let i = 0; i + ECHO_WORDS <= words.length; i++) {
    if (runs.has(words.slice(i, i + ECHO_WORDS).join(" "))) for (let j = i; j < i + ECHO_WORDS; j++) covered[j] = true;
  }
  let best = 0;
  let cur = 0;
  for (const c of covered) {
    cur = c ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
}

/** Every superseded fact whose chain ends at `headId`, nearest first. */
export function chainPredecessors(db: DB, headId: number): { id: number; content: string; valid_to: string }[] {
  return db
    .prepare(
      `WITH RECURSIVE prev(id, content, valid_to, d) AS (
         SELECT id, content, valid_to, 1 FROM facts WHERE superseded_by = ? AND valid_to IS NOT NULL
         UNION ALL
         SELECT f.id, f.content, f.valid_to, p.d + 1 FROM facts f JOIN prev p ON f.superseded_by = p.id
         WHERE f.valid_to IS NOT NULL AND p.d < 100
       )
       SELECT id, content, valid_to FROM prev ORDER BY d`
    )
    .all(headId) as { id: number; content: string; valid_to: string }[];
}

/** Sets `quotesSuperseded` on HISTORY hits that echo a superseded wording of a head in `hits`. Mutates in place. */
export function markStaleEchoes(db: DB, hits: SearchHit[]): void {
  const heads = hits.filter((h) => h.source === "fact");
  const episodes = hits.filter((h) => h.source === "episode");
  if (!heads.length || !episodes.length) return;
  const epWords = new Map(episodes.map((e) => [e, norm(e.text).split(" ").filter(Boolean)]));
  const epShingles = new Map(episodes.map((e) => [e, shingles(e.text)]));
  for (const head of heads) {
    const preds = chainPredecessors(db, head.id);
    if (!preds.length) continue;
    // Shingle the head's stored content, not head.text: the hit text can be clipped, and a clipped head
    // would look like it dropped wording it actually kept.
    const row = db.prepare("SELECT content FROM facts WHERE id = ?").get(head.id) as { content: string } | undefined;
    const current = shingles(row?.content ?? head.text);
    for (const p of preds) {
      const was = shingles(p.content);
      const stale = new Set([...was].filter((s) => !current.has(s)));
      if (!stale.size) continue;
      const fresh = [...current].filter((s) => !was.has(s));
      for (const e of episodes) {
        if (e.quotesSuperseded || !(e.ts < p.valid_to)) continue;
        const es = epShingles.get(e)!;
        if (fresh.some((s) => es.has(s))) continue;
        if (longestSpan(epWords.get(e)!, stale) >= ECHO_MIN_SPAN) e.quotesSuperseded = { old: p.id, current: head.id };
      }
    }
  }
}
