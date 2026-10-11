import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config, slugForPath } from "./config.js";
import { DB, nowIso } from "./db.js";
import { parseLine } from "./chunker.js";

/**
 * Incremental sweep of the Claude Code transcript corpus. Each transcript file
 * is read from its last indexed byte offset (transcripts are append-only), so
 * re-runs are cheap. Sessions table doubles as the offset ledger.
 */

export interface IndexStats {
  filesScanned: number;
  filesIndexed: number;
  episodesAdded: number;
  bytesRead: number;
}

/** A derived project name, after MEMD_PROJECT_ALIASES (one hop: an alias of an alias is not followed). */
export function canonicalProject(name: string): string {
  return config.projectAliases.get(name) ?? name;
}

export function projectFromDir(dirName: string): string {
  return canonicalProject(slugProject(dirName));
}

function slugProject(dirName: string): string {
  // Per-seat worktrees belong to their repo, not a per-seat silo:
  // "<worktreeRoot slug>-app-<seat>" -> "app"
  if (config.worktreeRoot && config.worktreeSeats.length) {
    const wtMarker = slugForPath(config.worktreeRoot) + "-";
    if (dirName.startsWith(wtMarker)) {
      const rest = dirName.slice(wtMarker.length);
      for (const seat of config.worktreeSeats) {
        if (rest.endsWith("-" + seat) && rest.length > seat.length + 1) return rest.slice(0, -(seat.length + 1));
      }
    }
  }
  // "<projectsRoot slug>-app" -> "app"; best-effort de-slug.
  const named = projectUnderRoot(dirName);
  if (named !== undefined) return named;
  // Never "": a session run from "/" (launchd's default cwd for headless
  // `claude -p` jobs) slugs to "-", and an empty project tag is unaddressable
  // by any filter. Such dirs are excluded by default; this is the name they
  // get if someone opts them back in.
  return dirName.replace(/^-/, "") || "root";
}

/**
 * What the projects root itself is called as a project ("Projects" for
 * ~/Projects): the directory's own name, not its slug.
 */
export function projectsRootName(): string {
  return path.basename(config.projectsRoot) || "Projects";
}

/** The project a transcript-dir slug names when it is the projects root or a dir under it. */
export function projectUnderRoot(slug: string): string | undefined {
  const rootSlug = slugForPath(config.projectsRoot);
  if (slug === rootSlug) return projectsRootName();
  if (slug.startsWith(rootSlug + "-")) return slug.slice(rootSlug.length + 1) || projectsRootName();
  return undefined;
}

/**
 * Canonical-repo resolution at index time.
 *
 * projectFromDir above reads the transcript directory SLUG, which only knows
 * the shapes someone thought to write a regex for. A session's real repo is
 * knowable from its cwd, so ask git: any worktree, submodule, or oddly-placed
 * checkout of a repo resolves to the same origin, and seats export nothing.
 * The slug regex stays as the fallback for cwds git can't answer for.
 */
export function repoFromOriginUrl(originUrl: string): string | undefined {
  // git@github.com:example/memd.git, https://github.com/example/memd.git,
  // /home/alice/mirrors/memd, file:///srv/git/memd.git — all -> "memd".
  const trimmed = originUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  const last = trimmed.split(/[/:]/).pop();
  if (!last) return undefined;
  const name = last.replace(/\.git$/i, "");
  return name || undefined;
}

const repoCache = new Map<string, string | undefined>();

export function repoForCwd(cwd: string): string | undefined {
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  let repo: string | undefined;
  try {
    // A worktree's origin is its parent repo's origin — that IS the fix.
    const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const named = repoFromOriginUrl(url);
    repo = named && canonicalProject(named);
  } catch {
    // not a repo, no origin, or git unavailable — caller falls back to the slug
    repo = undefined;
  }
  repoCache.set(cwd, repo);
  return repo;
}

/** Recorded cwd of a transcript dir, read from the first line that carries one. */
export function cwdForTranscriptDir(dirPath: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const file = path.join(dirPath, entry);
    try {
      // cwd rides on early lines; read a bounded head rather than the whole file.
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(64 * 1024);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      for (const line of buf.subarray(0, read).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        const { meta } = parseLine(line);
        if (meta.cwd) return meta.cwd;
      }
    } catch {
      /* unreadable transcript — try the next one */
    }
  }
  return undefined;
}

/**
 * The one project name for a working directory, shared by every path that
 * knows a cwd (Codex rollouts, checkpoint restore): the git repo when git can
 * name it, else the same slug rule transcript dirs use. Before this, Codex and
 * restore used path.basename(cwd), so a worktree "app-<seat>" of repo
 * "app" carried two names.
 */
