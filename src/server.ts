#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb, hasVec } from "./db.js";
import { effectiveScope, search, formatHits, knownProjects, ORIGINS, projectDiagnostic, responseNotes, timeline, vectorLegErrors } from "./search.js";
import { saveFact, supersedeFact, retractFact, relate, neighbors, findSimilarFacts, FactKind, FACT_KINDS, conflictWarnings } from "./facts.js";
import { checkpointFromMcp } from "./checkpoint.js";
import { config } from "./config.js";
import { jevMissJudge, MissTracker, recordSearch } from "./misses.js";
import { jevSkippedSensitive, jevStatus } from "./jev.js";
import { staleRulingNote } from "./disagree.js";
import { callerProjectFor, scopeNote } from "./scope.js";

const db = openDb();
// One tracker per server process = one per Claude session (re-query tripwire).
const misses = new MissTracker({ projects: () => knownProjects(db) });
// Decided once per process: MEMD_JEV=0 or no key means no judge at all.
const missJudge = jevStatus().enabled ? jevMissJudge() : undefined;
// The session's own project, from the cwd Claude Code spawned this server in:
// mem_search ranks it up when the caller passes no project.
const callerProject = callerProjectFor(process.cwd());

const server = new McpServer({ name: "memd", version: "0.1.0" });

/** Prepend any response notes above the hits, in the order given. */
function withNotes(body: string, ...notes: (string | undefined)[]): string {
  const present = notes.filter((n): n is string => Boolean(n));
  return present.length ? `${present.join("\n\n")}\n\n${body}` : body;
}

const kindEnum = z.enum(FACT_KINDS);
// "ruling" = the user's rulings/postures — the fact class where stale recall is a safety hazard;
// all facts are chain-resolved at search time, rulings especially depend on it.
// "feedback" = friction with memd itself; hidden from ordinary searches.

server.registerTool(
  "mem_search",
  {
    title: "Search machine-wide memory",
    description:
      "Hybrid search (BM25 + local vector + recency + importance) over EVERY Claude Code session on this machine — all projects, all time — plus the curated facts ledger. Use this before asking the user to re-explain prior work ('what did we already try on X?'). Returns provenance-tagged excerpts under a strict token budget. " +
      // The docs layer is a CURATION policy, not a repo mirror. A repo's own
      // docs/ file that it treats as domain truth is simply not in the corpus,
      // and a thin result must not read as "the repo has nothing on this".
      "COVERAGE: the docs layer indexes a FIXED set (per-project memory dirs, CONTEXT.md, DECISIONS.md, skills; override with MEMD_DOC_ROOTS) — repo docs/ trees, README.md, and CLAUDE.md/AGENTS.md are NOT indexed, so a thin result may mean 'not covered' rather than 'nothing exists'. Episodes cover every session regardless.",
    inputSchema: {
      query: z.string().describe("Natural-language or keyword query"),
      project: z.string().optional().describe("Restrict to one project (e.g. 'my-app'). Default: all projects, with this session's own project (its working directory) ranked up"),
      sources: z.array(z.enum(["episodes", "facts", "docs"])).optional().describe("Default: all three (docs = curated files indexed as current state)"),
      limit: z.number().int().min(1).max(40).optional(),
      max_tokens: z.number().int().min(500).max(100_000).optional(),
      rerank: z.boolean().optional().describe("Cross-encoder rerank of top candidates (slower, higher precision)"),
      origin: z.enum(ORIGINS).optional().describe("Restrict to episodes from one tool's sessions"),
      include_feedback: z.boolean().optional().describe("kind:'feedback' facts (memd retrieval friction) are hidden unless the query names memd or a retrieval miss. Set true when asking whether a memd problem has been seen before; false forces them out"),
    },
  },
  async (args) => {
    const hits = await search(db, args.query, {
      project: args.project,
      sources: args.sources,
      limit: args.limit,
      maxTokens: args.max_tokens,
      rerank: args.rerank,
      origin: args.origin,
      includeFeedback: args.include_feedback,
      callerProject,
    });
    // Auto-capture (MEMD-FEEDBACK-HOOK): deferred and error-proof, so it can
    // neither slow nor break the response below.
    recordSearch(misses, {
      query: args.query,
      project: args.project,
      sources: args.sources,
      origin: args.origin,
      limit: args.limit,
      hits: hits.map((h) => `${h.source}:${h.id}`),
      texts: hits.slice(0, 5).map((h) => h.text),
    }, missJudge);
    // Response notes are assembled HERE, at the server layer, so there is one
    // prepend mechanism rather than one per finding:
    //  - a project filter that matched nothing must say so, because an
    //    empty result set otherwise reads as "the store has nothing on this".
    //  - an aggregate-shaped question must be told it got a sample.
    //  - results that disagree on a ruling-shaped question get a note
    //    naming the newest position (Jev, trigger-gated, 2 s cap, silent on
    //    failure). Hits are never reordered.
    const stale = await staleRulingNote(args.query, hits);
    return { content: [{ type: "text", text: withNotes(formatHits(hits), ...responseNotes(db, args.query, { project: args.project }), stale, scopeNote(effectiveScope(db, { project: args.project, callerProject }, args.query))) }] };
  }
);

