import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cwdForTranscriptDir,
  projectForTranscriptDir,
  projectFromDir,
  repoForCwd,
  repoFromOriginUrl,
} from "../src/indexer.js";

/**
 * Repo resolution uses real git, so these tests use real repos in a temp dir rather than
 * mocking execFileSync — a mock would assert our own assumptions about git's
 * behavior, which is the thing under test.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memd-md5-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function makeRepo(name: string, originUrl: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", originUrl);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  fs.writeFileSync(path.join(dir, "f.txt"), "x");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** A transcript dir holding one .jsonl whose first line records `cwd`. */
function makeTranscriptDir(slug: string, cwd: string | null): string {
  const dir = path.join(tmpRoot, "transcripts", slug);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    type: "user",
    uuid: "u1",
    ...(cwd ? { cwd } : {}),
    message: { role: "user", content: "hello" },
  });
  fs.writeFileSync(path.join(dir, "sess.jsonl"), line + "\n");
  return dir;
}

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("repoFromOriginUrl", () => {
  it("parses ssh, https, and bare-path origins to the same name", () => {
    expect(repoFromOriginUrl("git@github.com:example-user/memd.git")).toBe("memd");
    expect(repoFromOriginUrl("https://github.com/example-user/memd.git")).toBe("memd");
    expect(repoFromOriginUrl("https://github.com/example-user/memd")).toBe("memd");
    expect(repoFromOriginUrl("/Users/alice/mirrors/memd")).toBe("memd");
    expect(repoFromOriginUrl("file:///srv/git/memd.git")).toBe("memd");
  });

  it("keeps hyphenated repo names intact", () => {
    expect(repoFromOriginUrl("git@github.com:example-user/homebase.git")).toBe("homebase");
    expect(repoFromOriginUrl("git@github.com:example-user/FieldApp-ios.git")).toBe("FieldApp-ios");
  });

  it("tolerates trailing slashes and rejects empty input", () => {
    expect(repoFromOriginUrl("https://github.com/example-user/memd/")).toBe("memd");
    expect(repoFromOriginUrl("   ")).toBeUndefined();
  });
});

describe("repoForCwd", () => {
  it("resolves a canonical repo from its origin", () => {
    const repo = makeRepo("memd-canonical", "git@github.com:example-user/memd.git");
    expect(repoForCwd(repo)).toBe("memd");
  });

  it("resolves a git worktree to the SAME repo as its parent", () => {
    const repo = makeRepo("memd-parent", "git@github.com:example-user/memd.git");
    const wt = path.join(tmpRoot, "wt", "memd-executor");
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "seat/executor", wt);
    expect(repoForCwd(wt)).toBe("memd");
    expect(repoForCwd(wt)).toBe(repoForCwd(repo));
  });

  it("returns undefined for a git repo with no origin", () => {
    const dir = path.join(tmpRoot, "no-origin");
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    expect(repoForCwd(dir)).toBeUndefined();
  });

  it("returns undefined for a plain directory that is not a repo", () => {
    const dir = path.join(tmpRoot, "not-a-repo");
    fs.mkdirSync(dir, { recursive: true });
    expect(repoForCwd(dir)).toBeUndefined();
  });
});

describe("cwdForTranscriptDir", () => {
  it("reads the cwd recorded on a transcript line", () => {
    const dir = makeTranscriptDir("-Users-alice-Projects-memd", "/Users/alice/Projects/memd");
    expect(cwdForTranscriptDir(dir)).toBe("/Users/alice/Projects/memd");
  });

  it("returns undefined when no line carries a cwd", () => {
    const dir = makeTranscriptDir("-no-cwd", null);
    expect(cwdForTranscriptDir(dir)).toBeUndefined();
  });

  it("returns undefined for a missing directory", () => {
    expect(cwdForTranscriptDir(path.join(tmpRoot, "does-not-exist"))).toBeUndefined();
  });
});

describe("projectForTranscriptDir", () => {
  it("prefers the git-resolved repo over the slug", () => {
    const repo = makeRepo("weird-checkout-name", "git@github.com:example-user/memd.git");
    const dir = makeTranscriptDir("-Users-alice-scratch-weird-checkout-name", repo);
    // The slug says "scratch-weird-checkout-name"; git says memd. git wins.
    expect(projectForTranscriptDir(dir, "-Users-alice-scratch-weird-checkout-name")).toBe("memd");
  });

  it("resolves a relay worktree slug through git, not the regex", () => {
    const repo = makeRepo("md5-parent", "git@github.com:example-user/atlas.git");
    const wt = path.join(tmpRoot, "wt", "atlas-advisor");
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "seat/advisor", wt);
    const dir = makeTranscriptDir("-Users-alice--worktrees-atlas-advisor", wt);
    expect(projectForTranscriptDir(dir, "-Users-alice--worktrees-atlas-advisor")).toBe("atlas");
  });

  it("falls back to the slug when the cwd is not a git repo", () => {
    const plain = path.join(tmpRoot, "plain-cwd");
    fs.mkdirSync(plain, { recursive: true });
    const dir = makeTranscriptDir("-Users-alice-Projects-homebase", plain);
    expect(projectForTranscriptDir(dir, "-Users-alice-Projects-homebase")).toBe("homebase");
  });

  it("falls back to the slug when the recorded cwd no longer exists", () => {
    const dir = makeTranscriptDir("-Users-alice-Projects-billing-api", "/Users/alice/Projects/deleted-long-ago");
    expect(projectForTranscriptDir(dir, "-Users-alice-Projects-billing-api")).toBe("billing-api");
  });

  it("falls back to the slug when no cwd was recorded at all", () => {
    const dir = makeTranscriptDir("-Users-alice--worktrees-atlas-executor", null);
    expect(projectForTranscriptDir(dir, "-Users-alice--worktrees-atlas-executor")).toBe("atlas");
  });
});

describe("projectFromDir still handles every slug-only case", () => {
  it("keeps the worktree regex", () => {
    expect(projectFromDir("-Users-alice--worktrees-atlas-executor")).toBe("atlas");
    expect(projectFromDir("-Users-alice--worktrees-FieldApp-ios-advisor")).toBe("FieldApp-ios");
  });

  it("keeps normal project slugs", () => {
    expect(projectFromDir("-Users-alice-Projects-homebase")).toBe("homebase");
    expect(projectFromDir("-Users-alice-Projects")).toBe("Projects");
  });
});
