import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, DB } from "../src/db.js";
import { saveFact } from "../src/facts.js";
import { weeklyBackup, weeklyBackups } from "../src/backup.js";

// Every test runs against a temp store — never the live one.
let root: string;
let dbPath: string;
let dir: string;
let db: DB;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-bak-")));
  dbPath = path.join(root, "memd.db");
  dir = path.join(root, "backups");
  db = openDb(dbPath);
  saveFact(db, { content: "fact written before the snapshot" });
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const at = (d: string) => new Date(d + "T04:30:00");
const count = (p: string) => {
  const c = new Database(p, { readonly: true });
  try {
    return (c.prepare("SELECT COUNT(*) n FROM facts").get() as any).n as number;
  } finally {
    c.close();
  }
};

describe("VACUUM INTO snapshot", () => {
  it("captures writes still sitting in the WAL, which a plain file copy loses", async () => {
    // Schema + the first fact go to the main file; then a second connection
    // with auto-checkpoint off keeps its writes in -wal.
    db.pragma("wal_checkpoint(TRUNCATE)");
    const w = new Database(dbPath);
    w.pragma("wal_autocheckpoint = 0");
    const ins = w.prepare("INSERT INTO facts (content, kind, importance, valid_from, created_at) VALUES (?, 'fact', 5, 'now', 'now')");
    for (let i = 0; i < 25; i++) ins.run(`pending wal write ${i}`);
    expect(fs.statSync(dbPath + "-wal").size).toBeGreaterThan(0);
    // The control: `cp` of the main file alone lacks them, which is the failure this guards against.
    const cp = path.join(root, "cp.db");
    fs.copyFileSync(dbPath, cp);
    expect(count(cp)).toBe(1);

    const r = await weeklyBackup({ dbPath, dir, now: at("2026-09-21") });
    w.close();
    expect(r.taken).toBe(true);
    if (!r.taken) return;
    expect(path.basename(r.path)).toBe("2026-09-21.db");
    expect(count(r.path)).toBe(26);
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".partial"))).toBe(false);
  });
});

describe("weekly cadence and retention", () => {
  it("skips when the newest snapshot is under a week old, takes it at seven days", async () => {
    await weeklyBackup({ dbPath, dir, now: at("2026-09-21") });
    const r6 = await weeklyBackup({ dbPath, dir, now: at("2026-09-27") });
    expect(r6.taken).toBe(false);
    if (!r6.taken) expect(r6.reason).toMatch(/not due.*6d old/);
    expect((await weeklyBackup({ dbPath, dir, now: at("2026-09-28") })).taken).toBe(true);
  });

  it("force takes one regardless", async () => {
    await weeklyBackup({ dbPath, dir, now: at("2026-09-21") });
    expect((await weeklyBackup({ dbPath, dir, force: true, now: at("2026-09-22") })).taken).toBe(true);
  });

  it("keeps the newest N weekly snapshots and never touches other backups", async () => {
    fs.mkdirSync(dir, { recursive: true });
    const foreign = ["memd-preattic-20260727.db", "memd-pre-e1-sweep.db", "memd-plan-e2-x.json"];
    for (const f of foreign) fs.writeFileSync(path.join(dir, f), "x");
    const days = ["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"];
    let last;
    for (const d of days) last = await weeklyBackup({ dbPath, dir, keep: 4, now: at(d) });
    expect(weeklyBackups(dir)).toEqual(days.slice(2).map((d) => `${d}.db`));
    if (last?.taken) expect(last.pruned).toEqual(["2026-08-24.db"]);
    for (const f of foreign) expect(fs.existsSync(path.join(dir, f))).toBe(true);
  });
});

describe("future-dated names (wrong clock, or a stray file)", () => {
  // A "2099-01-01.db" made every run a healthy-looking "not due … -26400d
  // old" skip, forever, and held a retention slot.
  const future = () => path.join(dir, "2099-01-01.db");
  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(future(), "x");
  });

  it("does not suppress a due snapshot, and says so", async () => {
    const r = await weeklyBackup({ dbPath, dir, now: at("2026-09-21") });
    expect(r.taken).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/WARNING.*2099-01-01\.db.*future/);
  });

  it("is never pruned and never displaces a real snapshot", async () => {
    const days = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"];
    for (const d of days) await weeklyBackup({ dbPath, dir, keep: 4, now: at(d) });
    expect(fs.existsSync(future())).toBe(true);
    expect(weeklyBackups(dir).filter((f) => !f.startsWith("2099"))).toEqual(days.slice(1).map((d) => `${d}.db`));
  });

  it("warns on a not-due run too", async () => {
    await weeklyBackup({ dbPath, dir, now: at("2026-09-21") });
    const r = await weeklyBackup({ dbPath, dir, now: at("2026-09-22") });
    expect(r.taken).toBe(false);
    expect(r.warnings.join("\n")).toMatch(/2099-01-01\.db/);
  });
});