server.registerTool(
  "mem_save",
  {
    title: "Save a durable fact/decision",
    description:
      "Persist a fact, decision, preference, constraint, todo, or feedback (friction with memd itself — hidden from ordinary searches) to the machine-wide ledger with an importance score (1-10). Facts are temporal: use mem_supersede to replace one, never re-save duplicates. Save architectural decisions, troubleshooting conclusions, and cross-project facts a future session (in ANY directory) will need.",
    inputSchema: {
      content: z.string().describe("The fact, stated so a future session with zero context understands it"),
      project: z.string().optional().describe("Project tag; omit for global facts"),
      kind: kindEnum.optional(),
      importance: z.number().int().min(1).max(10).optional().describe("10 = critical constraint, 5 = default, 1 = trivia"),
      session_id: z.string().optional().describe("Originating session id, if known"),
    },
  },
  async (args) => {
    const res = saveFact(db, {
      content: args.content,
      project: args.project,
      kind: args.kind as FactKind | undefined,
      importance: args.importance,
      sourceSession: args.session_id,
    });
    let text = res.existed
      ? `Identical active fact already exists: #${res.id} (not re-saved).`
      : `Saved fact #${res.id}.`;
    if (res.similar.length) {
      text +=
        "\nSimilar active facts exist — if this replaces one of them, use mem_supersede; if it contradicts one, relate them with 'contradicts':\n" +
        res.similar.map((s) => `- #${s.id}: ${s.content.slice(0, 150)}`).join("\n");
      // Additive Jev check, bounded by its 3 s timeout; no signal = no line.
      const conflicts = await conflictWarnings(args.content, res.similar);
      if (conflicts.length) text += "\n" + conflicts.join("\n");
    }
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "mem_forget",
  {
    title: "Retract a fact",
    description:
      "Retract a fact saved in error: closes its validity window with no successor, so it stops surfacing in retrieval but remains in the audit trail. Use mem_supersede instead when a replacement statement exists.",
    inputSchema: {
      fact_id: z.number().int(),
      reason: z.string().optional().describe("Why it is being retracted (appended to the audit record)"),
    },
  },
  async (args) => {
    retractFact(db, args.fact_id, args.reason);
    return { content: [{ type: "text", text: `Fact #${args.fact_id} retracted.` }] };
  }
);

server.registerTool(
  "mem_checkpoints",
  {
    title: "List restoration checkpoints",
    description: "Inspect pre-compaction restoration briefs: id, session, project, trigger, created, consumed state.",
    inputSchema: {
      project: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async (args) => {
    const rows = db
      .prepare(
        `SELECT id, session_id, project, created_at, trigger, consumed_at FROM checkpoints
         ${args.project ? "WHERE project = ?" : ""} ORDER BY created_at DESC LIMIT ?`
      )
      .all(...(args.project ? [args.project, args.limit ?? 10] : [args.limit ?? 10])) as any[];
    const text = rows.length
      ? rows
          .map(
            (r) =>
              `#${r.id} ${r.project} session=${String(r.session_id).slice(0, 8)} trigger=${r.trigger} created=${r.created_at} ${r.consumed_at ? "consumed=" + r.consumed_at : "UNCONSUMED"}`
          )
          .join("\n")
      : "No checkpoints.";
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "mem_supersede",
  {
    title: "Supersede a fact",
    description:
      "Replace an outdated fact non-destructively: closes the old fact's validity window, inserts the replacement, and links them. The old fact stays auditable but stops surfacing in retrieval.",
    inputSchema: {
      fact_id: z.number().int().describe("The fact being replaced"),
      content: z.string().describe("The replacement statement"),
      importance: z.number().int().min(1).max(10).optional(),
      kind: kindEnum.optional(),
    },
  },
  async (args) => {
    const before = db.prepare("SELECT importance FROM facts WHERE id = ?").get(args.fact_id) as { importance: number } | undefined;
    const id = supersedeFact(db, args.fact_id, {
      content: args.content,
      importance: args.importance,
      kind: args.kind as FactKind | undefined,
    });
    if (id === args.fact_id) {
      const after = db.prepare("SELECT importance FROM facts WHERE id = ?").get(id) as { importance: number };
      const imp = before && after.importance !== before.importance ? ` Its importance was updated from ${before.importance} to ${after.importance}.` : "";
      return { content: [{ type: "text", text: `Fact #${id} unchanged: the replacement is identical to it (same text, kind and project), so nothing was superseded.${imp}` }] };
    }
    let text = `Fact #${args.fact_id} superseded by #${id}.`;
    const leftovers = findSimilarFacts(db, args.content, id).filter((s) => s.id !== args.fact_id);
    if (leftovers.length) {
      text +=
        "\nStill-active similar facts (possible duplicates of the replaced claim — supersede or mem_forget them too if so):\n" +
        leftovers.map((s) => `- #${s.id}: ${s.content.slice(0, 150)}`).join("\n");
    }
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "mem_relate",
  {
    title: "Relate two memory nodes",
    description:
      "Create a directed, typed relation between memory nodes (facts or episodes), e.g. fact 12 'blocks' fact 30, or fact 12 'derived_from' episode 991. Provenance links, one hop: mem_graph lists a fact's direct neighbours, and search reads only 'contradicts' edges (to mark a fact CONTESTED).",
    inputSchema: {
      from_id: z.number().int(),
      relation: z.string().describe("Verb, e.g. depends_on, blocks, derived_from, part_of, contradicts"),
      to_id: z.number().int(),
      from_kind: z.enum(["fact", "episode"]).optional(),
      to_kind: z.enum(["fact", "episode"]).optional(),
    },
  },
  async (args) => {
    relate(db, args.from_id, args.relation, args.to_id, args.from_kind ?? "fact", args.to_kind ?? "fact");
    return { content: [{ type: "text", text: `Related ${args.from_kind ?? "fact"} #${args.from_id} -[${args.relation}]-> ${args.to_kind ?? "fact"} #${args.to_id}.` }] };
  }
);

server.registerTool(
  "mem_graph",
  {
    title: "Inspect a fact's relations",
    description: "List a fact's incoming/outgoing relations with neighbor previews.",
    inputSchema: { fact_id: z.number().int() },
  },
  async (args) => {
    const n = neighbors(db, args.fact_id);
    const text = n.length
      ? n.map((r) => `${r.direction === "out" ? "→" : "←"} [${r.relation}] ${r.kind} #${r.id}: ${r.content ?? ""}`).join("\n")
      : "No relations.";
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "mem_timeline",
  {
    title: "Chronological episode timeline",
    description:
      "Read indexed transcript episodes in chronological order (secrets redacted, long tool output truncated) — reconstruct what happened in a session or project window (audit trail). Filter by project, session id prefix, and/or ISO time bounds.",
    inputSchema: {
      project: z.string().optional(),
      session_id: z.string().optional().describe("Full id or prefix"),
      after: z.string().optional().describe("ISO timestamp lower bound"),
      before: z.string().optional().describe("ISO timestamp upper bound"),
      limit: z.number().int().min(1).max(200).optional(),
      max_tokens: z.number().int().min(500).max(100_000).optional(),
    },
  },
  async (args) => {
    const hits = timeline(db, {
      project: args.project,
      sessionId: args.session_id,
      after: args.after,
      before: args.before,
      limit: args.limit,
      maxTokens: args.max_tokens,
    });
    // timeline() IS the exhaustive path the sampling banner points at, so it
    // takes the project diagnostic only — banner-ing a census would be wrong.
    return { content: [{ type: "text", text: withNotes(formatHits(hits), projectDiagnostic(db, args.project)) }] };
  }
);

server.registerTool(
  "mem_checkpoint",
  {
    title: "Manual checkpoint",
    description:
      "Manually snapshot the current session state (the PreCompact hook does this automatically before compaction). Indexes this session's transcript and writes a restoration brief a future session can pick up.",
    inputSchema: {
      session_id: z.string().optional(),
      transcript_path: z.string().optional(),
      cwd: z.string().optional(),
    },
  },
  async (args) => {
    const r = await checkpointFromMcp(db, args);
    return { content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) };
  }
);

server.registerTool(
  "mem_stats",
  {
    title: "Memory store health",
    description: "Counts, per-project coverage, embedding backlog, and index freshness for the machine-wide store.",
    inputSchema: {},
  },
  async () => {
    const one = (sql: string) => (db.prepare(sql).get() as any)?.n ?? 0;
    const episodes = one("SELECT COUNT(*) n FROM episodes");
    const pending = one("SELECT COUNT(*) n FROM episodes WHERE embedded = 0");
    const facts = one("SELECT COUNT(*) n FROM facts WHERE valid_to IS NULL");
    const sessions = one("SELECT COUNT(*) n FROM sessions");
    const lastIndex = (db.prepare("SELECT value FROM meta WHERE key = 'last_index_at'").get() as any)?.value ?? "never";
    const byProject = db
      .prepare("SELECT project, COUNT(*) n FROM episodes GROUP BY project ORDER BY n DESC LIMIT 15")
      .all() as any[];
    const docsN = one("SELECT COUNT(*) n FROM docs");
    const docFiles = one("SELECT COUNT(DISTINCT path) n FROM docs");
    const pct = episodes ? Math.round((100 * (episodes - pending)) / episodes) : 0;
    const text = [
      `episodes: ${episodes} (${pending} awaiting embedding) | active facts: ${facts} | doc chunks: ${docsN} (${docFiles} files) | sessions: ${sessions}`,
      `vector search: ${hasVec() ? `available — ${pct}% of episodes embedded, lexical-only beyond that` : "UNAVAILABLE (FTS-only mode)"} | last corpus index: ${lastIndex}`,
      `db: ${config.dbPath}`,
      `jev: ${jevStatus().reason}; ${jevSkippedSensitive()} request(s) skipped as sensitive-topic`,
      `vector leg errors (this process): ${vectorLegErrors.count}${vectorLegErrors.last ? ` — last: ${vectorLegErrors.last}` : ""}`,
      "top projects: " + byProject.map((r) => `${r.project}(${r.n})`).join(", "),
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
