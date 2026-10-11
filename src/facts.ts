import { DB, nowIso } from "./db.js";
import { redact } from "./redact.js";
import { askJev, JevOptions, JevQuestion } from "./jev.js";
import { recordJevUsage } from "./jevusage.js";

/**
 * The curated layer: a temporal ledger. Facts are never destructively
 * updated — superseding closes the old row's valid_to and links it to the
 * replacement, so history remains auditable while retrieval (valid_to IS
 * NULL) can never surface a stale contradiction.
 */

/**
 * "feedback": friction with memd itself — a retrieval that missed, a stale
 * result read as current. Its stated risk is recall pollution, so search
 * hides it unless asked (see wantsFeedback).
 */
export const FACT_KINDS = ["fact", "decision", "preference", "constraint", "todo", "ruling", "feedback"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/**
 * CLI boundary check. The MCP schema already rejects unknown kinds, but the CLI
 * passed free text straight to the ledger: `--kind FEEDBACK` stored an
 * upper-case kind that crossed the feedback supersede boundary and stayed
 * visible to search, and a typo made a kind no filter would ever match.
 */
export function parseKind(k: string | undefined): FactKind | undefined {
  if (k === undefined) return undefined;
  if (!(FACT_KINDS as readonly string[]).includes(k)) throw new Error(`unknown kind "${k}" — use one of: ${FACT_KINDS.join(", ")}`);
  return k as FactKind;
}

export interface ListedFact {
  id: number;
  project: string | null;
  kind: string;
  importance: number;
  created_at: string;
  content: string;
}

/**
 * Browse the ledger (the interim for this was a hand-built HTML page). Active
 * facts only — valid_to IS NULL is exactly the set of chain heads, since
 * superseding and retracting both close the old row. Newest first. Feedback
 * facts stay hidden unless asked for by kind, as in search. The project filter
 * is exact (case-insensitive); global facts have no project and are listed
 * only when no project is given.
 */
export function listFacts(db: DB, opts: { project?: string; kind?: FactKind; limit?: number } = {}): ListedFact[] {
  const where = ["valid_to IS NULL"];
  const params: unknown[] = [];
  if (opts.project) {
    where.push("LOWER(project) = LOWER(?)");
    params.push(opts.project);
  }
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  } else where.push("kind != 'feedback'");
  params.push(opts.limit ?? 50);
  return db
    .prepare(`SELECT id, project, kind, importance, created_at, content FROM facts WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params) as ListedFact[];
}

/** Hops from `id` to its chain head plus the head id. */
export function chainResolve(db: DB, id: number): { head: number; depth: number } {
  let cur = id;
  let depth = 0;
  for (let hops = 0; hops < 100; hops++) {
    const row = db.prepare("SELECT valid_to, superseded_by FROM facts WHERE id = ?").get(cur) as any;
    if (!row) break;
    if (row.valid_to === null || !row.superseded_by) return { head: cur, depth };
    cur = row.superseded_by;
    depth++;
  }
  return { head: cur, depth };
}

export interface SaveFactInput {
  content: string;
  project?: string;
  kind?: FactKind;
  importance?: number;
  sourceSession?: string;
}

export interface SimilarFact {
  id: number;
  content: string;
}

/** Cheap FTS probe for active facts resembling `content` (dupe/conflict surfacing). */
export function findSimilarFacts(db: DB, content: string, excludeId?: number, limit = 3): SimilarFact[] {
  const words = [...new Set(content.match(/[A-Za-z0-9_./-]{4,}/g) ?? [])].slice(0, 12);
  if (words.length === 0) return [];
  const match = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
  try {
    const rows = db
      .prepare(
        `SELECT f.id, f.content FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
         WHERE facts_fts MATCH ? AND f.valid_to IS NULL ${excludeId ? "AND f.id != ?" : ""}
         ORDER BY bm25(facts_fts) LIMIT ?`
      )
      .all(...(excludeId ? [match, excludeId, limit] : [match, limit])) as SimilarFact[];
    return rows;
  } catch {
    return [];
  }
}

export interface SaveResult {
  id: number;
  existed: boolean;
  similar: SimilarFact[];
}

export function saveFact(db: DB, input: SaveFactInput): SaveResult {
  const content = redact(input.content);
  // Exact-duplicate guard: an identical active fact is returned, not re-inserted.
  // Scoped to kind AND project: the same words as a hidden feedback row, or in
  // another project, are a different fact, and returning that row made it a
  // supersede's "replacement" across kinds.
  const dupe = db
    .prepare("SELECT id FROM facts WHERE content = ? AND kind = ? AND project IS ? AND valid_to IS NULL LIMIT 1")
    .get(content, input.kind ?? "fact", input.project ?? null) as { id: number } | undefined;
  if (dupe) return { id: dupe.id, existed: true, similar: [] };

  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO facts (content, project, kind, importance, valid_from, created_at, source_session)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      content,
      input.project ?? null,
      input.kind ?? "fact",
      Math.min(10, Math.max(1, input.importance ?? 5)),
      now,
      now,
      input.sourceSession ?? null
    );
  const id = Number(res.lastInsertRowid);
  return { id, existed: false, similar: findSimilarFacts(db, content, id) };
}

/**
 * Retract a fact saved in error: closes its validity window with NO successor.
 * Distinct from supersede (which replaces). The row stays for audit.
 */
export function retractFact(db: DB, id: number, reason?: string): void {
  const row = db.prepare("SELECT valid_to FROM facts WHERE id = ?").get(id) as any;
  if (!row) throw new Error(`fact #${id} not found`);
  if (row.valid_to !== null) throw new Error(`fact #${id} is already closed`);
  db.prepare("UPDATE facts SET valid_to = ? WHERE id = ?").run(nowIso(), id);
  if (reason) {
    db.prepare("UPDATE facts SET content = content || ? WHERE id = ?").run(`\n[retracted ${nowIso()}: ${redact(reason)}]`, id);
  }
}

/** Follow superseded_by pointers to the active head of a chain. */
export function activeHead(db: DB, id: number): number {
  let cur = id;
  for (let hops = 0; hops < 100; hops++) {
    const row = db.prepare("SELECT valid_to, superseded_by FROM facts WHERE id = ?").get(cur) as any;
    if (!row) throw new Error(`fact #${cur} not found`);
    if (row.valid_to === null) return cur;
    if (!row.superseded_by) return cur; // closed with no successor (retracted)
    cur = row.superseded_by;
  }
  throw new Error(`supersession chain from #${id} exceeds 100 hops (cycle?)`);
}

export function supersedeFact(db: DB, oldId: number, input: SaveFactInput): number {
  // IMMEDIATE: take the write lock before reading the old row, so a concurrent
  // supersede of the same fact cannot also see it active and fork the chain,
  // and any failure rolls back the replacement, the close and the link together.
  return db.transaction((): number => {
    const old = db.prepare("SELECT id, content, project, kind, importance, valid_to, superseded_by FROM facts WHERE id = ?").get(oldId) as any;
    if (!old) throw new Error(`fact #${oldId} not found`);
    if (old.valid_to !== null) {
      // Refuse to fork history: a closed fact was already replaced. Point the
      // caller at the live head so contradictions can't multiply silently.
      const head = activeHead(db, oldId);
      throw new Error(
        `fact #${oldId} is already superseded (closed ${old.valid_to}). ` +
          (head !== oldId
            ? `The active head of its chain is #${head} — supersede that instead.`
            : `It was retracted; save a new fact instead.`)
      );
    }
    const kind = (input.kind ?? old.kind) as FactKind;
    // The feedback boundary. search() hides a chain whose head is feedback, so
    // superseding a ruling INTO feedback made the ruling vanish from recall —
    // not stale, not CONTESTED, just absent, which reads as "no ruling exists".
    // mem_supersede exposes `kind`, so any agent (or instruction injected into
    // one) could do it. Neither direction is needed: save a new fact instead.
    if ((old.kind === "feedback") !== (kind === "feedback")) {
      throw new Error(
        `refused: fact #${oldId} is kind '${old.kind}' and cannot be superseded by kind '${kind}' — ` +
          `a supersede may not cross the feedback boundary (it would hide or unhide a chain). Save a new fact instead.`
      );
    }
    const project = input.project ?? old.project ?? undefined;
    // Identical replacement (after redaction, same kind and project): nothing
    // to supersede. Closing the fact would point it at itself and leave the
    // chain with no active head.
    if (redact(input.content) === old.content && kind === old.kind && (project ?? null) === (old.project ?? null)) {
      // The statement is unchanged, so there is nothing to supersede, but a new
      // importance is still an instruction: apply it in place rather than
      // dropping it. (A second row with identical text is the duplicate the
      // ledger refuses, and importance is metadata about the statement.)
      if (input.importance !== undefined) {
        const imp = Math.min(10, Math.max(1, input.importance));
        if (imp !== old.importance) db.prepare("UPDATE facts SET importance = ? WHERE id = ?").run(imp, oldId);
      }
      return oldId;
    }
    const now = nowIso();
    const newId = saveFact(db, {
      content: input.content,
      project,
      kind,
      importance: input.importance ?? old.importance,
      sourceSession: input.sourceSession,
    }).id;
    db.prepare("UPDATE facts SET valid_to = ?, superseded_by = ? WHERE id = ?").run(now, newId, oldId);
    db.prepare(
      `INSERT OR IGNORE INTO relations (from_kind, from_id, relation, to_kind, to_id, created_at)
       VALUES ('fact', ?, 'supersedes', 'fact', ?, ?)`
    ).run(newId, oldId, now);
    return newId;
  }).immediate();
}

export function relate(db: DB, fromId: number, relation: string, toId: number, fromKind = "fact", toKind = "fact"): void {
  for (const [kind, id] of [[fromKind, fromId], [toKind, toId]] as const) {
    if (kind === "fact" && !db.prepare("SELECT 1 FROM facts WHERE id = ?").get(id)) throw new Error(`fact #${id} not found`);
    if (kind === "episode" && !db.prepare("SELECT 1 FROM episodes WHERE id = ?").get(id)) throw new Error(`episode #${id} not found`);
  }
  db.prepare(
    `INSERT OR IGNORE INTO relations (from_kind, from_id, relation, to_kind, to_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(fromKind, fromId, relation, toKind, toId, nowIso());
}

export function neighbors(db: DB, factId: number): { relation: string; direction: "out" | "in"; kind: string; id: number; content?: string }[] {
  const rows = db
    .prepare(
      `SELECT from_kind, from_id, relation, to_kind, to_id FROM relations
       WHERE (from_kind = 'fact' AND from_id = ?) OR (to_kind = 'fact' AND to_id = ?)`
    )
    .all(factId, factId) as any[];
  return rows.map((r) => {
    const out = r.from_kind === "fact" && r.from_id === factId;
    const kind = out ? r.to_kind : r.from_kind;
    const id = out ? r.to_id : r.from_id;
    let content: string | undefined;
    if (kind === "fact") content = (db.prepare("SELECT content FROM facts WHERE id = ?").get(id) as any)?.content;
    else {
      // Quarantine hides an episode's TEXT everywhere search and timeline do;
      // the edge itself stays visible so the provenance link is not silently lost.
      const ep = db.prepare("SELECT content, quarantined FROM episodes WHERE id = ?").get(id) as any;
      content = ep ? (ep.quarantined ? "[quarantined]" : ep.content) : undefined;
    }
    return { relation: r.relation, direction: out ? "out" : "in", kind, id, content: content?.slice(0, 200) } as const;
  }) as any;
}

/** Measured on a labeled evaluation set: conflicts ≤0.18 vs compatible ≥0.81; same_subject ≥0.72 vs ≤0.05. */
export const CONFLICT_SAME_SUBJECT_MIN = 0.5;
export const CONFLICT_BOTH_TRUE_MAX = 0.5;

/**
 * mem_save conflict check. For the neighbours findSimilarFacts
 * already found, ask Jev two measured Nouls per neighbour in ONE request:
 * same_subject and both_can_be_true. same_subject ≥ 0.5 AND both_true < 0.5
 * is a likely conflict. Duplicate detection is deliberately NOT attempted with
 * Jev (measured 5/8; "refines" is an attractor).
 *
 * Warning only, and additive: the save has already happened, a failed or
 * disabled Jev returns no warnings, and nothing is blocked or reordered.
 */
export async function conflictWarnings(newContent: string, neighbours: SimilarFact[], opts: JevOptions = {}): Promise<string[]> {
  if (!neighbours.length) return [];
  const existing: Record<string, string> = {};
  const questions: Record<string, JevQuestion> = {};
  for (const n of neighbours) {
    const key = `f${n.id}`;
    existing[key] = n.content;
    questions[`same_${key}`] = { type: "noul", instructions: `Are \`new_fact\` and \`existing.${key}\` about the same subject?` };
    questions[`both_${key}`] = {
      type: "noul",
      instructions: `Can \`existing.${key}\` and \`new_fact\` both be true at the same moment in time?`,
      criteria: { true: "They are compatible", false: `They conflict: if new_fact holds now, existing.${key} no longer holds as written` },
    };
  }
  const r = await askJev({ new_fact: newContent, existing }, questions, { use: "save-conflict", ...opts });
  if (!r) return [];
  const out: string[] = [];
  for (const n of neighbours) {
    const same = r.answers[`same_f${n.id}`]?.noul;
    const both = r.answers[`both_f${n.id}`]?.noul;
    if (typeof same !== "number" || typeof both !== "number") continue;
    if (same >= CONFLICT_SAME_SUBJECT_MIN && both < CONFLICT_BOTH_TRUE_MAX) {
      // Caller-facing text stays one sentence; scores and model id are not for the caller.
      out.push(`fact #${n.id} appears to conflict — if this replaces it use mem_supersede.`);
    }
  }
  if (out.length) recordJevUsage("save-conflict", "fired", opts.usageRoot);
  return out;
}
