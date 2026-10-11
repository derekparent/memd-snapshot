import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { DB } from "./db.js";
import { canonicalProject, projectUnderRoot } from "./indexer.js";
import { splitChunks } from "./chunker.js";
import { redact } from "./redact.js";

/**
 * The docs layer: curated files —
 * per-project memory dirs, learnings, DECISIONS.md, CONTEXT.md, field notes —
 * indexed as CURRENT FILE STATE: each full `memd index` pass (the SessionStart
 * background index, the nightly job, or by hand) re-reads every file whose
 * mtime changed and replaces its rows. Unlike episodes (immutable history), a
 * doc hit is the file's content as of the last index pass, not a live read:
 * the answer to "what is true now" that transcript fossils can't give, as
 * fresh as that pass.
 */

export interface DocStats {
  filesScanned: number;
  filesIndexed: number;
  chunksAdded: number;
  /** Paths evicted because they are no longer part of the corpus. */
  filesPruned: number;
}

/** Narrow shape of the prepared DELETE handed to pruneDocs. */
type Stmt = { run: (...args: unknown[]) => unknown };

/** Resolve one root pattern supporting a single `*` path segment. */
function expandRoot(pattern: string): string[] {
  const expanded = pattern.replace(/^~/, os.homedir());
  const starIdx = expanded.indexOf("*");
  if (starIdx === -1) return fs.existsSync(expanded) ? [expanded] : [];
  const before = path.dirname(expanded.slice(0, starIdx + 1)); // dir containing the * segment
  const restPattern = expanded.slice(before.length + 1); // "*..." possibly with suffix path
  const [starSeg, ...tail] = restPattern.split(path.sep);
  if (!fs.existsSync(before)) return [];
  const re = new RegExp("^" + starSeg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  const out: string[] = [];
  for (const entry of fs.readdirSync(before)) {
    if (!re.test(entry)) continue;
    const candidate = path.join(before, entry, ...tail);
    if (fs.existsSync(candidate)) out.push(candidate);
  }
  return out;
}

function collectFiles(root: string, out: string[], depth = 0): void {
  if (depth > 4) return;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (/\.(md|txt)$/i.test(root)) out.push(root);
    return;
  }
  if (!stat.isDirectory()) return;
  // Tombstone convention: a `.memd-ignore` file marks a retired store — the whole
  // directory drops out of the docs corpus (curation stays with the owner).
  if (fs.existsSync(path.join(root, ".memd-ignore"))) return;
  for (const entry of fs.readdirSync(root)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    try {
      collectFiles(path.join(root, entry), out, depth + 1);
    } catch {
      /* unreadable entry — skip */
    }
  }
}

/**
 * Canonical on-disk identity. `~/.claude/skills` is a SYMLINK to
 * `~/Projects/skills` and both are configured roots, so every skills file was
 * indexed twice under two different paths — 1,513 duplicate chunks in the live
 * store, a quarter of the docs corpus. Resolving to realpath collapses them and
 * generalizes to any future symlinked root, which special-casing would not.
 */
function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p; // missing or unreadable — caller still has the literal path
  }
}

export function projectForDoc(filePath: string): string {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const projMatch = filePath.match(new RegExp(`^${esc(config.projectsRoot)}/([^/]+)/`));
  if (projMatch) return canonicalProject(projMatch[1]);
  const memMatch = filePath.match(new RegExp(`^${esc(os.homedir())}/\\.claude/projects/([^/]+)/`));
  if (memMatch) return canonicalProject(projectUnderRoot(memMatch[1]) ?? memMatch[1].replace(/^-/, ""));
  return "docs";
}