describe("never alongside the embedder", () => {
  const lock = () => dbPath + ".embed.lock";

  it("fails loudly, leaves no snapshot, when a live embedder keeps the lock", async () => {
    fs.writeFileSync(lock(), String(process.pid)); // a live pid: this test process
    await expect(weeklyBackup({ dbPath, dir, lockWaitMs: 200, now: at("2026-09-21") })).rejects.toThrow(/embed\.lock/);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    expect(fs.readFileSync(lock(), "utf8")).toBe(String(process.pid)); // not stolen
  });

  it("waits for the embedder to finish, then snapshots", async () => {
    fs.writeFileSync(lock(), String(process.pid));
    setTimeout(() => fs.rmSync(lock()), 150);
    const r = await weeklyBackup({ dbPath, dir, lockWaitMs: 5000, now: at("2026-09-21") });
    expect(r.taken).toBe(true);
  });

  it("holds the lock while copying and releases it after", async () => {
    await weeklyBackup({ dbPath, dir, now: at("2026-09-21") });
    expect(fs.existsSync(lock())).toBe(false);
  });

  it("cleans up and releases the lock when the snapshot itself fails", async () => {
    const bad = path.join(root, "not-a-db.db");
    fs.writeFileSync(bad, "this is not sqlite ".repeat(200));
    await expect(weeklyBackup({ dbPath: bad, dir, now: at("2026-09-21") })).rejects.toThrow();
    expect(weeklyBackups(dir)).toEqual([]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".partial"))).toEqual([]);
    expect(fs.existsSync(bad + ".embed.lock")).toBe(false);
  });
});

describe("a failure after the copy is written", () => {
  it("removes the .partial and re-throws (rename blocked by a directory of that name)", async () => {
    fs.mkdirSync(path.join(dir, "2026-09-21.db"), { recursive: true });
    await expect(weeklyBackup({ dbPath, dir, force: true, now: at("2026-09-21") })).rejects.toThrow();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".partial"))).toEqual([]);
    expect(fs.existsSync(dbPath + ".embed.lock")).toBe(false);
  });
});

describe("crash mid-copy", () => {
  it("leaves nothing carrying a backup's name (a torn file would count as this week's)", async () => {
    // ~200 MB so the copy takes long enough to kill mid-flight.
    db.exec("CREATE TABLE pad(b); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 200) INSERT INTO pad SELECT randomblob(1000000) FROM n;");
    db.pragma("wal_checkpoint(TRUNCATE)");
    const child = spawn(path.join(__dirname, "../node_modules/.bin/tsx"), [path.join(__dirname, "../src/cli.ts"), "backup"], {
      env: { ...process.env, MEMD_DB_PATH: dbPath },
      stdio: "ignore",
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(fs.existsSync(dir) && fs.readdirSync(dir).length)) await new Promise((r) => setTimeout(r, 2));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    const left = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(left.length).toBeGreaterThan(0); // the kill really landed mid-copy
    expect(weeklyBackups(dir)).toEqual([]);
    // ...and the next run is not fooled: it takes a snapshot.
    // The SIGKILLed holder's lock is stale; acquireEmbedLock reclaims a dead pid's.
    expect((await weeklyBackup({ dbPath, dir, now: at("2026-09-21") })).taken).toBe(true);
  }, 30_000);
});

describe("nightly job wiring", () => {
  it("the CLI exits 1 with BACKUP FAILED, the line the nightly log must show", () => {
    fs.writeFileSync(dbPath + ".embed.lock", String(process.pid));
    const res = spawnSync(path.join(__dirname, "../node_modules/.bin/tsx"), [path.join(__dirname, "../src/cli.ts"), "backup"], {
      env: { ...process.env, MEMD_DB_PATH: dbPath, MEMD_BACKUP_LOCK_WAIT_S: "0" },
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/BACKUP FAILED: .*embed\.lock/);
  });

  it("the CLI puts the future-dated WARNING in the log", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "2099-01-01.db"), "x");
    const res = spawnSync(path.join(__dirname, "../node_modules/.bin/tsx"), [path.join(__dirname, "../src/cli.ts"), "backup", "--weekly"], {
      env: { ...process.env, MEMD_DB_PATH: dbPath },
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/backup: WARNING: .*2099-01-01\.db/);
    expect(res.stdout).toMatch(/backup: .*\d{4}-\d{2}-\d{2}\.db .*quick_check ok/);
  });

  // The job file is named after its owner's launchd label; found by suffix so
  // the test names nobody, and skipped in a tree that ships no job file.
  const scripts = path.join(__dirname, "../scripts");
  const jobFile = fs.existsSync(scripts) ? fs.readdirSync(scripts).find((f) => f.endsWith(".memd-index.plist")) : undefined;
  it.skipIf(!jobFile || process.platform !== "darwin")("the launchd job runs the weekly backup even when index/embed fail, and is valid plist", () => {
    const plist = path.join(scripts, jobFile!);
    const cmd = execFileSync("plutil", ["-extract", "ProgramArguments.2", "raw", plist], { encoding: "utf8" }).trim();
    expect(cmd).toMatch(/embed --limit \d+; \S+ \S+cli\.js backup --weekly$/);
  });
});
