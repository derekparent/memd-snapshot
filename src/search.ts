import { config, tokenBudget } from "./config.js";
import { DB, embeddingToBlob, hasVec, nowIso } from "./db.js";
import { embedTexts, embeddingsAvailable, rerankScores } from "./embeddings.js";
import { packUnderBudget } from "./tokens.js";
import { chainResolve } from "./facts.js";
import { markStaleEchoes } from "./echo.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** sqlite-vec's largest accepted KNN k (vec0 rejects more); the ceiling under a project or origin filter. */
export const VEC_MAX_K = 4096;
/** Episode origins (the `source` column): which tool's sessions a row came from. */
export const ORIGINS = ["claude", "codex"] as const;

/**
 * An origin value, checked against ORIGINS. The CLI passed `--origin` through
 * unchecked: an unknown value was sized as a 0-row share (k = VEC_MAX_K, slow)
 * and matched nothing, so it read as "no results". (The lexical leg also
 * spliced the value into its SQL text; it is a bound parameter now.)
 */
export function parseOrigin(raw: string | undefined): (typeof ORIGINS)[number] | undefined {
  if (raw === undefined) return undefined;
  if ((ORIGINS as readonly string[]).includes(raw)) return raw as (typeof ORIGINS)[number];
  throw new Error(`--origin must be one of ${ORIGINS.join(", ")}, got "${raw}"`);
}
/** Vector-leg failures in this process, surfaced by mem_stats / memd stats. */
export const vectorLegErrors: { count: number; last?: string } = { count: 0 };

/**
 * Embedded-row counts per project and origin, computed in ONE GROUP BY and cached per
 * process for a few minutes (the MCP server is long-lived): counting per
 * search cost ~100 ms on a 180k-row store, more than a well-sized k saves.
 * Quarantined rows are left out: the KNN excludes them, so counting them
 * would shrink k for exactly the projects that lost rows.
 */
let shareCache: { at: number; db: DB; total: number; groups: { p: string | null; o: string; n: number }[] } | undefined;
const SHARE_TTL_MS = 10 * 60_000;

/**
 * k for a filtered KNN (project and/or origin): enough that ~K*4 of the
 * matching rows are expected in it. Both filters are applied AFTER the KNN,
 * so a minority origin (codex is ~5% of rows) needs the same sizing a small
 * project does, and a project+origin filter is sized by their intersection.
 * A bare string is a project, as before.
 */
export function filteredKnnK(db: DB, filter: string | { project?: string; origin?: string }, K: number): number {
  const { project, origin } = typeof filter === "string" ? { project: filter, origin: undefined } : filter;
  if (!project && !origin) return K * 4;
  if (!shareCache || shareCache.db !== db || Date.now() - shareCache.at > SHARE_TTL_MS) {
    const groups = db
      .prepare("SELECT LOWER(project) AS p, source AS o, COUNT(*) AS n FROM episodes WHERE embedded = 1 AND quarantined = 0 GROUP BY LOWER(project), source")
      .all() as { p: string | null; o: string; n: number }[];
    shareCache = { at: Date.now(), db, total: groups.reduce((a, r) => a + r.n, 0), groups };
  }
  const p = project?.toLowerCase();
  const mine = shareCache.groups.reduce((a, g) => ((!p || g.p === p) && (!origin || g.o === origin) ? a + g.n : a), 0);
  if (!shareCache.total || !mine) return VEC_MAX_K;
  return Math.min(VEC_MAX_K, Math.max(K * 4, Math.ceil((K * 4 * shareCache.total) / mine)));
}

/** Projects (lower-cased) with any unquarantined episode, cached per process like the share counts. */
let rowProjects: { at: number; db: DB; names: Set<string> } | undefined;
export function projectHasRows(db: DB, project: string): boolean {
  if (!rowProjects || rowProjects.db !== db || Date.now() - rowProjects.at > SHARE_TTL_MS) {
    const rows = db.prepare("SELECT DISTINCT LOWER(project) AS p FROM episodes WHERE quarantined = 0 AND project IS NOT NULL").all() as { p: string }[];
    rowProjects = { at: Date.now(), db, names: new Set(rows.map((r) => r.p)) };
  }
  return rowProjects.names.has(project.toLowerCase());
}

/**
 * The words a query might use to name a project: its full name, the name with
 * punctuation dropped, and its first segment when that is 5+ characters
 * ("fieldapp" for FieldApp-ios; "home" is too common to stand for home-lab).
 * Tags that are not real project names name nothing: under 3 characters
 * ("qa", "i" would match ordinary words in a query), worktree slugs ("--"), and
 * long slugs of 4+ segments (harness and scratch dirs).
 */
