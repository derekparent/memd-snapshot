// SYNTHETIC FIXTURES: every key, token, password and card number in this file is
// fabricated to exercise the redaction patterns. None is a real credential.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, DB } from "../src/db.js";
import { backfillProjects, repoNamesInText, sweepRedaction } from "../src/migrate-store.js";

let db: DB;
let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-mig-")));
  db = openDb(path.join(root, "t.db"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function episode(content: string, opts: { session?: string; project?: string; embedded?: number; kind?: string } = {}): number {
  const id = Math.floor(Math.random() * 1e9);
  db.prepare(
    `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no, embedded)
     VALUES (?, ?, '2026-07-20T00:00:00Z', 'user', ?, ?, ?, 0, ?)`
  ).run(opts.session ?? `s${id}`, opts.project ?? "memd", opts.kind ?? "text", content, `u${id}`, opts.embedded ?? 0);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as any).id;
}

const contentOf = (id: number) => (db.prepare("SELECT content FROM episodes WHERE id = ?").get(id) as any).content;

describe("E1 sweepRedaction — dry run is the default", () => {
  it("reports what WOULD change and writes nothing", () => {
    const id = episode("password: Robot1234");
    const stats = sweepRedaction(db);
    expect(stats.dryRun).toBe(true);
    expect(stats.episodesChanged).toBe(1);
    expect(stats.backupPath).toBeUndefined();
    expect(contentOf(id)).toBe("password: Robot1234"); // untouched
  });

  it("counts only rows the CURRENT rules would actually change", () => {
    episode("password: Robot1234");
    episode("nothing sensitive here at all");
    episode("the password field was renamed"); // prose — must not count
    const stats = sweepRedaction(db);
    expect(stats.episodesScanned).toBe(3);
    expect(stats.episodesChanged).toBe(1);
  });
});

describe("E1 sweepRedaction — apply", () => {
  it("rewrites the stored content and takes a backup first", () => {
    const id = episode("password: Robot1234");
    const stats = sweepRedaction(db, { apply: true, backupDir: path.join(root, "backups") });
    expect(stats.dryRun).toBe(false);
    expect(stats.episodesChanged).toBe(1);
    expect(contentOf(id)).toContain("[REDACTED:SECRET_VALUE]");
    expect(contentOf(id)).not.toContain("Robot1234");
    expect(fs.existsSync(stats.backupPath!)).toBe(true);
    // The backup is THIS store's pre-write image — not the real store's. It
    // used to be config.dbPath: every test run copied the real, configured store.
    const bak = new (require("better-sqlite3"))(stats.backupPath!, { readonly: true });
    expect((bak.prepare("SELECT content FROM episodes WHERE id = ?").get(id) as any).content).toBe("password: Robot1234");
    expect((bak.prepare("SELECT COUNT(*) n FROM episodes").get() as any).n).toBe(1);
    bak.close();
  });

  it("invalidates the embedding of a changed row — the vector describes text that no longer exists", () => {
    const id = episode("password: Robot1234", { embedded: 1 });
    const stats = sweepRedaction(db, { apply: true, backupDir: path.join(root, "backups") });
    expect(stats.embeddingsInvalidated).toBe(1);
    expect((db.prepare("SELECT embedded FROM episodes WHERE id = ?").get(id) as any).embedded).toBe(0);
  });

  it("leaves unchanged rows and their embeddings alone", () => {
    const id = episode("nothing sensitive here at all", { embedded: 1 });
    const stats = sweepRedaction(db, { apply: true, backupDir: path.join(root, "backups") });
    expect(stats.episodesChanged).toBe(0);
    expect(stats.embeddingsInvalidated).toBe(0);
    expect((db.prepare("SELECT embedded FROM episodes WHERE id = ?").get(id) as any).embedded).toBe(1);
  });

  it("takes no backup when there is nothing to change", () => {
    episode("nothing sensitive here at all");
    const stats = sweepRedaction(db, { apply: true, backupDir: path.join(root, "backups") });
    expect(stats.backupPath).toBeUndefined();
  });

  it("writes a change-record sidecar naming the exact rows, ids only", () => {
    const id = episode("password: Robot1234");
    const stats = sweepRedaction(db, { apply: true, backupDir: path.join(root, "backups") });
    const rec = JSON.parse(fs.readFileSync(stats.sidecarPath!, "utf8"));
    expect(rec.changedEpisodeIds).toEqual([id]);
    expect(rec.knownGaps.length).toBeGreaterThan(0);
    // The sidecar must never carry the content it is redacting.
    expect(JSON.stringify(rec)).not.toContain("Robot1234");
  });

  it("is idempotent — a second apply finds nothing left to do", () => {
    episode("password: Robot1234");
    sweepRedaction(db, { apply: true, backupDir: path.join(root, "backups") });
    const second = sweepRedaction(db, { apply: true, backupDir: path.join(root, "backups") });
    expect(second.episodesChanged).toBe(0);
  });

  it("honours --limit for a scoped trial", () => {
    episode("password: one");
    episode("password: two");
    expect(sweepRedaction(db, { limit: 1 }).episodesScanned).toBe(1);
  });
});

describe("E2 backfillProjects — evidence of where the session worked", () => {
  let projects: string;
  const git = (dir: string, ...a: string[]) =>
    require("node:child_process").execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  /** A real git checkout under the fixture's projects root. */
  function repo(dirName: string, originName = dirName) {
    const dir = path.join(projects, dirName);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "remote", "add", "origin", `git@github.com:example-user/${originName}.git`);
  }
  beforeEach(() => {
    projects = path.join(root, "Projects");
    for (const r of ["memd", "relay", "skills", "atlas", "FieldApp-ios"]) repo(r);
    fs.mkdirSync(path.join(projects, "reports"), { recursive: true }); // NOT a repo
  });

  function session(id: string, project: string, opts: { cwd?: string; transcript?: string } = {}) {
    db.prepare(`INSERT INTO sessions (session_id, project, cwd, transcript_path, indexed_bytes) VALUES (?, ?, ?, ?, 0)`).run(
      id, project, opts.cwd ?? null, opts.transcript ?? null
    );
  }
  /** n tool_use episodes touching `repoDir` (a path under the projects root). */
  function acts(sessionId: string, project: string, repoDir: string, n: number, sub = "src/x.ts") {
    for (let i = 0; i < n; i++) episode(`[tool:Read] {"file_path":"${projects}/${repoDir}/${sub}"}`, { session: sessionId, project, kind: "tool_use" });
  }
  const run = (apply = false) => backfillProjects(db, { projectsRoot: projects, apply, backupDir: path.join(root, "backups") });
  const verdict = async (id: string) => (await run()).decisions!.find((d) => d.sessionId === id)!;

  it("retags a vague-tagged session to where its ACTIONS happened, and writes nothing on a dry run", async () => {
    session("s1", "Projects", { cwd: path.join(projects, "skills") }); // v1 read this last cwd
    acts("s1", "Projects", "memd", 8);
    acts("s1", "Projects", "skills/handoff", 3, "pending/x.md"); // wrap-up ledger: no vote
    const stats = await run();
    expect(stats.mapping).toEqual({ "Projects -> memd": 11 });
    const d = stats.decisions!.find((x) => x.sessionId === "s1")!;
    expect(d).toMatchObject({ verdict: "retag", to: "memd", share: 1 });
    expect(d.evidence).toMatchObject({ source: "actions", total: 8 });
    expect((db.prepare("SELECT project FROM sessions WHERE session_id = 's1'").get() as any).project).toBe("Projects");
  });

  it("counts actions, not mentions: tool_result and prose naming other repos cast no vote", async () => {
    session("s2", "Projects");
    acts("s2", "Projects", "relay", 5);
    for (let i = 0; i < 20; i++) episode(`${projects}/skills/README.md mentions ${projects}/atlas`, { session: "s2", project: "Projects", kind: "tool_result" });
    expect(await verdict("s2")).toMatchObject({ verdict: "retag", to: "relay" });
  });

  it("a directory that is not a git repo can never win (~/Projects/reports)", async () => {
    session("s3", "Projects");
    acts("s3", "Projects", "reports", 10, "deep-research/x.html");
    expect(await verdict("s3")).toMatchObject({ verdict: "unresolved", to: "reports" });
  });

  it("unresolvable paths still count: a vanished checkout's session is not handed to the repo it merely read", async () => {
    // task-tracker no longer exists under the projects root.
    session("s3b", "task-tracker");
    acts("s3b", "task-tracker", "task-tracker", 40, "app/dashboard_api.py");
    acts("s3b", "task-tracker", "skills", 6, "troubleshoot/SKILL.md");
    expect((await verdict("s3b")).verdict).toBe("keep");
    session("s3c", "Projects");
    acts("s3c", "Projects", "task-tracker", 40);
    acts("s3c", "Projects", "skills", 6, "troubleshoot/SKILL.md");
    expect((await verdict("s3c")).verdict).toBe("unresolved");
    session("s3d", "Projects");
    acts("s3d", "Projects", "task-tracker", 5);
    acts("s3d", "Projects", "skills", 6, "troubleshoot/SKILL.md");
    expect((await verdict("s3d")).verdict).toBe("multi-repo"); // 6 of 11 < 60%
  });

  it("leaves and lists a multi-repo session (no clear majority)", async () => {
    session("s4", "Projects");
    acts("s4", "Projects", "relay", 5);
    acts("s4", "Projects", "memd", 5);
    const d = await verdict("s4");
    expect(d.verdict).toBe("multi-repo");
    expect(d.share).toBe(0.5);
  });

  it("the majority threshold is 60%", async () => {
    session("s5", "Projects");
    acts("s5", "Projects", "relay", 6);
    acts("s5", "Projects", "memd", 4);
    expect((await verdict("s5")).verdict).toBe("retag");
    session("s5b", "Projects");
    acts("s5b", "Projects", "relay", 5);
    acts("s5b", "Projects", "memd", 4);
    expect((await verdict("s5b")).verdict).toBe("multi-repo");
  });

  it("thin evidence LEAVES the session and lists it: fewer than 5 votes", async () => {
    session("s6", "Projects");
    acts("s6", "Projects", "memd", 4);
    expect((await verdict("s6")).verdict).toBe("thin-evidence");
    session("s6z", "Projects");
    episode("just talk", { session: "s6z", project: "Projects" });
    expect((await verdict("s6z")).verdict).toBe("no-evidence");
  });

  it("a large session needs 10 votes", async () => {
    session("s6L", "Projects");
    for (let i = 0; i < 245; i++) episode(`conversation ${i}`, { session: "s6L", project: "Projects" });
    acts("s6L", "Projects", "memd", 9);
    expect((await verdict("s6L")).verdict).toBe("thin-evidence"); // 254 episodes, 9 votes
    acts("s6L", "Projects", "memd", 1);
    expect((await verdict("s6L")).verdict).toBe("retag"); // 10 votes
  });

  it("never moves a session OUT of a real repo its launch dir named without overwhelming evidence", async () => {
    session("s7", "FieldApp-ios", { cwd: path.join(projects, "skills") });
    acts("s7", "FieldApp-ios", "skills", 8);
    acts("s7", "FieldApp-ios", "FieldApp-ios", 2);
    expect((await verdict("s7")).verdict).toBe("protected");
    // ACTIONS never move it, however overwhelming: a relay-launched audit of
    // the skills repo is still a relay session.
    session("s7b", "FieldApp-ios");
    acts("s7b", "FieldApp-ios", "memd", 19);
    acts("s7b", "FieldApp-ios", "FieldApp-ios", 1);
    expect((await verdict("s7b")).verdict).toBe("protected");
  });

  it("only overwhelming TRANSCRIPT evidence moves a session out of a real repo tag", async () => {
    const line = (cwd: string) => JSON.stringify({ type: "user", cwd, message: { role: "user", content: "x" }, uuid: Math.random().toString() });
    const t1 = path.join(root, "t7c.jsonl");
    fs.writeFileSync(t1, [...Array(19).fill(line(path.join(projects, "memd"))), line(path.join(projects, "FieldApp-ios"))].join("\n"));
    session("s7c", "FieldApp-ios", { transcript: t1 });
    expect(await verdict("s7c")).toMatchObject({ verdict: "retag", to: "memd" }); // 95% of 20 lines
    const t2 = path.join(root, "t7d.jsonl");
    fs.writeFileSync(t2, [...Array(8).fill(line(path.join(projects, "memd"))), ...Array(2).fill(line(path.join(projects, "FieldApp-ios")))].join("\n"));
    session("s7d", "FieldApp-ios", { transcript: t2 });
    expect((await verdict("s7d")).verdict).toBe("protected"); // 80%: not overwhelming
  });

  it("relay seat worktree paths count for their repo", async () => {
    session("s8", "Projects");
    for (let i = 0; i < 5; i++) episode(`[tool:Bash] {"command":"cd /Users/alice/.worktrees/atlas-executor && npm test"}`, { session: "s8", project: "Projects", kind: "tool_use" });
    expect(await verdict("s8")).toMatchObject({ verdict: "retag", to: "atlas" });
  });

  it("prefers the transcript's cwd majority when the transcript still exists", async () => {
    const t = path.join(root, "t8.jsonl");
    const line = (cwd: string) => JSON.stringify({ type: "user", cwd, message: { role: "user", content: "x" }, uuid: Math.random().toString() });
    fs.writeFileSync(t, [...Array(7).fill(line(path.join(projects, "memd"))), ...Array(3).fill(line(path.join(projects, "skills")))].join("\n"));
    session("s9", "Projects", { transcript: t });
    acts("s9", "Projects", "relay", 20); // would say relay if the transcript were ignored
    expect(await verdict("s9")).toMatchObject({ verdict: "retag", to: "memd" });
    expect((await verdict("s9")).evidence.source).toBe("transcript");
  });

  it("a transcript parked in a skills ledger dir still votes skills", async () => {
    const t = path.join(root, "t370.jsonl");
    const line = (cwd: string) => JSON.stringify({ type: "user", cwd, message: { role: "user", content: "x" }, uuid: Math.random().toString() });
    fs.writeFileSync(t, [...Array(8).fill(line(path.join(projects, "skills", "logs", "work"))), ...Array(2).fill(line(projects))].join("\n"));
    session("s370", "Projects", { transcript: t });
    expect(await verdict("s370")).toMatchObject({ verdict: "retag", to: "skills" });
  });

  it("a correctly-tagged session reads 'keep' even on thin evidence (no change either way)", async () => {
    session("s10t", "memd");
    acts("s10t", "memd", "memd", 2);
    expect((await verdict("s10t")).verdict).toBe("keep");
  });

  it("keeps a session whose tag already matches its evidence", async () => {
    session("s10", "memd");
    acts("s10", "memd", "memd", 5);
    expect((await verdict("s10")).verdict).toBe("keep");
  });

  it("apply retags episodes AND the session row, backs up THIS store, and records evidence per change", async () => {
    session("s11", "Projects");
    acts("s11", "Projects", "atlas", 5);
    const stats = await run(true);
    expect((db.prepare("SELECT DISTINCT project FROM episodes WHERE session_id = 's11'").all() as any[]).map((r) => r.project)).toEqual(["atlas"]);
    expect((db.prepare("SELECT project FROM sessions WHERE session_id = 's11'").get() as any).project).toBe("atlas");
    const rec = JSON.parse(fs.readFileSync(stats.sidecarPath!, "utf8"));
    expect(rec.changes).toEqual([{ sessionId: "s11", from: "Projects", to: "atlas" }]);
    expect(rec.evidence[0]).toMatchObject({ sessionId: "s11", source: "actions", total: 5, share: 1 });
    const bak = new (require("better-sqlite3"))(stats.backupPath!, { readonly: true });
    expect((bak.prepare("SELECT COUNT(*) n FROM sessions").get() as any).n).toBe(1);
    bak.close();
  });

  it("is idempotent — a second apply finds nothing left to do", async () => {
    session("s12", "Projects");
    acts("s12", "Projects", "memd", 5);
    await run(true);
    expect((await run(true)).sessionsRetagged).toBe(0);
  });

  it("repo-name path extraction skips the skills ledgers but not the rest of skills", () => {
    expect(repoNamesInText(`${projects}/skills/handoff/pending/a.md`, projects)).toEqual([]);
    expect(repoNamesInText(`${projects}/skills/journal/PROGRESS_JOURNAL.md`, projects)).toEqual([]);
    expect(repoNamesInText(`${projects}/skills/memd-feedback/SKILL.md`, projects)).toEqual(["skills"]);
    expect(repoNamesInText("cd ~/Projects/relay && ls", projects)).toEqual(["relay"]);
    expect(repoNamesInText("/x/.worktrees/review-pr40/y", projects)).toEqual([]);
    // Sentence punctuation is not part of the name ("FieldApp-ios." must not dilute FieldApp-ios).
    expect(repoNamesInText(`see ${projects}/FieldApp-ios. Then ${projects}/memd, and ${projects}/relay.`, projects)).toEqual(["FieldApp-ios", "memd", "relay"]);
    expect(repoNamesInText(`${projects}/skills/logs/work`, projects, { skipLedgers: false })).toEqual(["skills"]);
  });
});
