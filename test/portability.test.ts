import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** config is built at import, so each case reloads it under a controlled env. */
async function load(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    return { ...(await import("../src/config.js")), ...(await import("../src/indexer.js")) };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

afterEach(() => vi.resetModules());

describe("no machine-specific paths", () => {
  it("slugs a path the way Claude Code names transcript dirs", async () => {
    const { slugForPath } = await load({});
    expect(slugForPath("/home/bob/code")).toBe("-home-bob-code");
    expect(slugForPath("/Users/bob/.worktrees")).toBe("-Users-bob--worktrees");
    // every character that is not a letter or digit, as Claude Code does it
    expect(slugForPath("/home/john_doe/My Code (2)/a+b")).toBe("-home-john-doe-My-Code--2--a-b");
  });

  it("tags sessions under any MEMD_PROJECTS_ROOT with the repo dir name", async () => {
    const { projectFromDir } = await load({ MEMD_PROJECTS_ROOT: "/home/bob/code" });
    expect(projectFromDir("-home-bob-code-my-app")).toBe("my-app");
    expect(projectFromDir("-home-bob-code")).toBe("code");
    expect(projectFromDir("-Users-alice-Projects-atlas")).toBe("Users-alice-Projects-atlas");
  });

  it("an empty MEMD_WORKTREE_ROOT turns the worktree-seat mapping off", async () => {
    const { config, projectFromDir } = await load({ MEMD_WORKTREE_ROOT: "" });
    expect(config.worktreeRoot).toBeUndefined();
    expect(projectFromDir("-Users-alice--worktrees-atlas-executor")).toBe("Users-alice--worktrees-atlas-executor");
  });

  it("an empty MEMD_WORKTREE_SEATS turns it off too", async () => {
    const { projectFromDir } = await load({ MEMD_WORKTREE_SEATS: "" });
    expect(projectFromDir("-Users-alice--worktrees-atlas-executor")).toBe("Users-alice--worktrees-atlas-executor");
  });

  it("with nothing set, the projects root is ~/Projects", async () => {
    const { config } = await load({ MEMD_PROJECTS_ROOT: undefined });
    expect(config.projectsRoot).toBe(path.join(os.homedir(), "Projects"));
  });

  it("a trailing slash, a leading ~ or an empty value does not change the projects root", async () => {
    for (const root of ["/home/bob/code/", "/home/bob/code///"]) {
      const { config, projectFromDir } = await load({ MEMD_PROJECTS_ROOT: root });
      expect(config.projectsRoot).toBe("/home/bob/code");
      expect(projectFromDir("-home-bob-code-my-app")).toBe("my-app");
      expect(projectFromDir("-home-bob-code")).toBe("code");
    }
    expect((await load({ MEMD_PROJECTS_ROOT: "~/code" })).config.projectsRoot).toBe(path.join(os.homedir(), "code"));
    expect((await load({ MEMD_PROJECTS_ROOT: "" })).config.projectsRoot).toBe(path.join(os.homedir(), "Projects"));
  });

  it("an underscore in the home dir or a space in the root still matches Claude Code's dirs", async () => {
    let m = await load({ MEMD_PROJECTS_ROOT: "/home/john_doe/code", MEMD_WORKTREE_ROOT: "/home/john_doe/.work_trees" });
    expect(m.projectFromDir("-home-john-doe-code-app")).toBe("app");
    expect(m.projectFromDir("-home-john-doe-code")).toBe("code");
    expect(m.projectFromDir("-home-john-doe--work-trees-app-executor")).toBe("app");
    m = await load({ MEMD_PROJECTS_ROOT: "/Users/jo/My Projects" });
    expect(m.projectFromDir("-Users-jo-My-Projects-app")).toBe("app");
    expect(m.projectFromDir("-Users-jo-My-Projects")).toBe("My Projects");
  });

  it("a root with dots, dashes and regex characters is matched literally", async () => {
    const root = "/srv/a.b-c/My (Code)+[1]";
    const env = { MEMD_PROJECTS_ROOT: root, MEMD_WORKTREE_ROOT: "/srv/w.t+(x)" };
    const { projectFromDir, slugForPath } = await load(env);
    // the transcript dirs Claude Code makes for sessions under those roots
    expect(projectFromDir("-srv-a-b-c-My--Code---1--app")).toBe("app");
    expect(projectFromDir("-srv-a-b-c-My--Code---1-")).toBe("My (Code)+[1]");
    expect(projectFromDir("-srv-w-t--x--app-executor")).toBe("app");
    // a different root whose slug merely looks similar is not this one
    expect(projectFromDir("-srv-aXb-c-My--Code---1--app")).toBe("srv-aXb-c-My--Code---1--app");

    const saved = { ...process.env };
    Object.assign(process.env, env);
    vi.resetModules();
    try {
      const { projectForDoc } = await import("../src/docs.js");
      const { repoNamesInText } = await import("../src/migrate-store.js");
      expect(projectForDoc(root + "/app/CONTEXT.md")).toBe("app");
      expect(projectForDoc("/srv/aXb-c/My (Code)+[1]/app/CONTEXT.md")).toBe("docs");
      expect(repoNamesInText("ran in /srv/w.t+(x)/app-executor/src and /srv/wXt+(x)/other-executor", root)).toEqual(["app"]);
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("seat suffixes come from MEMD_WORKTREE_SEATS", async () => {
    const { projectFromDir } = await load({ MEMD_WORKTREE_ROOT: "/wt", MEMD_WORKTREE_SEATS: "builder,reviewer" });
    expect(projectFromDir("-wt-atlas-builder")).toBe("atlas");
    expect(projectFromDir("-wt-atlas-executor")).toBe("wt-atlas-executor");
    expect(projectFromDir("-wt-builder")).toBe("wt-builder"); // a bare seat name is not a repo
  });

  /** migrate-store builds its patterns at import too, so it is loaded under the same env. */
  async function names(env: Record<string, string | undefined>, text: string, root: string): Promise<string[]> {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
    try {
      return (await import("../src/migrate-store.js")).repoNamesInText(text, root);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("with nothing configured, backfill-projects treats no directory and no dir suffix specially", async () => {
    const off = { MEMD_WORKTREE_ROOT: "/wt", MEMD_WORKTREE_SEATS: "", MEMD_BACKFILL_SEATS: "", MEMD_BACKFILL_LEDGER_DIRS: "" };
    const { config } = await load(off);
    expect(config.backfillSeats).toEqual([]);
    expect(config.backfillLedgerDirs).toEqual([]);
    for (const dir of ["handoff", "journal", "logs"]) {
      expect(await names(off, `/r/skills/${dir}/a.md`, "/r")).toEqual(["skills"]);
    }
    for (const seat of ["advisor", "executor", "consultant", "live", "review", "review2"]) {
      expect(await names(off, `ran in /wt/app-${seat}/src`, "/r")).toEqual([]);
    }
  });

  it("backfill-projects takes its ledger dirs and its extra seats from config", async () => {
    const env = { MEMD_WORKTREE_ROOT: "/wt", MEMD_WORKTREE_SEATS: "builder", MEMD_BACKFILL_SEATS: "scout,a.b", MEMD_BACKFILL_LEDGER_DIRS: "notes/inbox, /wiki/log/" };
    expect(await names(env, "/r/notes/inbox/a.md /r/wiki/log/b.md", "/r")).toEqual([]);
    // only the named pair: the rest of that repo, and the same dir in another repo, still count
    expect(await names(env, "/r/notes/other/a.md /r/app/inbox/a.md /r/skills/handoff/a.md", "/r")).toEqual(["notes", "app", "skills"]);
    // seats from both lists, with or without a number; a name is matched literally
    expect(await names(env, "/wt/app-builder /wt/web-scout3 /wt/api-a.b /wt/x-aXb /wt/y-executor", "/r")).toEqual(["app", "web", "api"]);
  });
});

describe("test isolation (test/setup/throwaway-home.ts)", () => {
  it("runs under a throwaway HOME and store, never a real ~/.claude", async () => {
    const { config } = await load({});
    expect(os.homedir()).toContain("memd-test-home-");
    expect(config.dbPath.startsWith(os.homedir() + path.sep)).toBe(true);
    expect(config.transcriptsRoot.startsWith(os.homedir() + path.sep)).toBe(true);
  });
});