function projectWords(project: string): string[] {
  const p = project.toLowerCase();
  const segs = p.split(/[^a-z0-9]+/).filter(Boolean);
  if (p.length < 3 || p.includes("--") || segs.length > 3) return [];
  return [p, p.replace(/[^a-z0-9]/g, ""), ...(segs[0] && segs[0].length >= 5 ? [segs[0]] : [])];
}

/** Known projects (lower-cased) that the query names, by projectWords(). */
export function projectsNamed(db: DB, query: string): string[] {
  projectHasRows(db, ""); // refreshes the cached name set
  const words = new Set(
    (query.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []).flatMap((w) => [w, w.replace(/[^a-z0-9]/g, "")])
  );
  return [...(rowProjects?.names ?? [])].filter((p) => p && projectWords(p).some((w) => words.has(w)));
}

/**
 * The caller project a search actually ranks toward, or undefined. Undefined
 * (rank exactly as an unscoped search) when:
 *  - an explicit `project` filter was passed (it wins);
 *  - the caller project has no rows (a fresh repo, a scratch dir);
 *  - the query names some OTHER known project: a session in one repo
 *    asking "fieldapp build 12" wants FieldApp's history, not its
 *    own. A false match (a project named like a common word) only falls back
 *    to unscoped ranking.
 * The server's response note uses this too, so it never claims a scope that
 * was not applied.
 */
export function effectiveScope(db: DB, opts: { project?: string; callerProject?: string }, query = ""): string | undefined {
  const wanted = !opts.project ? opts.callerProject?.trim() : undefined;
  if (!wanted || !projectHasRows(db, wanted)) return undefined;
  const mine = wanted.toLowerCase();
  return projectsNamed(db, query).some((p) => p !== mine) ? undefined : wanted;
}

let buildStamp: string | null = null;
/** Short git SHA of the running build — makes server/dist version skew self-evident. */
export function buildInfo(): string {
  if (buildStamp !== null) return buildStamp;
  try {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const head = fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8").trim();
    const sha = head.startsWith("ref: ")
      ? fs.readFileSync(path.join(repo, ".git", head.slice(5)), "utf8").trim()
      : head;
    buildStamp = sha.slice(0, 7);
  } catch {
    buildStamp = "unknown";
  }
  return buildStamp;
}

/**
 * Hybrid retrieval pipeline (the part the research says is the actual
 * bottleneck):
 *   1. lexical candidates  — FTS5/BM25 over episodes + active facts
 *   2. vector candidates   — sqlite-vec KNN over local bge-small embeddings
 *   3. reciprocal-rank fusion of the two lists
 *   4. multi-factor score  — s·d·fused·(1 + w_rec·2^(-age/halflife) + w_imp·(importance/10)),
 *                            d = 0.75 for a chain head reached via an old wording,
 *                            s = 1 + MEMD_SCOPE_BOOST for the caller's own episodes
 *   5. optional cross-encoder rerank of the top candidates
 *   6. greedy packing under the token budget with provenance headers
 */

export interface SearchHit {
  source: "episode" | "fact" | "doc";
  path?: string;
  chainDepth?: number;
  /** HISTORY hit quoting wording a later fact replaced: the superseded fact and the current head (echo.ts). */
  quotesSuperseded?: { old: number; current: number };
  /** Active facts related to this one by `contradicts` (read-path conflict marker). */
  contestedBy?: number;
  id: number;
  project: string;
  ts: string;
  role?: string;
  kind?: string;
  importance: number;
  sessionId?: string;
  origin?: string;
  score: number;
  text: string;
}

export interface SearchOptions {
  project?: string;
  sources?: ("episodes" | "facts" | "docs")[];
  limit?: number;
  maxTokens?: number;
  rerank?: boolean;
  includeSuperseded?: boolean;
  origin?: "claude" | "codex";
  /** kind:'feedback' facts: true = include, false = exclude, unset = wantsFeedback(). */
  includeFeedback?: boolean;
  /**
   * The project the CALLER is working in (the MCP server's cwd), as opposed to
   * `project`, which is a hard filter. It scopes candidate generation and
   * ranks that project's hits up, but never removes another project's hit.
   * Ignored when `project` is set.
   */
  callerProject?: string;
}

/**
 * Kind-based importance prior for episodes: curated summaries carry the
 * most signal, raw tool plumbing the least; sub-100-char fragments get a
 * further demotion so keyword-dense stubs can't dominate BM25.
 */
