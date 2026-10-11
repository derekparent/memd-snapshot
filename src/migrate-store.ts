import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { DB } from "./db.js";
import { redact } from "./redact.js";

/**
 * Retroactive store migrations (E1/E2).
 *
 * These are the only tools in memd that REWRITE existing rows, so the whole
 * module is built around three rules learned the hard way:
 *
 *  1. DRY RUN IS THE DEFAULT. Every entry point reports what it WOULD change
 *     and touches nothing unless `apply` is passed explicitly.
 *  2. A BACKUP IS TAKEN BEFORE ANY WRITE, via sqlite3 `.backup()` — never a
 *     `cp`. The store runs in WAL mode, and copying the file without a
 *     checkpoint silently loses recent writes (a plain copy has come out
 *     hundreds of rows short exactly this way in practice).
 *  3. WRITES ARE TRANSACTIONAL, so an interrupted run leaves no half-migrated
 *     store.
 *
 * Neither migration is run by the nightly tick. Execution is a human decision.
 */

export interface MigrationOptions {
  /** Perform the writes. Omitted or false = dry run. */
  apply?: boolean;
  /** Cap rows examined (useful for a scoped trial). */
  limit?: number;
  /** Destination for the pre-write backup; defaults next to the store. */
  backupDir?: string;
}

/**
 * What this sweep does NOT close. Printed on every run: an operator reading
 * "116 changed" must not conclude the corpus is clean, and a comment in the
 * source is not visible at the moment the decision is made.
 */
export const SWEEP_KNOWN_GAPS = [
  "multi-line YAML block scalars (`password: >` with the value on following lines) are NOT redacted — the marker is skipped deliberately, so the value survives",
  "every key-value catch is labelled SECRET_VALUE, never a specific provider label — no downstream logic may key off label specificity",
  "backups and pre-write snapshots taken BEFORE a sweep still hold the unredacted text — delete them once the sweep is verified",
];

export interface SweepStats {
  dryRun: boolean;
  episodesScanned: number;
  episodesChanged: number;
  /** Changed rows whose embedding was invalidated and must be recomputed. */
  embeddingsInvalidated: number;
  factsScanned: number;
  factsChanged: number;
  docsScanned: number;
  docsChanged: number;
  backupPath?: string;
  /** Machine-readable record of exactly what was rewritten. */
  sidecarPath?: string;
}

export interface RetagStats {
  dryRun: boolean;
  sessionsScanned: number;
  sessionsRetagged: number;
  episodesRetagged: number;
  /**
   * "old -> new" => episodes affected. Keyed by the PAIR, not by the old name:
   * one stale tag can resolve to several repos (sessions that moved), and a
   * name-keyed map silently overwrites, showing a human approving the run only
   * the last destination.
   */
  mapping: Record<string, number>;
  /** E2 only: every session's verdict and the evidence behind it (the dry-run shows these). */
  decisions?: E2Decision[];
  backupPath?: string;
  /** Machine-readable record of exactly what was rewritten. */
  sidecarPath?: string;
}

/**
 * Record the planned change set BEFORE writing it.
 *
 * The backup alone is not auditability: for a one-shot rewrite the operator
 * approves once, "restore the whole database or nothing" is the only recourse
 * it offers, and it discards everything written since. The sidecar says exactly
 * which rows changed and how, so a single bad mapping can be reasoned about —
 * and, for E2, reversed by hand — without throwing away the rest.
 */
function writeSidecar(dir: string | undefined, stamp: string, payload: unknown): string {
  const destDir = dir ?? path.join(path.dirname(config.dbPath), "backups");
  fs.mkdirSync(destDir, { recursive: true });
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(destDir, `memd-plan-${stamp}-${iso}.json`);
  fs.writeFileSync(dest, JSON.stringify(payload, null, 2));
  return dest;
}

/**
 * Snapshot the store before a destructive pass. `.backup()` checkpoints WAL;
 * `cp` does not, which is why this is the only sanctioned snapshot path.
 */
