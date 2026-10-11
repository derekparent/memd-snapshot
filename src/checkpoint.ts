import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { config } from "./config.js";
import { DB, nowIso } from "./db.js";
import { indexCorpus, isExcluded, projectForCwd, transcriptLayout } from "./indexer.js";

/**
 * Deterministic compaction survival. These functions are driven by Claude
 * Code hooks, not by the model choosing to call a tool:
 *   PreCompact    -> checkpointFromHook(): index the transcript,
 *                    then persist a restoration brief.
 *   SessionStart  -> restoreForHook(): emit the latest unconsumed brief as
 *                    additionalContext so the fresh context starts oriented.
 */

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  trigger?: string;
  source?: string;
}

function safeGit(cwd: string | undefined, args: string[]): string {
  if (!cwd) return "";
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

function projectOfSession(db: DB, sessionId: string, cwd?: string): string {
  const row = db.prepare("SELECT project FROM sessions WHERE session_id = ?").get(sessionId) as any;
  if (row?.project) return row.project;
  return cwd ? projectForCwd(cwd) : "unknown";
}

/**
 * A caller-supplied transcript path (mem_checkpoint takes one as an argument)
 * is accepted only if it RESOLVES — symlinks followed, via realpath.native so a
 * case-variant root on APFS still matches — to a regular .jsonl file that the
 * sweep itself would index:
 *  - under the Claude root: one of the transcriptLayout() shapes, directly in
 *    a project dir that is not excluded (so no deeper stray file, and no
 *    excluded project reached through a subagents/ path);
 *  - under the Codex root: any .jsonl (rollouts live in date directories).
 * Returns the RESOLVED path; callers must index that, not the path they were
 * given, or a symlink swapped after the check escapes it.
 */
export function resolveTranscriptPath(
  p: string,
  roots: { claude: string; codex: string } = { claude: config.transcriptsRoot, codex: config.codexRoot }
): string | undefined {
  const resolve = (x: string) => {
    try {
      return fs.realpathSync.native(x);
    } catch {
      return undefined;
    }
  };
  const real = resolve(p);
  if (!real || !real.endsWith(".jsonl")) return undefined;
  try {
    if (!fs.statSync(real).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const claude = resolve(roots.claude);
  if (claude && real.startsWith(claude + path.sep)) {
    const loc = transcriptLayout(real);
    if (!loc || path.dirname(loc.projectDir) !== claude) return undefined;
    return isExcluded(path.basename(loc.projectDir)) ? undefined : real;
  }
  const codex = resolve(roots.codex);
  if (codex && real.startsWith(codex + path.sep)) return real;
  return undefined;
}

/** The mem_checkpoint tool body, kept here so it can be tested without an MCP server. */
export async function checkpointFromMcp(
  db: DB,
  args: { session_id?: string; transcript_path?: string; cwd?: string },
  roots?: { claude: string; codex: string }
): Promise<{ text: string; isError?: true }> {
  if (!args.session_id || !args.transcript_path) {
    return {
      isError: true,
      text: "Refused: mem_checkpoint needs session_id AND transcript_path (cwd recommended) — without them the checkpoint would be misattributed and index nothing. Your transcript lives under ~/.claude/projects/<cwd-slug>/<session_id>.jsonl.",
    };
  }
  const real = resolveTranscriptPath(args.transcript_path, roots);
  if (!real) {
    return {
      isError: true,
      text: "Refused: transcript_path must resolve (symlinks followed) to a .jsonl transcript the sweep would index: a session or subagent transcript in a non-excluded project dir under ~/.claude/projects, or a rollout under ~/.codex/sessions.",
    };
  }
  // Under the Claude root the transcript names its own session: derive it and
  // require the caller's session_id to match, or the brief is filed under a
  // session this transcript never wrote to (empty, or claimed by another
  // live session's restore). Codex rollouts are keyed by file id, not checked.
  let claudeRoot: string | undefined;
  try {
    claudeRoot = fs.realpathSync.native(roots?.claude ?? config.transcriptsRoot);
  } catch {
    claudeRoot = undefined;
  }
  if (claudeRoot && real.startsWith(claudeRoot + path.sep)) {
    const key = transcriptLayout(real)?.sessionKey;
    if (key !== args.session_id) {
      return {
        isError: true,
        text: `Refused: transcript_path belongs to session ${key}, not session_id ${args.session_id}. Pass the session_id of the transcript you are checkpointing (a subagent's is <parent>/agent-<id>).`,
      };
    }
  }
  const { id, project } = await buildCheckpoint(db, { session_id: args.session_id, transcript_path: real, cwd: args.cwd, trigger: "manual" });
  return { text: `Checkpoint #${id} written for ${project}.` };
}

export async function buildCheckpoint(db: DB, input: HookInput): Promise<{ id: number; project: string }> {
  // Refuse misattribution at the engine layer so EVERY surface (MCP tool, CLI
  // verb, future callers) inherits it — a checkpoint "for unknown" that indexed
  // nothing is a silent no-op wearing a success message.
  if (!input.session_id || !input.transcript_path) {
    throw new Error(
      "checkpoint needs session_id AND transcript_path (cwd recommended) — without them it would be misattributed and index nothing. Transcripts live at ~/.claude/projects/<cwd-slug>/<session_id>.jsonl"
    );
  }
  await indexCorpus(db, { onlyTranscript: input.transcript_path });
  const sessionId = input.session_id;
  const project = projectOfSession(db, sessionId, input.cwd);

  // Real asks only: first chunk, human-sized, not interruption markers or
  // injected skill/system payloads (those also arrive as user-role lines).
  const lastUser = db
    .prepare(
      `SELECT content, ts FROM episodes
       WHERE session_id = ? AND role = 'user' AND kind = 'text' AND chunk_no = 0 AND quarantined = 0
         AND length(content) < 1500
         AND content NOT LIKE '[Request interrupted%'
         AND content NOT LIKE '%<system-reminder>%'
         AND content NOT LIKE 'Base directory for this skill%'
       ORDER BY ts DESC, id DESC LIMIT 3`
    )
    .all(sessionId) as any[];
  const lastAssistant = db
    .prepare(
      `SELECT content FROM episodes WHERE session_id = ? AND role = 'assistant' AND kind = 'text' AND quarantined = 0
       ORDER BY ts DESC, id DESC LIMIT 2`
    )
    .all(sessionId) as any[];
  const recentFileTools = db
    .prepare(
      `SELECT content FROM episodes WHERE session_id = ? AND kind = 'tool_use' AND quarantined = 0
       AND (content LIKE '[tool:Edit]%' OR content LIKE '[tool:Write]%' OR content LIKE '[tool:Bash]%')
       ORDER BY ts DESC, id DESC LIMIT 12`
    )
    .all(sessionId) as any[];

  const gitStatus = safeGit(input.cwd, ["status", "--short"]);
  const gitBranch = safeGit(input.cwd, ["branch", "--show-current"]);

  const brief = [
    `# memd restoration brief — ${project} (${nowIso()})`,
    input.trigger ? `Trigger: ${input.trigger} compaction of session ${sessionId.slice(0, 8)}.` : "",
    "",
    "## Most recent user asks (newest first)",
    ...lastUser.map((r) => `- ${r.content.slice(0, 600)}`),
    "",
    "## Last assistant state",
    ...lastAssistant.map((r) => `- ${r.content.slice(0, 800)}`),
    "",
    gitStatus ? `## Working tree (${gitBranch || "?"})\n${gitStatus.slice(0, 1500)}` : "",
    "",
    recentFileTools.length ? "## Recent file/command activity\n" + recentFileTools.map((r) => `- ${r.content.slice(0, 200)}`).join("\n") : "",
    "",
    "The history of this and every other session is searchable via the memd MCP tools (mem_search, mem_timeline), with secrets redacted and long tool output truncated.",
  ]
    .filter((s) => s !== "")
    .join("\n");

  const res = db
    .prepare(
      `INSERT INTO checkpoints (session_id, project, created_at, trigger, brief)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(sessionId, project, nowIso(), input.trigger ?? "manual", brief);
  return { id: Number(res.lastInsertRowid), project };
}

const RESTORE_WINDOW_MS = 48 * 3600 * 1000;

/** Find and mark-consumed the brief for this session in ONE transaction, so
 *  two sessions restoring at the same moment cannot both claim an orphan. */
function claimCheckpoint(db: DB, sessionId: string, projects: string[]): any {
  let row = db
    .prepare(
      `SELECT id, brief, created_at FROM checkpoints
       WHERE session_id = ? AND consumed_at IS NULL ORDER BY julianday(created_at) DESC LIMIT 1`
    )
    .get(sessionId) as any;
  if (!row && projects.length) {
    // Cross-session project fallback is for ORPHANED briefs only (dead session
    // whose own restore never fired). A live session consumes its brief within
    // seconds of compaction, so require 15 minutes of age before another
    // session may claim it — otherwise a pair-mate's resume steals a fresh
    // brief out from under its owner.
    // Compare as TIME via julianday(), never as strings: created_at is ISO
    // ("…T…Z") while datetime('now') is "… …", and 'T' > ' ' made every
    // same-day ISO row look newer than the cutoff, so no orphan was restored.
    row = db
      .prepare(
        `SELECT id, brief, created_at FROM checkpoints
         WHERE project IN (SELECT value FROM json_each(?)) AND consumed_at IS NULL AND session_id != ?
           AND julianday(created_at) < julianday('now', '-15 minutes')
         ORDER BY julianday(created_at) DESC LIMIT 1`
      )
      .get(JSON.stringify(projects), sessionId) as any;
  }
  if (!row) return null;
  if (Date.now() - Date.parse(row.created_at) > RESTORE_WINDOW_MS) return null;
  db.prepare("UPDATE checkpoints SET consumed_at = ? WHERE id = ?").run(nowIso(), row.id);
  return row;
}

export function restoreBrief(db: DB, input: HookInput): string | null {
  const sessionId = input.session_id ?? "";
  // Canonical name first; the bare directory name too, because checkpoints
  // written before projectForCwd existed were filed under path.basename(cwd).
  const project = input.cwd ? projectForCwd(input.cwd) : undefined;
  const names = input.cwd ? [...new Set([project!, path.basename(input.cwd)])] : [];
  const row = db.transaction(() => claimCheckpoint(db, sessionId, names))();
  if (!row) return null;

  const topFacts = db
    .prepare(
      `SELECT id, kind, importance, content FROM facts
       WHERE valid_to IS NULL AND (project IN (SELECT value FROM json_each(?)) OR project IS NULL)
         AND kind != 'feedback' -- tooling friction is not project state
       ORDER BY importance DESC, created_at DESC LIMIT 8`
    )
    .all(JSON.stringify(names)) as any[];
  const factsBlock = topFacts.length
    ? "\n\n## Active high-importance facts for this project\n" +
      topFacts.map((f) => `- (#${f.id}, ${f.kind}, imp ${f.importance}) ${f.content.slice(0, 300)}`).join("\n")
    : "";
  return row.brief + factsBlock;
}

/** Fire-and-forget incremental corpus index so the store tracks live work. */
export function spawnBackgroundIndex(cliPath: string): void {
  try {
    const child = spawn(process.execPath, [cliPath, "index"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // background freshness is best-effort by design
  }
}