export function episodePrior(kind: string | undefined, textLen: number): number {
  const base = kind === "summary" ? 6 : kind === "tool_use" ? 3 : kind === "tool_result" ? 2 : 5;
  return textLen < 100 ? Math.max(1, base - 1) : base;
}

const STOPWORDS = new Set(
  "a an and are as at be but by does did do for from had has have how i if in is it its me my no not of on or our so that the their them then there these they this to was we what when where which who will with you your still often".split(" ")
);

/** Content-bearing query words (stopwords and short tokens dropped). */
export function contentWords(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[a-z0-9_./-]+/g) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w)))];
}

/**
 * The two stores can disagree on casing for the same repo — the facts ledger
 * tags `fieldapp-ios` while episodes tag `FieldApp-ios` — so no single caller
 * value could address both. Matching is case-insensitive everywhere a project
 * filter is applied; a caller passing either casing now reaches both stores.
 */
export function sameProject(rowProject: string | null | undefined, filter?: string): boolean {
  if (!filter) return true;
  if (!rowProject) return false;
  return rowProject.toLowerCase() === filter.toLowerCase();
}

/** Distinct project values across all three stores, case-folded and merged. */
export function knownProjects(db: DB): string[] {
  const rows = db
    .prepare(
      `SELECT project FROM episodes WHERE project IS NOT NULL
       UNION SELECT project FROM facts WHERE project IS NOT NULL AND kind != 'feedback'
       UNION SELECT project FROM docs WHERE project IS NOT NULL`
    )
    .all() as { project: string }[];
  // Feedback facts are excluded above: one tagged with a typo'd filter (the
  // miss it records) would otherwise mint that typo as a "known project" and
  // silence the very diagnostic the miss was about.
  const seen = new Map<string, string>();
  // The live store holds at least one empty-string project; it is not a name a
  // caller can address, and an empty entry makes every near-match test true.
  for (const r of rows) {
    const name = (r.project ?? "").trim();
    if (!name) continue;
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * A project filter that matches nothing returns an empty result set that reads
 * exactly like "there is nothing on this topic" — the trap that cost a real
 * recall in the field. Say so instead, and name what IS addressable.
 */
export function projectDiagnostic(db: DB, project?: string): string | undefined {
  if (!project) return undefined;
  const known = knownProjects(db);
  if (known.some((k) => k.toLowerCase() === project.toLowerCase())) return undefined;
  const near = known.filter((k) => {
    const a = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    const b = project.toLowerCase().replace(/[^a-z0-9]/g, "");
    return a.includes(b) || b.includes(a);
  });
  const suggestion = near.length ? ` Did you mean: ${near.slice(0, 5).join(", ")}?` : "";
  return `NOTE: no project named "${project}" exists in the store, so this filter matched nothing — an empty result here does NOT mean the store has nothing on the topic.${suggestion} Known projects: ${known.slice(0, 40).join(", ")}${known.length > 40 ? ", …" : ""}. Re-run without the project filter to search everything.`;
}

/**
 * Census questions get a confident PARTIAL answer with no partiality
 * signal. Asked "how many separate times has a green test suite hidden a broken
 * product", search returned 3 real instances; an independent SQL sweep found 9.
 * Recall was 33% and nothing in the response said so — the misses described the
 * same failure in different vocabulary, which is why raising the limit does not
 * fix it. The corpus cannot separate "this happened" from "someone discussed
 * this happening", so the honest move is not to count harder but to say plainly
 * that it is not counting.
 *
 * Phrases are multi-word and intent-bearing on purpose. A single word like
 * "all" or "every" appears constantly in ordinary recall ("what did we decide
 * about all the auth flows") and would fire the banner on questions it does not
 * apply to — and a banner that cries wolf gets skimmed past exactly when it
 * matters.
 */
const AGGREGATE_PATTERNS: RegExp[] = [
  /\bhow many\b/i,
  /\bhow often\b/i,
  /\bhow much\b/i,
  /\bhow frequently\b/i,
  /\b(the )?(total|number|count) of\b/i,
  /\b(every|each|all the) (single )?time(s)?\b/i,
  /\blist (all|every|each)\b/i,
  /\b(all|every) (instance|occurrence|case)s?\b/i,
  /\benumerate\b/i,
  /\btally\b/i,
  // Question-form anchors (review round 2). "have we ever" is the likeliest
  // census phrasing in practice, and the question form is why it is safe: bare
  // "ever" fires on "the best decision ever made", the interrogative does not.
  /\bhave (we|you|i) ever\b/i,
  // `full list` and `everything we know` are anchored one word tighter than
  // proposed: bare forms fire on the STATEMENTS "the full list is in
  // CONTEXT.md" and "everything we know is written down", which are prose, not
  // requests for a census.
  /\bfull list of\b/i,
  /\beverything we know about\b/i,
  // Not "all-hands": the hyphen is a word boundary, so an unguarded \ball\b
  // would match "what are all-hands meetings for".
  /\bwhat are all\b(?!-)/i,
];

export const SAMPLING_BANNER =
  "NOTE: this is a SAMPLE ranked by similarity, not a census. Your question looks aggregate-shaped (\"how many\", \"every time\", …) — search returns the best-matching excerpts under a token budget, and it cannot distinguish \"this happened\" from \"someone discussed this happening\". Measured recall on one such question was 3 of 9 real instances. For an exhaustive answer use mem_timeline over a window, or query the store directly.";

/** The banner text when a query asks for a count/census, else undefined. */
export function samplingNote(query: string): string | undefined {
  return AGGREGATE_PATTERNS.some((re) => re.test(query)) ? SAMPLING_BANNER : undefined;
}

/**
 * Every response note for one search, in display order. Assembling them here
 * rather than at each call site means one mechanism instead of one per finding,
 * and it gives the composition a seam that can actually be tested — a note
 * function that is never called still passes all of its own unit tests.
 */
export function responseNotes(db: DB, query: string, opts: { project?: string } = {}): string[] {
  return [projectDiagnostic(db, opts.project), samplingNote(query)].filter((n): n is string => Boolean(n));
}

/**
 * Queries that are ABOUT memd or retrieval friction — the only ordinary
 * queries allowed to see kind:'feedback' facts. Deliberately narrow: a
 * feedback fact quotes the missed query verbatim, so it lexically matches
 * that query's whole topic ("lab-printer toner"), and letting it surface there
 * is exactly the recall pollution the ruling warned about. Bare "recall" and
 * "feedback" are excluded: "do you recall…" and "the user's feedback on the
 * design" are ordinary questions, and so is bare "retrieval" (a project's own
 * core domain word). No regex catches "has anyone hit a filter returning nothing" — that
 * is what the include_feedback flag is for.
 */
const FEEDBACK_QUERY =
  /\b(memd|mem_(search|save|timeline|supersede|forget|checkpoint)|retrieval (misses|miss|failures?)|search (misses|miss|missed|failures?)|recall (misses|miss|failures?)|tooling friction)\b/i;

export function wantsFeedback(query: string, opts: { project?: string; includeFeedback?: boolean } = {}): boolean {
  if (opts.includeFeedback !== undefined) return opts.includeFeedback;
  return FEEDBACK_QUERY.test(query) || opts.project?.toLowerCase() === "memd";
}

export function ftsMatchExpr(query: string): string {
  const words = contentWords(query);
  if (words.length === 0) return "";
  return words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

function recencyScore(ts: string): number {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (Date.now() - t) / 86_400_000);
  return Math.pow(2, -ageDays / config.decayHalfLifeDays);
}

interface Candidate {
  key: string;
  hit: SearchHit;
  lexRank?: number;
  vecRank?: number;
}

function rrf(rank: number | undefined): number {
  return rank === undefined ? 0 : 1 / (config.rrfK + rank);
}

export async function search(db: DB, query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const sources = opts.sources ?? ["episodes", "facts", "docs"];
  const K = 50;
  // Every caller is typed, but an unknown origin silently matches nothing: refuse it.
  if (opts.origin !== undefined && !(ORIGINS as readonly string[]).includes(opts.origin)) {
    throw new Error(`unknown origin "${opts.origin}" (expected one of ${ORIGINS.join(", ")})`);
  }
  const candidates = new Map<string, Candidate>();

  const addCandidate = (key: string, hit: SearchHit, field: "lexRank" | "vecRank", rank: number) => {
    const existing = candidates.get(key);
    if (existing) existing[field] = Math.min(existing[field] ?? Infinity, rank);
    else candidates.set(key, { key, hit, [field]: rank });
  };

  const match = ftsMatchExpr(query);
  const allowFeedback = wantsFeedback(query, opts);

  // Caller scope. Without an explicit filter, the episode
  // lexical leg runs twice: over the whole store and over the caller's project,
  // and a row keeps its better rank. A small project's transcripts are
  // otherwise crowded out of the global top K before fusion sees them; the
  // global leg is unchanged, so a strong row from another project still
  // arrives. The caller's episodes then get a score boost (below). Facts and
  // docs are never scoped or boosted: the curated ledger is small, and its
  // cross-project answers are the point.
  const scope = effectiveScope(db, opts, query);
  const legProjects: (string | undefined)[] = scope ? [opts.project, scope] : [opts.project];

  // 1. Lexical
  for (const proj of legProjects) {
    if (match && sources.includes("episodes")) {
      const rows = db
        .prepare(
          `SELECT e.id, e.project, e.ts, e.role, e.kind, e.session_id, e.content, e.source,
                  bm25(episodes_fts) AS b
           FROM episodes_fts JOIN episodes e ON e.id = episodes_fts.rowid
           WHERE episodes_fts MATCH ? AND e.quarantined = 0 ${proj ? "AND LOWER(e.project) = LOWER(?)" : ""} ${opts.origin ? "AND e.source = ?" : ""}
           ORDER BY b LIMIT ?`
        )
        .all(match, ...(proj ? [proj] : []), ...(opts.origin ? [opts.origin] : []), K) as any[];
      rows.forEach((r, i) =>
        addCandidate(`e${r.id}`, {
          source: "episode", id: r.id, project: r.project, ts: r.ts, role: r.role, kind: r.kind,
          sessionId: r.session_id, origin: r.source, importance: episodePrior(r.kind, r.content.length), score: 0, text: r.content,
        }, "lexRank", i)
      );
    }
  }
  // Facts leg matches the WHOLE ledger (superseded wordings included) and
  // resolves every hit to its supersede-chain HEAD: a query
  // phrased in an old ruling's words must still surface the CURRENT ruling.
  // Retracted chains (closed head, no successor) stay hidden.
  const resolveFactHit = (r: any, i: number, field: "lexRank" | "vecRank") => {
    let row = r;
    let depth = 0;
    if (r.valid_to !== null && !opts.includeSuperseded) {
      const res = chainResolve(db, r.id);
      const head = db
        .prepare("SELECT id, project, created_at AS ts, kind, importance, content, valid_to FROM facts WHERE id = ?")
        .get(res.head) as any;
      if (!head || head.valid_to !== null) return; // retracted chain
      row = head;
      depth = res.depth;
    }
    // Judged on the resolved head (what would be shown). supersedeFact refuses
    // chains that cross the feedback boundary, so head and wording agree.
    if (row.kind === "feedback" && !allowFeedback) return;
    addCandidate(`f${row.id}`, {
      source: "fact", id: row.id, project: row.project ?? "global", ts: row.ts, kind: row.kind,
      importance: row.importance, score: 0, text: row.content, chainDepth: depth || undefined,
    }, field, i);
  };

  if (match && sources.includes("facts")) {
    const rows = db
      .prepare(
        `SELECT f.id, f.project, f.created_at AS ts, f.kind, f.importance, f.content, f.valid_to,
                bm25(facts_fts) AS b
         FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
         WHERE facts_fts MATCH ?
               ${opts.project ? "AND (LOWER(f.project) = LOWER(?) OR f.project IS NULL)" : ""}
         ORDER BY b LIMIT ?`
      )
      .all(...(opts.project ? [match, opts.project, K] : [match, K])) as any[];
    rows.forEach((r, i) => resolveFactHit(r, i, "lexRank"));
  }

  if (match && sources.includes("docs")) {
    const rows = db
      .prepare(
        `SELECT d.id, d.path, d.mtime, d.project, d.content, bm25(docs_fts) AS b
         FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
         WHERE docs_fts MATCH ? ${opts.project ? "AND LOWER(d.project) = LOWER(?)" : ""}
         ORDER BY b LIMIT ?`
      )
      .all(...(opts.project ? [match, opts.project, K] : [match, K])) as any[];
    rows.forEach((r, i) =>
      addCandidate(`d${r.id}`, {
        source: "doc", id: r.id, path: r.path, project: r.project ?? "docs",
        ts: new Date(r.mtime).toISOString(), kind: "file", importance: 6, score: 0, text: r.content,
      }, "lexRank", i)
    );
  }

  // 2. Vector — only when the store actually holds vectors; avoids dragging
  // in the embedding model (a first-run download) for an FTS-only store.
  // Either table having vectors is enough: gating on EPISODES alone meant a
  // store with embedded facts but no embedded episodes never searched facts by
  // vector.
  const anyEmbedded =
    hasVec() &&
    (!!db.prepare("SELECT 1 FROM episodes WHERE embedded = 1 LIMIT 1").get() ||
      !!db.prepare("SELECT 1 FROM facts WHERE embedded = 1 LIMIT 1").get());
  // vec0 KNN is global: the project filter runs on its results, so with a
  // filter the global top K*4 can hold few or none of this project's rows
  // (measured on a synthetic 180k-row, 30-project store: 6.7 of 50 wanted).
  // k costs time (about 54 ms at 200, 115 ms from 1,000 up on that store), so
  // size it by the project's share of embedded rows: a big project stays near
  // K*4, a small one gets up to VEC_MAX_K.
  //
  // Caller scope gets no KNN of its own: it cost ~200 ms a search (k >= 1,273
  // even for the biggest project; x2.2 overall), over the 1.5x latency budget,
  // for a modestly higher caller share of HISTORY.
  const knnK = filteredKnnK(db, { project: opts.project, origin: opts.origin }, K);
  if (anyEmbedded && (await embeddingsAvailable().catch(() => false))) {
    try {
      const [qvec] = await embedTexts([query], true);
      const blob = embeddingToBlob(qvec);
      if (sources.includes("episodes")) {
        // Two queries: the KNN reads only ids and filter columns (up to
        // VEC_MAX_K rows under a project/origin filter), and content is fetched only
        // for the <= K survivors, so a filtered search never drags thousands
        // of transcript chunks through the JS filter.
        const near = db
          .prepare(
            `SELECT v.rowid AS id, e.project, e.source
             FROM vec_episodes v JOIN episodes e ON e.id = v.rowid
             WHERE v.embedding MATCH ? AND k = ? AND e.quarantined = 0
             ORDER BY v.distance`
          )
          .all(blob, knnK) as { id: number; project: string; source: string }[];
        const keep = near.filter((r) => sameProject(r.project, opts.project) && (!opts.origin || r.source === opts.origin)).slice(0, K);
        const byId = new Map(
          (keep.length
            ? (db
                .prepare(`SELECT id, project, ts, role, kind, session_id, content, source FROM episodes WHERE id IN (SELECT value FROM json_each(?))`)
                .all(JSON.stringify(keep.map((r) => r.id))) as any[])
            : []
          ).map((r) => [r.id, r])
        );
        keep.forEach((k, i) => {
          const r = byId.get(k.id);
          if (!r) return;
          addCandidate(`e${r.id}`, {
            source: "episode", id: r.id, project: r.project, ts: r.ts, role: r.role, kind: r.kind,
            sessionId: r.session_id, origin: r.source, importance: episodePrior(r.kind, r.content.length), score: 0, text: r.content,
          }, "vecRank", i);
        });
      }
      if (sources.includes("facts")) {
        const rows = db
          .prepare(
            `SELECT v.rowid AS id, v.distance, f.project, f.created_at AS ts, f.kind, f.importance, f.content, f.valid_to
             FROM vec_facts v JOIN facts f ON f.id = v.rowid
             WHERE v.embedding MATCH ? AND k = ?
             ORDER BY v.distance`
          )
          .all(blob, knnK) as any[];
        rows
          .filter((r) => !r.project || sameProject(r.project, opts.project))
          .slice(0, K)
          .forEach((r, i) => resolveFactHit(r, i, "vecRank"));
      }
    } catch (err) {
      // The lexical leg already ran, so the search still answers, but a
      // failing vector leg must not be silent: an over-limit k or a broken
      // extension would otherwise read as "no semantic matches" forever.
      vectorLegErrors.count++;
      vectorLegErrors.last = (err as Error).message;
      console.error(`memd search: vector leg failed: ${vectorLegErrors.last}`);
    }
  }

  // 3+4. Fuse and score. Relevance GATES the other signals (multiplicative):
  // importance and recency modulate within a relevance band instead of letting
  // an off-topic importance-8 fact outrank the on-topic answer.
  // fused==0 can't happen for a candidate (it arrived via a leg).
  const fusedMax = 2 / (config.rrfK + 0); // theoretical max of rrf(lex)+rrf(vec)
  let ranked = [...candidates.values()].map((c) => {
    const fused = (rrf(c.lexRank) + rrf(c.vecRank)) / fusedMax;
    // Chain-resolved heads matched via a superseded wording (proxy): keep them
    // present but let an equally-strong DIRECT match outrank them.
    const proxyDiscount = c.hit.chainDepth ? 0.75 : 1;
    // Caller scope: the caller's own rows rank up; nothing is removed.
    const scoped = scope && c.hit.source === "episode" && sameProject(c.hit.project, scope) ? 1 + config.scopeBoost : 1;
    const score =
      scoped * proxyDiscount * fused * (1 + config.weightRecency * recencyScore(c.hit.ts) + config.weightImportance * (c.hit.importance / 10));
    return { ...c.hit, score };
  });
  ranked.sort((a, b) => b.score - a.score);

  // 5. Optional cross-encoder rerank of the head
  if (opts.rerank && ranked.length > 1) {
    try {
      const head = ranked.slice(0, 30);
      const scores = await rerankScores(query, head.map((h) => h.text));
      const min = Math.min(...scores);
      const span = Math.max(...scores) - min || 1;
      head.forEach((h, i) => (h.score = 0.7 * ((scores[i] - min) / span) + 0.3 * h.score));
      head.sort((a, b) => b.score - a.score);
      ranked = [...head, ...ranked.slice(30)];
    } catch {
      // reranker unavailable — fused order stands
    }
  }

  // 5.4 Term-overlap gate for curated hits (round 2): the
  // OR-matcher lets a fact qualify on one incidental word; with few facts in
  // the ledger, bm25 rank within the leg is meaningless. Require real topical
  // overlap before a fact/doc may claim a CURRENT slot.
  const qWords = contentWords(query);
  const needed = Math.min(2, Math.max(1, qWords.length));
  ranked = ranked.filter((h) => {
    if (h.source === "episode") return true;
    // Chain-resolved heads are exempt: their relevance was established by the
    // superseded wording that matched — the head SHOULDN'T share the query's
    // words when the ruling changed.
    if (h.chainDepth) return true;
    const text = h.text.toLowerCase();
    const overlap = qWords.filter((w) => text.includes(w)).length;
    if (overlap < needed) return false;
    // 5.4b Coverage weighting. Passing the gate is not
    // the same as answering the query. With few candidates the RRF ranks tie,
    // `fused` collapses, and score reduces to importance alone — so a 2-of-5
    // match at importance 10 outranks a 5-of-5 match at importance 2. Grade the
    // signal the gate already computes: full coverage keeps its score, thin
    // coverage is damped. Bounded at 0.6 so this re-orders within a relevance
    // band without ever demoting a curated hit below unrelated history.
    h.score *= 0.6 + 0.4 * (overlap / qWords.length);
    return true;
  });
  ranked.sort((a, b) => b.score - a.score);

  // 5.5 Content dedupe: the same bytes read by N sessions — or
  // returned N times by rerank — collapse to the single highest-scored copy.
  const seenContent = new Set<string>();
  ranked = ranked.filter((h) => {
    const key = h.text.toLowerCase().replace(/\s+/g, " ").slice(0, 300);
    if (seenContent.has(key)) return false;
    seenContent.add(key);
    return true;
  });

  // 6. Budget packing — curated state (facts + docs) gets a protected share of
  // the budget so transcript mass can never crowd it out entirely.
  const limit = Math.min(opts.limit ?? config.maxItems, config.maxItems);
  const budget = tokenBudget(opts.maxTokens);
  const current = ranked.filter((h) => h.source !== "episode");
  const history = ranked.filter((h) => h.source === "episode");
  const packedCurrent = packUnderBudget(current.slice(0, limit), Math.floor(budget * 0.4), current.length ? 1 : 0, Math.ceil(limit / 2));
  const usedTokens = packedCurrent.reduce((n, h) => n + Math.ceil(h.text.length / 4), 0);
  const packedHistory = packUnderBudget(history.slice(0, limit * 2), budget - usedTokens, history.length ? Math.min(config.minItems, history.length) : 0, limit - packedCurrent.length);
  const packed = [...packedCurrent, ...packedHistory];

  // 6.5 Read-path conflict marker. The write path warns on
  // similar facts and records `contradicts` relations, but a reader who never
  // saw the write had no way to know a returned fact is disputed. Count only
  // ACTIVE contesters: a retracted or superseded objection is not a live dispute.
  annotateContested(db, packed);
  // 6.6 Stale-echo marker: a HISTORY hit quoting wording that a
  // fact in this same response superseded says so. ADD-only.
  markStaleEchoes(db, packed);

  // Fact access bookkeeping feeds future importance/decay decisions.
  const touch = db.prepare("UPDATE facts SET access_count = access_count + 1, last_accessed = ? WHERE id = ?");
  const now = nowIso();
  for (const h of packed) if (h.source === "fact") touch.run(now, h.id);

  return packed;
}

/**
 * Fill in `contestedBy` for every fact hit: how many still-active facts are
 * linked to it by a `contradicts` relation, in either direction. Mutates in
 * place; a hit with no live dispute is left undefined rather than set to 0, so
 * the renderer stays a plain truthiness check.
 */
export function annotateContested(db: DB, hits: SearchHit[]): void {
  const factIds = hits.filter((h) => h.source === "fact").map((h) => h.id);
  if (!factIds.length) return;
  const stmt = db.prepare(
    // DISTINCT: a pair related in BOTH directions is two rows but one disputing
    // fact, and an inflated count in a trust-calibration marker is a false claim.
    `SELECT COUNT(DISTINCT f.id) AS n FROM relations r
      JOIN facts f
        ON f.id = CASE WHEN r.from_id = @id THEN r.to_id ELSE r.from_id END
     WHERE r.relation = 'contradicts'
       AND r.from_kind = 'fact' AND r.to_kind = 'fact'
       AND (r.from_id = @id OR r.to_id = @id)
       AND f.id != @id
       AND f.valid_to IS NULL`
  );
  for (const h of hits) {
    if (h.source !== "fact") continue;
    const row = stmt.get({ id: h.id }) as { n: number } | undefined;
    if (row && row.n > 0) h.contestedBy = row.n;
  }
}

export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "No matches in memory.";
  const current = hits.filter((h) => h.source !== "episode");
  const history = hits.filter((h) => h.source === "episode");
  const parts: string[] = [];
  if (current.length) parts.push("## CURRENT — curated state (facts ledger + live files)\n\n" + renderHits(current));
  if (history.length)
    parts.push(
      "## HISTORY — session transcripts as indexed (secrets redacted, long tool output truncated; may predate later decisions — verify anything ruling-shaped against CURRENT or live state)\n\n" +
        renderHits(history)
    );
  parts.push(`[memd build ${buildInfo()}]`);
  return parts.join("\n\n");
}

function renderHits(hits: SearchHit[]): string {
  return hits
    .map((h) => {
      const date = h.ts ? h.ts.slice(0, 10) : "undated";
      const head =
        h.source === "fact"
          ? `[fact #${h.id} | ${h.project} | ${date} | ${h.kind} | importance ${h.importance}${h.chainDepth ? ` | CHAIN HEAD (supersedes ${h.chainDepth} earlier version${h.chainDepth > 1 ? "s" : ""} — your query matched an old wording)` : ""}${h.contestedBy ? ` | CONTESTED (${h.contestedBy} active fact${h.contestedBy > 1 ? "s" : ""} contradict${h.contestedBy > 1 ? "" : "s"} this — check before relying on it)` : ""}]`
          : h.source === "doc"
            ? `[file ${h.path} | modified ${date} | ${h.project}]`
            : `[${h.origin === "codex" ? "codex \u00b7 " : ""}${h.project} | ${date} | ${h.role}${h.kind && h.kind !== "text" ? "/" + h.kind : ""} | session ${h.sessionId?.replace(/^codex:/, "").slice(0, 8) ?? "?"}${h.quotesSuperseded ? ` | QUOTES SUPERSEDED fact #${h.quotesSuperseded.old} — current position is fact #${h.quotesSuperseded.current} above` : ""}]`;
      return `${head}\n${h.text}`;
    })
    .join("\n\n---\n\n");
}

export interface TimelineOptions {
  project?: string;
  sessionId?: string;
  before?: string;
  after?: string;
  limit?: number;
  maxTokens?: number;
}

export function timeline(db: DB, opts: TimelineOptions): SearchHit[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.project) { clauses.push("LOWER(project) = LOWER(?)"); params.push(opts.project); }
  if (opts.sessionId) { clauses.push("session_id LIKE ?"); params.push(opts.sessionId + "%"); }
  if (opts.before) { clauses.push("ts <= ?"); params.push(opts.before); }
  if (opts.after) { clauses.push("ts >= ?"); params.push(opts.after); }
  const limit = Math.min(opts.limit ?? config.maxItems, 200);
  clauses.push("quarantined = 0");
  const whereQ = "WHERE " + clauses.join(" AND ");
  const rows = db
    .prepare(
      `SELECT id, project, ts, role, kind, session_id, content, source FROM episodes ${whereQ}
       ORDER BY ts DESC LIMIT ?`
    )
    .all(...params, limit) as any[];
  rows.reverse();
  const hits: SearchHit[] = rows.map((r) => ({
    source: "episode", id: r.id, project: r.project, ts: r.ts, role: r.role, kind: r.kind,
    sessionId: r.session_id, origin: r.source, importance: episodePrior(r.kind, r.content.length), score: 0, text: r.content,
  }));
  return packUnderBudget(hits, tokenBudget(opts.maxTokens), config.minItems, limit);
}