export function backupStore(dbPath = config.dbPath, dir?: string, stamp = "manual"): string {
  const destDir = dir ?? path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(destDir, { recursive: true });
  let dest = path.join(destDir, `memd-pre-${stamp}.db`);
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(destDir, `memd-pre-${stamp}-${n++}.db`);
  const src = new Database(dbPath, { readonly: true });
  try {
    // better-sqlite3's backup is async; the sync alternative is VACUUM INTO,
    // which also checkpoints and blocks until the copy is complete.
    src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  return dest;
}

/**
 * E1 — apply the current redaction rules to already-stored episodes.
 *
 * The corpus was built under token-shape-only rules, so every key-value secret
 * ingested before key-shape redaction existed is still sitting in it. Redacting a chunk also makes its
 * embedding stale (the vector describes text that no longer exists), so changed
 * rows are marked unembedded and their vector row dropped; `memd embed` then
 * recomputes them.
 *
 * KNOWN GAPS this sweep does NOT close, recorded so nobody reads a clean run as
 * proof the corpus is clean:
 *  - multi-line YAML block scalars (`password: >` with the value on following
 *    lines) — the redactor deliberately skips the marker, so the value survives.
 *  - label specificity: everything the key-value rules catch is written as
 *    SECRET_VALUE, so sweep logic must never key off a more specific label.
 */
export function sweepRedaction(db: DB, opts: MigrationOptions = {}): SweepStats {
  const stats: SweepStats = {
    dryRun: !opts.apply,
    episodesScanned: 0,
    episodesChanged: 0,
    embeddingsInvalidated: 0,
    factsScanned: 0,
    factsChanged: 0,
    docsScanned: 0,
    docsChanged: 0,
  };
  const lim = opts.limit ? "LIMIT " + Number(opts.limit) : "";
  type Row = { id: number; content: string; embedded: number };
  const scan = (sql: string, onRow: () => void, onChange: (r: Row) => void): Row[] => {
    const out: Row[] = [];
    for (const r of db.prepare(sql).all() as Row[]) {
      onRow();
      const cleaned = redact(r.content);
      if (cleaned === r.content) continue;
      onChange(r);
      if (r.embedded) stats.embeddingsInvalidated++;
      out.push({ id: r.id, content: cleaned, embedded: r.embedded });
    }
    return out;
  };
  const episodes = scan(`SELECT id, content, embedded FROM episodes ORDER BY id ${lim}`, () => stats.episodesScanned++, () => stats.episodesChanged++);
  const facts = scan(`SELECT id, content, embedded FROM facts ORDER BY id ${lim}`, () => stats.factsScanned++, () => stats.factsChanged++);
  // docs carry no embedding; re-indexing a changed file re-redacts it anyway,
  // but a file that never changes again would keep its old chunk forever.
  const docs = scan(`SELECT id, content, 0 AS embedded FROM docs ORDER BY id ${lim}`, () => stats.docsScanned++, () => stats.docsChanged++);

  if (!opts.apply || !(episodes.length + facts.length + docs.length)) return stats;

  stats.sidecarPath = writeSidecar(opts.backupDir, "redaction-sweep", {
    migration: "E1 redaction-sweep",
    episodesScanned: stats.episodesScanned,
    episodesChanged: stats.episodesChanged,
    factsChanged: stats.factsChanged,
    docsChanged: stats.docsChanged,
    embeddingsInvalidated: stats.embeddingsInvalidated,
    knownGaps: SWEEP_KNOWN_GAPS,
    // ids only — never the content, since the content is what we are redacting
    // and a sidecar full of secrets defeats the migration.
    changedEpisodeIds: episodes.map((p) => p.id),
    changedFactIds: facts.map((p) => p.id),
    changedDocIds: docs.map((p) => p.id),
  });
  stats.backupPath = backupStore(db.name, opts.backupDir, "redaction-sweep");
  // The *_au triggers keep each FTS index in step with these UPDATEs.
  const updEp = db.prepare("UPDATE episodes SET content = ?, embedded = 0 WHERE id = ?");
  const updFact = db.prepare("UPDATE facts SET content = ?, embedded = 0 WHERE id = ?");
  const updDoc = db.prepare("UPDATE docs SET content = ? WHERE id = ?");
  const dropVec = (table: "vec_episodes" | "vec_facts", id: number) => {
    try {
      db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(id);
    } catch {
      /* sqlite-vec unavailable: no vector row can exist */
    }
  };
  db.transaction(() => {
    for (const p of episodes) {
      updEp.run(p.content, p.id);
      if (p.embedded) dropVec("vec_episodes", p.id);
    }
    for (const p of facts) {
      updFact.run(p.content, p.id);
      if (p.embedded) dropVec("vec_facts", p.id);
    }
    for (const p of docs) updDoc.run(p.content, p.id);
  })();
  // On a store whose FTS went stale before the *_au triggers existed, a
  // trigger's FTS 'delete' is handed content that is NOT what was indexed, and
  // FTS5 external-content indexes corrupt silently when that happens. A full
  // rebuild after the rewrite discards whatever the triggers did and re-derives
  // every index from the content now on disk, so the sweep is safe on any store.
  rebuildFts(db);
  return stats;
}

/**
 * Re-derive every FTS index from current content. Stores whose content was
 * rewritten before the *_au UPDATE triggers existed (an earlier redaction
 * sweep) still match the OLD terms; this is the one-time repair. Safe to run
 * any time; cost is a full re-tokenise of each table.
 */
export function rebuildFts(db: DB): void {
  for (const t of ["episodes_fts", "facts_fts", "docs_fts"]) {
    db.prepare(`INSERT INTO ${t}(${t}) VALUES ('rebuild')`).run();
  }
}

/**
 * E2 — retag episodes under the repo the session actually WORKED in.
 *
 * v1 retagged a session to repoForCwd(sessions.cwd). That column is the LAST
 * cwd the indexer saw, and sessions end wherever the wrap-up happened — very
 * often a cross-repo utility checkout (shared notes and logs). An early dry-run
 * would have moved thousands of episodes from an honest vague tag to a
 * confident wrong one, and moved one session OUT of its correct project.
 *
 * v2 decides from evidence of where the work happened:
 *  1. TRANSCRIPT cwd majority, when the transcript still exists: one vote per
 *     line that carries a cwd inside a repo.
 *  2. Otherwise the session's ACTIONS: one vote per tool_use episode for each
 *     repo whose path it touches. Actions, not mentions — tool results and
 *     prose quote handoffs and listings that name every repo; a session that
 *     grepped the handoff folder for another repo's name is not that repo's
 *     session.
 * In both, the cross-repo ledger directories (config.backfillLedgerDirs) cast
 * no vote: every session writes there at wrap-up, which is the v1 bias.
 * EVERY other project path votes — under its repo name when it resolves, else
 * under its raw directory name — but only a git repo can WIN. Counting the
 * unresolvable paths matters: a Codex session that worked 40 times in a
 * since-moved checkout and read 6 skills files is not a skills session (the
 * first live dry-run would have moved four such sessions to skills).
 *
 * Decision: ≥ E2_MIN_VOTES votes (E2_MIN_VOTES_LARGE for sessions over
 * E2_LARGE_SESSION_EPISODES episodes) and a clear majority (≥ E2_MAJORITY), or
 * the session is LEFT and listed. A session whose current tag is already a real
 * repo — its launch directory named it — moves only on overwhelming TRANSCRIPT
 * evidence (≥ E2_OVERWHELMING of ≥ E2_OVERWHELMING_VOTES lines); actions
 * evidence never moves it.
 */
export const E2_MIN_VOTES = 5;
/** A big session with a handful of path-bearing actions was mostly conversation: we do not know where it worked. */
export const E2_MIN_VOTES_LARGE = 10;
export const E2_LARGE_SESSION_EPISODES = 200;
export const E2_MAJORITY = 0.6;
export const E2_OVERWHELMING = 0.9;
export const E2_OVERWHELMING_VOTES = 10;
const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** "<repo>/<dir>" pairs that cast no vote (config.backfillLedgerDirs). */
const LEDGER_DIRS = new Set(config.backfillLedgerDirs.map((d) => d.replace(/^\/+|\/+$/g, "")));
/** "-<seat>" plus an optional number, for every configured seat; none configured, nothing is stripped. */
const SEATS = [...new Set([...config.worktreeSeats, ...config.backfillSeats])];
const SEAT_SUFFIX = SEATS.length ? new RegExp(`-(${SEATS.map(reEscape).join("|")})\\d*$`) : undefined;

export interface E2Options extends MigrationOptions {
  /** Where repo checkouts live (tests); default ~/Projects. */
  projectsRoot?: string;
}

export interface SessionEvidence {
  source: "transcript" | "actions" | "none";
  votes: Record<string, number>;
  total: number;
}

export type E2Verdict = "retag" | "keep" | "multi-repo" | "no-evidence" | "thin-evidence" | "protected" | "unresolved";

export interface E2Decision {
  sessionId: string;
  from: string;
  to?: string;
  verdict: E2Verdict;
  share: number;
  episodes: number;
  evidence: SessionEvidence;
}

/**
 * Repo names referenced by path in `text`: `<projectsRoot>/<name>/…`,
 * `~/Projects/<name>/…`, or a seat worktree `<worktreeRoot>/<name>-<seat>`
 * (config.worktreeRoot; none when that is off).
 * Names are raw directory names; resolution to a git repo happens in the caller.
 */
export function repoNamesInText(text: string, projectsRoot: string, opts: { skipLedgers?: boolean } = {}): string[] {
  const skipLedgers = opts.skipLedgers ?? true;
  const found = new Set<string>();
  const roots = [reEscape(projectsRoot), "~/Projects"];
  for (const root of roots) {
    // A name ends in a letter, digit or underscore: "…/Projects/FieldApp-ios." at
    // the end of a sentence is FieldApp-ios, not a directory called "FieldApp-ios.".
    const re = new RegExp(`${root}/([A-Za-z0-9._-]*[A-Za-z0-9_])(/[A-Za-z0-9._-]+)?`, "g");
    for (const m of text.matchAll(re)) {
      if (skipLedgers && m[2] && LEDGER_DIRS.has(m[1] + m[2])) continue;
      found.add(m[1]);
    }
  }
  const wtBase = config.worktreeRoot ? reEscape(path.basename(config.worktreeRoot)) : undefined;
  if (wtBase && SEAT_SUFFIX) {
    for (const m of text.matchAll(new RegExp(`${wtBase}/([A-Za-z0-9._-]+)`, "g"))) {
      const base = m[1].replace(SEAT_SUFFIX, "");
      if (base !== m[1]) found.add(base);
    }
  }
  return [...found];
}

export async function backfillProjects(db: DB, opts: E2Options = {}): Promise<RetagStats> {
  const { repoForCwd } = await import("./indexer.js");
  const { parseLine } = await import("./chunker.js");
  const projectsRoot = opts.projectsRoot ?? config.projectsRoot;
  const stats: RetagStats = {
    dryRun: !opts.apply,
    sessionsScanned: 0,
    sessionsRetagged: 0,
    episodesRetagged: 0,
    mapping: {},
    decisions: [],
  };

  // Directory name -> canonical repo (git origin), or undefined if not a repo.
  const resolved = new Map<string, string | undefined>();
  const resolve = (name: string): string | undefined => {
    if (!resolved.has(name)) {
      const dir = path.join(projectsRoot, name);
      resolved.set(name, fs.existsSync(dir) ? repoForCwd(dir) : undefined);
    }
    return resolved.get(name);
  };
  const repos = new Set<string>();
  const vote = (votes: Record<string, number>, names: string[]) => {
    const keys = new Set(
      names.map((n) => {
        const r = resolve(n);
        if (r) repos.add(r);
        return r ?? n;
      })
    );
    for (const k of keys) votes[k] = (votes[k] ?? 0) + 1;
  };

  const sessions = db
    .prepare(
      `SELECT session_id, project, transcript_path FROM sessions ORDER BY session_id ${opts.limit ? "LIMIT " + Number(opts.limit) : ""}`
    )
    .all() as { session_id: string; project: string; transcript_path: string | null }[];
  const countEpisodes = db.prepare("SELECT COUNT(*) AS n FROM episodes WHERE session_id = ?");
  const actions = db.prepare("SELECT content FROM episodes WHERE session_id = ? AND kind = 'tool_use'");
  const planned: { sessionId: string; from: string; to: string }[] = [];

  const evidenceFor = (s: { session_id: string; transcript_path: string | null }): SessionEvidence => {
    if (s.transcript_path && !s.session_id.startsWith("codex:") && fs.existsSync(s.transcript_path)) {
      const votes: Record<string, number> = {};
      for (const line of fs.readFileSync(s.transcript_path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const cwd = parseLine(line).meta.cwd;
        // Ledger dirs are skipped for ACTIONS (wrap-up writes), not for where
        // the shell sat: a session parked inside a ledger dir was working there.
        if (cwd) vote(votes, repoNamesInText(cwd + "/", projectsRoot, { skipLedgers: false }));
      }
      const total = Object.values(votes).reduce((a, b) => a + b, 0);
      if (total >= E2_MIN_VOTES) return { source: "transcript", votes, total };
    }
    const votes: Record<string, number> = {};
    for (const row of actions.all(s.session_id) as { content: string }[]) vote(votes, repoNamesInText(row.content, projectsRoot));
    const total = Object.values(votes).reduce((a, b) => a + b, 0);
    return { source: total ? "actions" : "none", votes, total };
  };

  for (const s of sessions) {
    stats.sessionsScanned++;
    const evidence = evidenceFor(s);
    const [top, topVotes] = Object.entries(evidence.votes).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    const share = evidence.total ? topVotes / evidence.total : 0;
    const episodes = (countEpisodes.get(s.session_id) as { n: number }).n;
    let verdict: E2Verdict;
    // A vague-but-honest tag beats a specific-but-wrong one: thin evidence LEAVES.
    const needed = episodes > E2_LARGE_SESSION_EPISODES ? E2_MIN_VOTES_LARGE : E2_MIN_VOTES;
    if (evidence.total === 0) verdict = "no-evidence";
    // Already where its evidence points: nothing to do, however thin.
    else if (share >= E2_MAJORITY && top.toLowerCase() === s.project.toLowerCase()) verdict = "keep";
    else if (evidence.total < needed) verdict = "thin-evidence";
    else if (share < E2_MAJORITY) verdict = "multi-repo";
    else if (!repos.has(top)) verdict = "unresolved"; // the work was in a non-repo or a vanished checkout
    else if (resolve(s.project) === s.project) {
      // Leaving a real repo tag takes TRANSCRIPT evidence (where the shell
      // sat), and overwhelming at that. Paths an action touched are not where
      // the session lived: another tool's audit of the skills repo is still
      // that tool's own session, not a skills session.
      const overwhelming = evidence.source === "transcript" && share >= E2_OVERWHELMING && evidence.total >= E2_OVERWHELMING_VOTES;
      verdict = overwhelming ? "retag" : "protected";
    } else verdict = "retag";
    stats.decisions!.push({ sessionId: s.session_id, from: s.project, to: top || undefined, verdict, share, episodes, evidence });
    if (verdict !== "retag") continue;
    stats.sessionsRetagged++;
    stats.mapping[`${s.project} -> ${top}`] = (stats.mapping[`${s.project} -> ${top}`] ?? 0) + episodes;
    stats.episodesRetagged += episodes;
    planned.push({ sessionId: s.session_id, from: s.project, to: top });
  }

  if (!opts.apply || !planned.length) return stats;

  stats.sidecarPath = writeSidecar(opts.backupDir, "project-backfill", {
    migration: "E2 project-backfill",
    sessionsScanned: stats.sessionsScanned,
    sessionsRetagged: stats.sessionsRetagged,
    episodesRetagged: stats.episodesRetagged,
    mapping: stats.mapping,
    // Per-session detail is what makes a single bad retag reversible by hand,
    // instead of forcing a whole-database restore.
    changes: planned,
    evidence: stats.decisions!.filter((d) => d.verdict === "retag").map((d) => ({ sessionId: d.sessionId, share: d.share, ...d.evidence })),
  });
  stats.backupPath = backupStore(db.name, opts.backupDir, "project-backfill");
  const updEp = db.prepare("UPDATE episodes SET project = ? WHERE session_id = ?");
  const updSess = db.prepare("UPDATE sessions SET project = ? WHERE session_id = ?");
  db.transaction(() => {
    for (const p of planned) {
      updEp.run(p.to, p.sessionId);
      updSess.run(p.to, p.sessionId);
    }
  })();
  return stats;
}
