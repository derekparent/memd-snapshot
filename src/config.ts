import os from "node:os";
import path from "node:path";

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function envFloat(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

const home = os.homedir();

/**
 * Claude Code names each transcript dir after the session's cwd with every
 * character that is not a letter or a digit turned into "-"
 * ("/home/john_doe/My Code/app" -> "-home-john-doe-My-Code-app"). The rule is
 * Claude Code's own (read from its 2.1 CLI), not something memd chooses.
 *
 * The slug is lossy: "my_app", "my.app" and "my-app" all become "my-app", so a
 * project named from a slug alone carries dashes where the directory may not.
 * Claude Code also cuts a slug at 200 characters and appends a hash; a path
 * that long is not matched here.
 */
export function slugForPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}

/** A root as configured: "~" expanded, no trailing slash ("/" stays "/"). */
function rootDir(p: string): string {
  const abs = p === "~" || p.startsWith("~/") ? path.join(home, p.slice(1)) : p;
  return abs.replace(/\/+$/, "") || "/";
}

function envList(name: string, def: string[]): string[] {
  return (process.env[name] ?? def.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  home,
  /**
   * Where the repos live. A transcript dir whose slug starts with this root's
   * slug is tagged with the repo's directory name.
   */
  projectsRoot: rootDir(process.env.MEMD_PROJECTS_ROOT || path.join(home, "Projects")),
  /**
   * Root of per-seat worktrees named "<repo>-<seat>" (a builder/reviewer
   * pair). Sessions there are tagged with <repo>, not with the seat's dir.
   * Off until MEMD_WORKTREE_ROOT and MEMD_WORKTREE_SEATS are both set.
   */
  worktreeRoot:
    process.env.MEMD_WORKTREE_ROOT === undefined
      ? undefined
      : process.env.MEMD_WORKTREE_ROOT
        ? rootDir(process.env.MEMD_WORKTREE_ROOT)
        : undefined,
  /**
   * Project names that mean another project, as pairs
   * "<name as derived>=<name to use>", comma-separated. A repo renamed from
   * atlas to atlas-lab keeps one history with "atlas-lab=atlas". Applied
   * wherever a project name is derived from a path or an origin (sessions and
   * docs); stored rows are not rewritten.
   */
  projectAliases: new Map(
    envList("MEMD_PROJECT_ALIASES", [])
      .map((pair) => pair.split("=").map((s) => s.trim()))
      .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
  ),
  /** Seat suffixes stripped from worktree dir names under worktreeRoot. */
  worktreeSeats: envList("MEMD_WORKTREE_SEATS", []),
  /**
   * More seat suffixes for `backfill-projects` only: seats used in the past,
   * stripped from a worktree dir name in addition to worktreeSeats.
   */
  backfillSeats: envList("MEMD_BACKFILL_SEATS", []),
  /**
   * "<repo>/<dir>" pairs under the projects root that `backfill-projects` does
   * not count as work in <repo>: directories every session writes to at
   * wrap-up, whatever it worked on.
   */
  backfillLedgerDirs: envList("MEMD_BACKFILL_LEDGER_DIRS", []),
  /** Machine-wide store — deliberately NOT per-project. Project is a tag, not a wall. */
  dbPath: process.env.MEMD_DB_PATH ?? path.join(home, ".claude", "memd", "memd.db"),
  /** Claude Code transcript corpus root. */
  transcriptsRoot: process.env.MEMD_TRANSCRIPTS_ROOT ?? path.join(home, ".claude", "projects"),
  /** Codex CLI/Desktop rollout corpus root (adapter skips cleanly if absent). */
  codexRoot: process.env.MEMD_CODEX_ROOT ?? path.join(home, ".codex", "sessions"),
  /**
   * Never download a model: use what is cached, else work without it (lexical
   * search only). MEMD_OFFLINE=1, or --offline on the CLI.
   */
  offline: /^(1|true|yes|on)$/i.test(process.env.MEMD_OFFLINE ?? ""),
  /** Where models are downloaded from when not the Hugging Face Hub (a mirror; the tests use a local stand-in). */
  modelHost: process.env.MEMD_MODEL_HOST || undefined,
  /** Local model cache for transformers.js (kept out of ~/.cache for visibility). */
  modelCacheDir: process.env.MEMD_MODEL_DIR ?? path.join(home, ".claude", "memd", "models"),

  /** Hard cap on tokens in any retrieval response (PRD: MCP_MAX_TOKENS). */
  maxTokens: envInt("MEMD_MAX_TOKENS", envInt("MCP_MAX_TOKENS", 25_000)),
  /** Fraction of maxTokens actually used (PRD: MCP_TOKEN_SAFETY_BUFFER). */
  tokenSafetyBuffer: envFloat("MEMD_TOKEN_SAFETY_BUFFER", envFloat("MCP_TOKEN_SAFETY_BUFFER", 0.8)),
  minItems: envInt("MEMD_MIN_ITEMS", 3),
  maxItems: envInt("MEMD_MAX_ITEMS", 40),

  /** Embedding model — 384-dim, runs fully local via ONNX. */
  embedModel: process.env.MEMD_EMBED_MODEL ?? "Xenova/bge-small-en-v1.5",
  embedDim: envInt("MEMD_EMBED_DIM", 384),
  /** bge models want this prefix on QUERIES only (not documents). */
  embedQueryPrefix: "Represent this sentence for searching relevant passages: ",
  /** Cross-encoder used for the optional rerank stage. */
  rerankModel: process.env.MEMD_RERANK_MODEL ?? "Xenova/ms-marco-MiniLM-L-6-v2",

  /** Recency half-life for the decay term, in days. */
  decayHalfLifeDays: envFloat("MEMD_DECAY_HALFLIFE_DAYS", 30),
  /** Hybrid ranking weights: fused lexical+vector relevance, recency, importance. */
  weightRecency: envFloat("MEMD_W_RECENCY", 0.2),
  weightImportance: envFloat("MEMD_W_IMPORTANCE", 0.2),
  /** Caller-project scope: the caller's own episodes score x(1 + this). 0 = scoped candidates, no boost. */
  scopeBoost: envFloat("MEMD_SCOPE_BOOST", 0.5),
  /** Reciprocal-rank-fusion constant. */
  rrfK: envInt("MEMD_RRF_K", 60),

  /** Episode chunking. */
  chunkChars: envInt("MEMD_CHUNK_CHARS", 1600),
  chunkOverlap: envInt("MEMD_CHUNK_OVERLAP", 160),
  /** Transcript project-dir slugs to skip (globs, matched on dir basename). */
  /**
   * "-" is the slug of cwd "/": headless runs under launchd or cron start
   * there. Such runs are usually automation output, not a project, and before
   * this default they were tagged with an empty project name.
   */
  excludeProjects: (process.env.MEMD_EXCLUDE_PROJECTS ?? "-private-tmp-*,-").split(",").filter(Boolean),

  /**
   * Curated-docs roots (docs layer): files here are indexed as CURRENT STATE,
   * re-indexed on mtime change. One `*` path segment supported per root.
   */
  /**
   * CHANGING THIS LIST? Update the COVERAGE sentence in the mem_search tool
   * description (src/server.ts) too — it names these roots in prose so agents
   * can tell "not covered" from "nothing exists", and a stale description
   * is a lie told to every caller.
   */
  docRoots: envList("MEMD_DOC_ROOTS", [
      "~/.claude/projects/*/memory",
      "~/Projects/*/CONTEXT.md",
      "~/Projects/*/DECISIONS.md",
      "~/.claude/skills",
      "~/Projects/*/.claude/skills",
  ]),
};

export function tokenBudget(requested?: number): number {
  const cap = Math.min(requested ?? config.maxTokens, config.maxTokens);
  return Math.floor(cap * config.tokenSafetyBuffer);
}