export function indexDocs(db: DB): DocStats {
  const stats: DocStats = { filesScanned: 0, filesIndexed: 0, chunksAdded: 0, filesPruned: 0 };
  const fileList: string[] = [];
  // A root is prunable only if it collected cleanly AND yielded at least one
  // file. collectFiles swallows per-entry errors, so a root that suddenly
  // returns nothing is far more likely to be transiently unreadable than
  // genuinely empty — and treating it as empty would mass-delete its rows.
  const prunableRoots: string[] = [];
  // Every place a CONFIGURED root reaches, readable or not: a row outside all
  // of them belongs to a root that left the config and is evicted.
  const configuredRoots: string[] = [];
  for (const root of config.docRoots) {
    for (const resolved of expandRoot(root)) {
      configuredRoots.push(realpath(resolved), resolved);
      const before = fileList.length;
      try {
        collectFiles(resolved, fileList);
      } catch {
        continue; // root unreadable — never prune from it this pass
      }
      if (fileList.length > before) prunableRoots.push(realpath(resolved));
    }
  }

  const getMtime = db.prepare("SELECT mtime FROM docs WHERE path = ? LIMIT 1");
  const del = db.prepare("DELETE FROM docs WHERE path = ?");
  const ins = db.prepare("INSERT INTO docs (path, mtime, chunk_no, project, content) VALUES (?, ?, ?, ?, ?)");
  const seen = new Set<string>();

  for (const rawFile of fileList) {
    // Store under the canonical path so a symlinked root cannot double-index.
    const file = realpath(rawFile);
    if (seen.has(file)) continue;
    seen.add(file);
    stats.filesScanned++;
    try {
      const mtime = Math.floor(fs.statSync(file).mtimeMs);
      const row = getMtime.get(file) as { mtime: number } | undefined;
      if (row && row.mtime === mtime) continue;
      const content = fs.readFileSync(file, "utf8");
      if (content.length > 512 * 1024) continue; // not a curated doc
      // Redact the whole file, then split: per-chunk redaction misses a
      // secret that a chunk boundary cuts in two.
      const chunks = splitChunks(redact(content));
      const write = db.transaction(() => {
        del.run(file);
        chunks.forEach((c, i) => {
          ins.run(file, mtime, i, projectForDoc(file), c);
          stats.chunksAdded++;
        });
      });
      write();
      stats.filesIndexed++;
    } catch (err) {
      console.error(`memd docs: failed on ${file}: ${(err as Error).message}`);
    }
  }

  stats.filesPruned = pruneDocs(db, del, seen, prunableRoots, configuredRoots);
  return stats;
}

/**
 * Evict rows whose source file is no longer part of the corpus.
 *
 * The old pass only deleted rows for files that vanished from DISK, so a file
 * that dropped out of collectFiles while still existing — retired behind a
 * `.memd-ignore`, or under a root removed from config — kept its rows forever.
 * That is why the tombstone convention stopped future ingest but evicted
 * nothing, and why a batch of stale attic rows had to be deleted by hand.
 *
 * Pruning is scoped to roots that collected cleanly this pass: a row is removed
 * only if it lives under such a root and was not collected. A row under no
 * configured root at all (its root was removed from config) is evicted. Rows
 * under a configured but unreadable root are kept; any other row is evicted
 * only when its file is truly gone (ENOENT), never on a permission error.
 */
function pruneDocs(db: DB, del: Stmt, collected: Set<string>, prunableRoots: string[], configuredRoots: string[]): number {
  const under = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(r + path.sep));
  // Only a file that is truly absent counts as gone. existsSync() also says
  // false for EACCES, which evicted every row under a root that was merely
  // unreadable this pass.
  const gone = (p: string) => {
    try {
      fs.statSync(p);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT";
    }
  };
  const known = db.prepare("SELECT DISTINCT path FROM docs").all() as { path: string }[];
  let pruned = 0;
  for (const k of known) {
    if (collected.has(k.path)) continue; // the canonical row for a live file
    const canonical = realpath(k.path);
    // A row whose CANONICAL twin was collected is a stale duplicate written
    // before paths were canonicalized — e.g. every ~/.claude/skills/* row,
    // which existsSync() reports as alive because the symlink resolves.
    // Dropping it loses no content: the canonical row holds the same bytes.
    const duplicateOfCollected = canonical !== k.path && collected.has(canonical);
    const underPrunableRoot = under(canonical, prunableRoots);
    // Its root is no longer configured at all (neither the stored path nor its
    // canonical form lies under anything a configured root reaches).
    const rootRemoved = !under(canonical, configuredRoots) && !under(k.path, configuredRoots);
    if (duplicateOfCollected || underPrunableRoot || rootRemoved || gone(k.path)) {
      del.run(k.path);
      pruned++;
    }
  }
  return pruned;
}
