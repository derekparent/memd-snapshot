import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { acquireEmbedLock } from "./embeddings.js";

/**
 * Weekly store snapshot, run from the nightly launchd job (`memd backup
 * --weekly`). Until this existed there was no regular backup at all.
 *
 *  - VACUUM INTO, never cp: the store is WAL, and a plain copy silently loses
 *    whatever is still in the -wal file (a plain-copy backup has come out
 *    hundreds of rows short this way in practice). VACUUM INTO reads a
 *    consistent snapshot that includes WAL content.
 *  - Never alongside the embedder: it holds `<db>.embed.lock` for the whole
 *    snapshot, waiting for a running embedder (a SessionStart hook's, say)
 *    rather than racing it.
 *  - Written to a temp name, quick_check'ed, then renamed: a half-written or
 *    corrupt file never carries a backup's name.
 *  - Every failure throws; the CLI prints BACKUP FAILED and exits 1, so the
 *    nightly log shows it rather than a missing line nobody notices.
 *
 * RETENTION: keep the newest 4 (about a month). Snapshot size adds up on a
 * disk with limited headroom, so the count is capped — enough history to
 * roll back past a corruption noticed weeks late, without eating the disk.
 * Only files named exactly `YYYY-MM-DD.db` are counted or pruned, so the
 * pre-write backups the migrations take in the same directory
 * are never touched.
 *
 * FUTURE-DATED NAMES (one run under a wrong clock, or a stray file) are
 * excluded from both cadence and retention, never pruned, and warned about on
 * every run. Counted, a "2099-01-01.db" turned every later run into a
 * healthy-looking "not due" skip, forever — a missing backup nobody notices,
 * which is the failure this job exists to prevent.
 */

export const BACKUP_KEEP = 4;
export const BACKUP_EVERY_DAYS = 7;
const WEEKLY_NAME = /^(\d{4}-\d{2}-\d{2})\.db$/;

export interface BackupOptions {
  dbPath?: string;
  /** Destination directory; default `<db dir>/backups`. */
  dir?: string;
  keep?: number;
  /** Take one even if the newest is younger than a week. */
  force?: boolean;
  /** How long to wait for a running embedder, ms (default 15 min). */
  lockWaitMs?: number;
  now?: Date;
}

export type BackupResult = { warnings: string[] } & (
  | { taken: false; reason: string }
  | { taken: true; path: string; bytes: number; pruned: string[] }
);

/** Local calendar date: the job runs at 04:30 local, so name by local day. */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

/** Weekly snapshot names in `dir`, oldest first. */
export function weeklyBackups(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => WEEKLY_NAME.test(f)).sort();
}

async function waitForEmbedLock(dbPath: string, waitMs: number): Promise<() => void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const release = acquireEmbedLock(dbPath);
    if (release) return release;
    if (Date.now() >= deadline) {
      throw new Error(`an embedder still holds ${dbPath}.embed.lock after ${Math.round(waitMs / 1000)}s — no snapshot taken`);
    }
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, deadline - Date.now()))));
  }
}

export async function weeklyBackup(opts: BackupOptions = {}): Promise<BackupResult> {
  const dbPath = opts.dbPath ?? config.dbPath;
  const dir = opts.dir ?? path.join(path.dirname(dbPath), "backups");
  const keep = opts.keep ?? BACKUP_KEEP;
  const today = localDate(opts.now ?? new Date());

  // Names compare as dates: YYYY-MM-DD sorts lexically.
  const current = () => weeklyBackups(dir).filter((f) => f.slice(0, 10) <= today);
  const warnings = weeklyBackups(dir)
    .filter((f) => f.slice(0, 10) > today)
    .map((f) => `WARNING: ${path.join(dir, f)} is dated in the future (today is ${today}) — ignored for cadence and retention; check the clock, then remove it by hand`);
  const existing = current();
  const newest = existing[existing.length - 1];
  if (!opts.force && newest) {
    const age = daysBetween(newest.slice(0, 10), today);
    if (age < BACKUP_EVERY_DAYS) return { taken: false, reason: `not due — newest weekly snapshot ${newest} is ${age}d old`, warnings };
  }
  if (!fs.existsSync(dbPath)) throw new Error(`no store at ${dbPath}`);

  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${today}.db`);
  const tmp = `${dest}.partial`;
  fs.rmSync(tmp, { force: true });

  const waitS = parseInt(process.env.MEMD_BACKUP_LOCK_WAIT_S ?? "", 10);
  const release = await waitForEmbedLock(dbPath, opts.lockWaitMs ?? (Number.isFinite(waitS) ? waitS * 1000 : 15 * 60_000));
  try {
    const src = new Database(dbPath, { readonly: true });
    try {
      src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
    const copy = new Database(tmp, { readonly: true });
    let check: string;
    try {
      check = (copy.pragma("quick_check", { simple: true }) as string) ?? "no result";
    } finally {
      copy.close();
    }
    if (check !== "ok") throw new Error(`snapshot failed quick_check: ${check}`);
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    release();
  }

  const all = current();
  const pruned = all.slice(0, Math.max(0, all.length - keep));
  for (const f of pruned) fs.rmSync(path.join(dir, f));
  return { taken: true, path: dest, bytes: fs.statSync(dest).size, pruned, warnings };
}
