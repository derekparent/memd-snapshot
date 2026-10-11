import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreBrief } from "../src/checkpoint.js";
import { indexCodexCorpus } from "../src/codex.js";
import { config } from "../src/config.js";
import { openDb, DB } from "../src/db.js";
import { projectForCwd } from "../src/indexer.js";

/**
 * Claude transcripts are tagged with the git repo a session worked in
 * (origin name), but Codex rollouts and checkpoint restore used
 * path.basename(cwd). A worktree named "memd-executor" of repo "memd" got
 * two names, so its Codex sessions filtered apart from its Claude ones and a
 * dead session's brief never reached the next session in the same repo.
 */
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

let root: string;
let db: DB;
let savedCodexRoot: string;
let worktree: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-pid-")));
  db = openDb(path.join(root, "t.db"));
  savedCodexRoot = config.codexRoot;
  // A repo whose origin names it "widget", checked out in a directory called "widget-executor".
  const repo = path.join(root, "src-repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", "git@github.com:example/widget.git");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  fs.writeFileSync(path.join(repo, "f.txt"), "x");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  worktree = path.join(root, "widget-executor");
  git(repo, "worktree", "add", "-q", "-b", "seat/executor", worktree);
});
afterEach(() => {
  config.codexRoot = savedCodexRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("projectForCwd", () => {
  it("names a checkout by its git origin, whatever the directory is called", () => {
    expect(projectForCwd(worktree)).toBe("widget");
  });
  it("falls back to Claude Code's own dir-naming rule when git cannot answer", () => {
    // Claude Code writes the transcripts of cwd "/tmp/memd_q t/pro.j" to the dir
    // "-tmp-memd-q-t-pro-j": every non-alphanumeric character becomes "-".
    expect(projectForCwd("/tmp/memd_q t/pro.j")).toBe("tmp-memd-q-t-pro-j");
    expect(projectForCwd("/tmp/a~b@c")).toBe("tmp-a-b-c");
  });
});

describe("Codex rollouts", () => {
  it("are tagged with the git repo, like Claude sessions, not the directory basename", async () => {
    const codex = path.join(root, "codex", "2026", "09", "25");
    fs.mkdirSync(codex, { recursive: true });
    const lines = [
      { type: "session_meta", timestamp: "2026-09-25T00:00:00Z", payload: { id: "cx1", cwd: worktree } },
      { type: "response_item", timestamp: "2026-09-25T00:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "please refactor the widget parser" }] } },
    ];
    fs.writeFileSync(path.join(codex, "rollout-cx1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    config.codexRoot = path.join(root, "codex");
    await indexCodexCorpus(db);
    const projects = (db.prepare("SELECT DISTINCT project FROM episodes WHERE source = 'codex'").all() as { project: string }[]).map((r) => r.project);
    expect(projects).toEqual(["widget"]);
  });
});

describe("checkpoint restore", () => {
  const orphan = (project: string, brief: string) =>
    db.prepare(`INSERT INTO checkpoints (session_id, project, created_at, trigger, brief) VALUES ('dead', ?, ?, 'precompact', ?)`).run(project, new Date(Date.now() - 3600_000).toISOString(), brief);

  it("finds an orphan written under the repo name from a worktree cwd", () => {
    orphan("widget", "REPO-NAMED BRIEF");
    expect(restoreBrief(db, { session_id: "new", cwd: worktree } as any)).toContain("REPO-NAMED BRIEF");
  });

  it("still finds an orphan written under the OLD basename naming", () => {
    orphan("widget-executor", "BASENAME-NAMED BRIEF");
    expect(restoreBrief(db, { session_id: "new", cwd: worktree } as any)).toContain("BASENAME-NAMED BRIEF");
  });

  it("appends the repo's facts, found under the canonical name", () => {
    orphan("widget", "BRIEF");
    db.prepare(`INSERT INTO facts (content, project, kind, importance, valid_from, created_at) VALUES ('widget ruling zq', 'widget', 'ruling', 9, 'x', 'x')`).run();
    expect(restoreBrief(db, { session_id: "new", cwd: worktree } as any)).toContain("widget ruling zq");
  });
});