export function projectForCwd(cwd: string): string {
  if (fs.existsSync(cwd)) {
    const repo = repoForCwd(cwd);
    if (repo) return repo;
  }
  // Claude Code names a transcript dir by replacing every non-alphanumeric
  // character of the cwd with "-" (paths over 200 chars are hash-truncated,
  // which this does not reproduce).
  return projectFromDir(cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** Canonical project for a transcript dir: git-resolved, else the slug regex. */
export function projectForTranscriptDir(dirPath: string, dirName: string): string {
  const cwd = cwdForTranscriptDir(dirPath);
  if (cwd && fs.existsSync(cwd)) {
    const repo = repoForCwd(cwd);
    if (repo) return repo;
  }
  return projectFromDir(dirName);
}

export function isExcluded(dirName: string): boolean {
  return config.excludeProjects.some((glob) => {
    const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return re.test(dirName);
  });
}

/**
 * THE Claude Code transcript layout, in one place. Every caller (the sweep,
 * the single-transcript hook path, the mem_checkpoint path guard) uses this,
 * so "which files are transcripts, which project dir owns them, and what key
 * the offset ledger files them under" cannot drift apart. Three shapes:
 *
 *   <projectdir>/<session>.jsonl                                  key <session>
 *   <projectdir>/<session>/subagents/agent-<id>.jsonl             key <session>/agent-<id>
 *   <projectdir>/<session>/subagents/workflows/wf_<wid>/agent-<id>.jsonl
 *                                                                 key <session>/wf_<wid>/agent-<id>
 *
 * Subagent keys carry the parent session so `mem_timeline --session <parent>`
 * returns the subagents too, and so two sessions' agent ids cannot collide in
 * the offset ledger. Anything else (agent-*.meta.json, workflow journal.jsonl,
 * tool-results) is not a transcript: undefined.
 */
export interface TranscriptLocation {
  projectDir: string;
  sessionKey: string;
}
const AGENT_FILE = /^agent-[A-Za-z0-9_-]+\.jsonl$/;
export function transcriptLayout(filePath: string): TranscriptLocation | undefined {
  const file = path.basename(filePath);
  if (!file.endsWith(".jsonl")) return undefined;
  const dir = path.dirname(filePath);
  const up = (p: string, n: number): string => (n === 0 ? p : up(path.dirname(p), n - 1));
  if (path.basename(dir) === "subagents") {
    if (!AGENT_FILE.test(file)) return undefined;
    const session = path.basename(up(dir, 1));
    return { projectDir: up(dir, 2), sessionKey: `${session}/${file.slice(0, -6)}` };
  }
  if (path.basename(dir).startsWith("wf_") && path.basename(up(dir, 1)) === "workflows" && path.basename(up(dir, 2)) === "subagents") {
    if (!AGENT_FILE.test(file)) return undefined;
    const session = path.basename(up(dir, 3));
    return { projectDir: up(dir, 4), sessionKey: `${session}/${path.basename(dir)}/${file.slice(0, -6)}` };
  }
  return { projectDir: dir, sessionKey: file.slice(0, -6) };
}

/** Every transcript under one project dir, in the three shapes above. */
export function listProjectTranscripts(dirPath: string): string[] {
  const out: string[] = [];
  const isFile = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const isDir = (p: string) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const agents = (d: string) => {
    if (!isDir(d)) return;
    for (const a of fs.readdirSync(d)) if (AGENT_FILE.test(a) && isFile(path.join(d, a))) out.push(path.join(d, a));
  };
  for (const f of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, f);
    if (f.endsWith(".jsonl")) {
      if (isFile(full)) out.push(full);
      continue;
    }
    if (!isDir(full)) continue;
    const sub = path.join(full, "subagents");
    agents(sub);
    const wfRoot = path.join(sub, "workflows");
    if (isDir(wfRoot)) for (const wf of fs.readdirSync(wfRoot)) if (wf.startsWith("wf_")) agents(path.join(wfRoot, wf));
  }
  return out;
}

async function indexFile(db: DB, filePath: string, project: string, stats: IndexStats): Promise<void> {
  const sessionId = transcriptLayout(filePath)?.sessionKey ?? path.basename(filePath, ".jsonl");
  const size = fs.statSync(filePath).size;
  const row = db.prepare("SELECT indexed_bytes FROM sessions WHERE session_id = ?").get(sessionId) as
    | { indexed_bytes: number }
    | undefined;
  const offset = row?.indexed_bytes ?? 0;
  if (size <= offset) return;

  // Read exactly [offset, size) and only consume through the last complete
  // line. Hooks index transcripts the live session is still appending to, so
  // stat() can land mid-line; advancing indexed_bytes past a torn fragment
  // would skip that message forever (it never re-parses from mid-line).
  const buf = Buffer.alloc(size - offset);
  const fd = fs.openSync(filePath, "r");
  let read = 0;
  try {
    read = fs.readSync(fd, buf, 0, buf.length, offset);
  } finally {
    fs.closeSync(fd);
  }
  let consumed = buf.lastIndexOf(0x0a, read - 1) + 1;
  const tail = buf.subarray(consumed, read).toString("utf8");
  if (tail.trim() && parseLine(tail).chunks.length > 0) consumed = read; // complete line without trailing newline
  if (consumed === 0) return;
  const lines = buf.subarray(0, consumed).toString("utf8").split("\n");
  const bytes = offset + consumed;

  const insertEpisode = db.prepare(
    `INSERT OR IGNORE INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const upsertSession = db.prepare(
    `INSERT INTO sessions (session_id, project, cwd, git_branch, first_ts, last_ts, transcript_path, indexed_bytes)
     VALUES (@session_id, @project, @cwd, @git_branch, @ts, @ts, @path, @bytes)
     ON CONFLICT(session_id) DO UPDATE SET
       last_ts = COALESCE(excluded.last_ts, sessions.last_ts),
       cwd = COALESCE(excluded.cwd, sessions.cwd),
       git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
       indexed_bytes = excluded.indexed_bytes`
  );

  // NOTE: offset==0 lines may be partial if we start mid-file after a crash;
  // acceptable — INSERT OR IGNORE on (src_uuid, chunk_no) makes replays safe.
  let added = 0;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let lastTs: string | undefined;
  const pending: Parameters<typeof insertEpisode.run>[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const { chunks, meta } = parseLine(line);
    if (meta.cwd) cwd = meta.cwd;
    if (meta.gitBranch) gitBranch = meta.gitBranch;
    for (const c of chunks) {
      if (c.ts) lastTs = c.ts;
      pending.push([sessionId, project, c.ts || lastTs || nowIso(), c.role, c.kind, c.content, c.srcUuid, c.chunkNo]);
    }
  }

  const commit = db.transaction(() => {
    for (const args of pending) {
      const res = insertEpisode.run(...args);
      if (res.changes > 0) added++;
    }
    upsertSession.run({
      session_id: sessionId,
      project,
      cwd: cwd ?? null,
      git_branch: gitBranch ?? null,
      ts: lastTs ?? null,
      path: filePath,
      bytes,
    });
  });
  commit();

  stats.bytesRead += consumed;
  stats.episodesAdded += added;
  if (added > 0) stats.filesIndexed++;
}

export async function indexCorpus(db: DB, opts: { onlyTranscript?: string } = {}): Promise<IndexStats> {
  const stats: IndexStats = { filesScanned: 0, filesIndexed: 0, episodesAdded: 0, bytesRead: 0 };

  if (opts.onlyTranscript) {
    const loc = transcriptLayout(opts.onlyTranscript);
    if (!loc) return stats;
    const dirPath = loc.projectDir;
    // The hook path must honour the same exclusions as the full sweep, or a
    // headless run indexes itself through its own SessionStart/PreCompact hook.
    // The exclusion and the project come from the PROJECT dir, never from a
    // subagents/ dir in between.
    if (isExcluded(path.basename(dirPath))) return stats;
    stats.filesScanned = 1;
    await indexFile(db, opts.onlyTranscript, projectForTranscriptDir(dirPath, path.basename(dirPath)), stats);
    return stats;
  }

  const root = config.transcriptsRoot;
  if (!fs.existsSync(root)) return stats;
  for (const dirName of fs.readdirSync(root)) {
    const dirPath = path.join(root, dirName);
    if (!fs.statSync(dirPath).isDirectory() || isExcluded(dirName)) continue;
    const project = projectForTranscriptDir(dirPath, dirName);
    // Top-level session transcripts plus every subagent and workflow-agent
    // transcript (transcriptLayout). The parent transcript does not contain a
    // subagent's work, so skipping these left it unsearchable.
    const files = listProjectTranscripts(dirPath);
    for (const file of files) {
      stats.filesScanned++;
      try {
        await indexFile(db, file, project, stats);
      } catch (err) {
        // One corrupt transcript must not kill the sweep; record and move on.
        console.error(`memd index: failed on ${path.relative(root, file)}: ${(err as Error).message}`);
      }
    }
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('last_index_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(nowIso());
  return stats;
}
